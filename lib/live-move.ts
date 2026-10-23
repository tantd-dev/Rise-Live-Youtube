// RISE LIVE — Dự phòng nhiều VPS · ĐỢT 3. Khung CHUYỂN LUỒNG dùng chung cho cả CHUYỂN CHỦ ĐỘNG
// (người bấm) lẫn CỨU KHẨN CẤP (hệ thống tự) — một bộ máy, hai chính sách kết thúc (thiết kế R0
// mục 3/5/6). Nhịp 1 ở đây CHỈ TÍNH TOÁN: chấm điểm + preflight máy đích, KHÔNG ghi, KHÔNG chuyển.
import { computeMachineCapacity, type CapMachineInput, type CapStreamInput } from "@/lib/live-capacity";
import { streamBackupStatus, type ReplicaAssetLike, type ReplicaMachineLike } from "@/lib/live-replica";

export type MoveMode = "planned" | "emergency";   // chủ động (ngưỡng bình thường) | khẩn cấp (ngưỡng khẩn cấp)

// CHUYEN LUONG THAT — sau cờ (mặc định TẮT). Chưa bật → action move_execute chặn; hành vi như cũ.
export const MOVE_FEATURE_ON = () => process.env.RISE_LIVE_MOVE === "1";
// Hạn tổng cho 1 lần chuyển; quá hạn mà chưa xong → HOÀN TÁC về máy nguồn. Mặc định 150s.
export const MOVE_TIMEOUT_SEC = (): number => {
  const n = Number(process.env.RISE_LIVE_MOVE_TIMEOUT_SEC);
  return Number.isFinite(n) && n >= 30 ? Math.round(n) : 150;
};
// Sau khi máy đích LÊN sóng, chờ YouTube xác nhận nhận lại tín hiệu (nếu kênh có nối L3) trước khi
// báo "xong". Quá ân hạn này mà chưa xác nhận được (không có L3 / YouTube chậm) thì vẫn chốt xong
// (đích ĐANG phát). Cấu hình RISE_LIVE_VERIFY_SEC; mặc định 60s.
export const VERIFY_GRACE_SEC = (): number => { const n = Number(process.env.RISE_LIVE_VERIFY_SEC); return Number.isFinite(n) && n >= 20 ? Math.round(n) : 60; };

// Các trạng thái "đang chuyển" (khoá thao tác khác trên luồng khi đang chuyển).
// copying_video = đang CHỜ copy video sang máy đích (luồng VẪN phát ở máy nguồn, chưa cắt sóng);
// khi bản sao sẵn sàng, cron chuyển sang stopping_source (bắt đầu bàn giao 2 pha).
export const MOVE_ACTIVE_STATES = ["copying_video", "stopping_source", "starting_target", "verifying"] as const;
// Hạn tối đa chờ COPY video sang máy đích (quá hạn mà chưa sẵn sàng → huỷ chuyển). Mặc định 30 phút.
export const COPY_WAIT_SEC = (): number => { const n = Number(process.env.RISE_LIVE_COPY_WAIT_SEC); return Number.isFinite(n) && n >= 120 ? Math.round(n) : 1800; };
export const isMoveActive = (moveState: any): boolean => (MOVE_ACTIVE_STATES as readonly string[]).includes(String(moveState ?? ""));

export interface MoveCandidate {
  machineId: string;
  name: string;
  eligible: boolean;
  score: number;
  reasons: string[];     // điểm cộng (vì sao nên chọn)
  blockers: string[];    // vì sao KHÔNG dùng được (nếu eligible=false)
  hasVideo: boolean;     // đã có video sẵn sàng của luồng chưa
  headroomMbps: number;  // chỗ còn (theo ngưỡng của chế độ)
  differentFailureDomain: boolean;   // KHAC nha cung cap (muc doc lap cao nhat)
  docLap?: 0 | 1 | 2;                // 2 khac NCC · 1 cung NCC khac khu vuc · 0 chet chung
}

export interface MovePreflight {
  streamId: string;
  sourceMachineId: string;
  streamBwMbps: number;
  mode: MoveMode;
  candidates: MoveCandidate[];     // đã xếp hạng: tốt nhất trước
  best: MoveCandidate | null;      // ứng viên đề xuất (eligible tốt nhất)
}

const isActive = (s: CapStreamInput) => s.desiredState === "live" || (s.control === "schedule" && (s as any).scheduleActive === true);
// Vai trò máy 24/7 và Live Pub thực tế HOÁN ĐỔI được (máy 24/7 vẫn phát Pub và ngược lại) — Chủ Rise
// xác nhận 2026-08-19. "shared" khớp mọi loại. Nhãn vai trò chỉ để GỢI Ý ưu tiên (cộng điểm cùng loại),
// KHÔNG chặn cứng — nhờ vậy luồng Pub vẫn có máy đích để chuyển/cứu khi cụm toàn máy 24/7.
const LIVE_ROLES = new Set(["stream-247", "live-pub"]);
const roleMatch = (mRole: string, mode: string) => !mode || !mRole || mRole === mode || mRole === "shared" || (LIVE_ROLES.has(mRole) && LIVE_ROLES.has(mode));
const BLOCKING_STATES = new Set(["maintenance", "draining", "disabled", "recovering"]);

// Băng thông luồng (Mbps) theo presetId.
function streamBw(stream: any, presetMbps: Record<string, number>): number {
  return Number(presetMbps[String(stream?.presetId ?? "")] ?? 0) || 0;
}

// Máy đích có bản sao SẴN SÀNG của MỌI video luồng cần chưa? Khớp bản sao trên máy đích bằng:
//  • copyFromAssetId === id asset nguồn  (đúng cho CẢ video upload tay — không có sourceUrl), HOẶC
//  • cùng sourceUrl khác rỗng            (video từ Drive/link).
// (Trước đây chỉ khớp sourceUrl -> video upload tay không bao giờ nhận ra bản sao -> chuyển máy/failover treo.)
function machineHasStreamVideo(stream: any, machineId: string, assets: ReplicaAssetLike[]): boolean {
  const ids: string[] = Array.isArray(stream.assetIds) && stream.assetIds.length ? stream.assetIds : (stream.assetId ? [stream.assetId] : []);
  if (!ids.length) return false;
  return ids.every((aid) => {
    const src = assets.find((x) => x.id === aid);
    const url = String(src?.sourceUrl ?? "").trim();
    return assets.some((a) => String(a.machineId) === machineId && a.status === "ready"
      && (String((a as any).copyFromAssetId ?? "") === aid || (url !== "" && String(a.sourceUrl ?? "").trim() === url)));
  });
}

// Preflight + xếp hạng máy đích cho 1 luồng. Tự tính sức chứa + video + vùng lỗi.
export function moveTargetPreflight(
  stream: any,
  machinesIn: CapMachineInput[],
  streamsAll: CapStreamInput[],
  assets: ReplicaAssetLike[],
  presetMbps: Record<string, number>,
  mode: MoveMode,
): MovePreflight {
  const sourceMachineId = String(stream.machineId ?? "");
  const bw = streamBw(stream, presetMbps);
  const srcMachine: any = machinesIn.find((m) => m.id === sourceMachineId);
  const srcFd = String(srcMachine?.failureDomain ?? srcMachine?.provider ?? "");
  const mode2 = String(stream.mode ?? "");

  const candidates: MoveCandidate[] = machinesIn
    .filter((m) => m.id !== sourceMachineId)
    .map((m: any) => {
      const cap = computeMachineCapacity(m, streamsAll, presetMbps);
      const headroom = mode === "emergency" ? cap.emergencyHeadroomMbps : cap.normalHeadroomMbps;
      const hasVideo = machineHasStreamVideo(stream, m.id, assets);
      const fd = String(m.failureDomain ?? m.provider ?? "");
      // MUC DO DOC LAP — 3 bac (truoc day chi co/khong theo nha cung cap):
      //   2 = KHAC nha cung cap        -> an toan nhat
      //   1 = cung nha cung cap nhung KHAC KHU VUC -> van tranh duoc su co mot
      //       trung tam du lieu / mot vung mang (Chu Rise 28/08: khi khong tim
      //       duoc nha cung cap moi thi trai theo KHU VUC)
      //   0 = cung ca hai            -> chet chung
      // So sanh bo qua hoa/thuong + khoang trang: du lieu that co ca "Lowendviet"
      // lan "lowendviet" -> so cung chuoi se TUONG la hai nha cung cap khac nhau.
      const chuan = (v: string) => String(v ?? "").trim().toLowerCase();
      const srcReg = String(srcMachine?.region ?? "");
      const diffFd = !!fd && !!srcFd && chuan(fd) !== chuan(srcFd);
      const diffReg = !!m.region && !!srcReg && chuan(String(m.region)) !== chuan(srcReg);
      const docLap: 0 | 1 | 2 = diffFd ? 2 : diffReg ? 1 : 0;
      const blockers: string[] = [];
      if (!m.online) blockers.push("máy offline");
      if (BLOCKING_STATES.has(String(m.operationalState ?? "")) || m.maintenance) blockers.push(`đang ${m.maintenance ? "bảo trì" : m.operationalState}`);
      if (!roleMatch(String(m.role ?? ""), mode2)) blockers.push("sai vai trò/pool");
      if (bw > 0 && headroom < bw) blockers.push(`không đủ băng thông (còn ${headroom}, cần ${bw} Mbps)`);
      // ĐANG NGHẼN (đo THẬT, không phụ thuộc trần): nếu máy đích đang có ≥2 luồng TỤT tốc độ thì nó đang
      // quá tải / bị bóp băng thông thật -> KHÔNG dồn thêm luồng ưu tiên về đó (kẻo cùng giật). Đây là cái
      // chốt cho câu "lỡ nhà cung cấp bóp mà hệ vẫn đẩy luồng về đó": tụt luồng là bằng chứng thật, chặn ngay.
      const slowN = (streamsAll as any[]).filter((s) => String(s.machineId) === m.id && String(s.status) === "live" && s.slow).length;
      if (slowN >= 2) blockers.push(`máy đang nghẽn (${slowN} luồng tụt tốc độ)`);
      const eligible = blockers.length === 0;

      const reasons: string[] = [];
      if (hasVideo) reasons.push("đã có video sẵn sàng"); else reasons.push("cần copy video trước");
      if (docLap === 2) reasons.push("khác nhà cung cấp (an toàn nhất)");
      else if (docLap === 1) reasons.push("cùng nhà cung cấp nhưng KHÁC khu vực (an toàn hơn)");
      if (headroom > 0) reasons.push(`còn ${headroom} Mbps`);
      // Điểm: ưu tiên đủ điều kiện > có video > khác vùng lỗi > nhiều băng thông > ít lỗi gần đây.
      const score = (eligible ? 1000 : 0) + (hasVideo ? 300 : 0) + (docLap === 2 ? 200 : docLap === 1 ? 110 : 0)
        + Math.min(150, headroom) + (roleMatch(String(m.role ?? ""), mode2) && m.role === mode2 ? 40 : 0)
        - Math.min(100, (Number(m.reliabilityScore) ? (100 - Number(m.reliabilityScore)) : 0));
      return { machineId: m.id, name: cap.name, eligible, score, reasons, blockers, hasVideo, headroomMbps: headroom, differentFailureDomain: diffFd, docLap };
    })
    .sort((a, b) => b.score - a.score);

  const best = candidates.find((c) => c.eligible) ?? null;
  return { streamId: String(stream.id ?? ""), sourceMachineId, streamBwMbps: bw, mode, candidates, best };
}

// ÁNH XẠ assetId sang MÁY ĐÍCH: mỗi máy có bản ghi liveAssets RIÊNG (id khác) cho CÙNG 1 video
// (cùng sourceUrl). Khi chuyển luồng sang máy đích, phải đổi assetId/assetIds của luồng sang ĐÚNG
// id asset trên máy đích — nếu không worker máy đích không tra ra file. Trả về null nếu đích THIẾU
// bản sao sẵn sàng của bất kỳ video nào (không chuyển được).
export function remapAssetIdsToTarget(
  stream: any,
  targetMachineId: string,
  assets: ReplicaAssetLike[],
): string[] | null {
  const ids: string[] = Array.isArray(stream.assetIds) && stream.assetIds.length ? stream.assetIds : (stream.assetId ? [stream.assetId] : []);
  if (!ids.length) return null;
  const out: string[] = [];
  for (const aid of ids) {
    const src = assets.find((x) => x.id === aid);
    const url = String(src?.sourceUrl ?? "").trim();
    // Bản trên máy đích: khớp theo copyFromAssetId (video upload tay) HOẶC cùng sourceUrl (Drive) + sẵn sàng.
    const tgt = assets.find((x) => String(x.machineId) === targetMachineId && x.status === "ready"
      && (String((x as any).copyFromAssetId ?? "") === aid || (url !== "" && String(x.sourceUrl ?? "").trim() === url)));
    if (!tgt) return null;
    out.push(tgt.id);
  }
  return out;
}

// Preflight cho ĐÍCH đã chọn (kiểm tra kỹ trước khi chuyển). Trả về ready/warn/block + lý do.
export function checkMoveTarget(pf: MovePreflight, targetId: string): { level: "ready" | "warn" | "block"; messages: string[] } {
  const c = pf.candidates.find((x) => x.machineId === targetId);
  if (!c) return { level: "block", messages: ["Máy đích không hợp lệ."] };
  if (!c.eligible) return { level: "block", messages: c.blockers };
  const msgs: string[] = [];
  let level: "ready" | "warn" = "ready";
  if (!c.hasVideo) { level = "warn"; msgs.push("Máy đích CHƯA có video — cần copy sang trước khi chuyển (không cắt sóng cũ tới khi bản sao sẵn sàng)."); }
  if ((c.docLap ?? (c.differentFailureDomain ? 2 : 0)) === 0) { level = "warn"; msgs.push("Máy đích CÙNG nhà cung cấp VÀ cùng khu vực với máy nguồn — sự cố diện rộng là mất cả hai."); }
  else if ((c.docLap ?? 2) === 1) { msgs.push("Máy đích cùng nhà cung cấp nhưng KHÁC khu vực — tránh được sự cố một trung tâm dữ liệu, chưa tránh được sự cố toàn nhà cung cấp."); }
  return { level, messages: msgs.length ? msgs : ["Sẵn sàng chuyển."] };
}

export type { ReplicaMachineLike };
