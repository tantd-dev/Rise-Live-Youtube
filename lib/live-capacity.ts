// RISE LIVE — Dự phòng nhiều VPS · ĐỢT 1 (thuần cộng thêm, CHỈ TÍNH TOÁN — không ghi, không đụng
// engine). Tính sức chứa từng máy + đánh giá N+1 cho cả cụm: "mất bất kỳ 1 máy thì cụm có gánh
// nổi không". Dùng cho bảng hiển thị CHỈ ĐỌC. Thiết kế R0 (Google Doc reviewed 2026-08-18).
//
// Nguyên tắc (đã chốt):
// - Ngưỡng BÌNH THƯỜNG mặc định 70%, ngưỡng KHẨN CẤP 85% (cấu hình được theo máy: normalSafeLimit
//   / emergencyLimit, đơn vị 0..1).
// - Ưu tiên số đo THỜI GIAN THỰC (txMbps). Chưa có mới ước lượng theo băng thông mỗi luồng.
// - N+1 KHÔNG xác định bằng số lượng máy — mô phỏng mất từng máy rồi thử xếp lại luồng của nó.
// - Hai mức đánh giá: (a) FULL = xếp MỌI luồng của máy mất sang máy khác trong ngưỡng BÌNH THƯỜNG
//   (N+1 thật); (b) ƯU TIÊN = xếp riêng luồng ưu tiên trong ngưỡng KHẨN CẤP (mức tối thiểu phải đạt).

export const DEFAULT_NORMAL_LIMIT = 0.70;     // ngưỡng vận hành bình thường
export const DEFAULT_EMERGENCY_LIMIT = 0.85;  // ngưỡng khẩn cấp (chốt 2026-08-18)

export interface CapMachineInput {
  id: string;
  name?: string;
  online?: boolean;
  role?: string;
  maintenance?: boolean;
  uploadMbps?: number;            // băng thông tối đa (đo/nhập)
  txMbps?: number | null;         // băng thông THỰC thời gian thực (nếu worker báo)
  normalSafeLimit?: number;       // 0..1, mặc định 0.70
  emergencyLimit?: number;        // 0..1, mặc định 0.85
  reservedFailoverMbps?: number;  // băng thông chừa riêng để nhận luồng cứu
  // BĂNG THÔNG ĐÃ HỨA nhưng CHƯA hiện trong txMbps (luồng vừa được phân về máy này trong cùng lượt
  // cứu, chưa kịp chạy nên chưa đo được).
  //
  // Vì sao BẮT BUỘC phải có (phát hiện 27/08/2026): trước đây mỗi luồng tính chỗ trống trên CÙNG một
  // ảnh chụp dữ liệu và KHÔNG cập nhật sau mỗi lần chuyển. Nên khi 1 máy chết, CẢ 52 luồng của nó
  // đều thấy cùng một máy "thoáng nhất" -> cùng dồn về đó -> máy đó sập theo. Mất 1 máy thành mất 2.
  // Cộng pendingMbps vào phần đã dùng khiến luồng kế tiếp nhìn thấy bức tranh ĐÃ CẬP NHẬT, nên tự
  // động rải ra nhiều máy — đúng yêu cầu "phân bổ vào nhiều VPS" của Chủ Rise Group.
  pendingMbps?: number;
  provider?: string;              // nhà cung cấp (để né cùng điểm chết)
  region?: string;
  failureDomain?: string;
}

export interface CapStreamInput {
  id: string;
  machineId?: string;
  presetId?: string;
  importance?: string;            // normal | priority | critical (chưa gán -> coi normal)
  desiredState?: string;
  control?: string;
  scheduleActive?: boolean;
}

export interface MachineCapacity {
  machineId: string;
  name: string;
  online: boolean;
  role: string;
  maintenance: boolean;
  maxMbps: number;
  usedMbps: number;
  usedIsReal: boolean;            // true nếu lấy từ txMbps (thực), false nếu ước lượng
  normalLimitPct: number;
  emergencyLimitPct: number;
  reservedFailoverMbps: number;
  normalCapMbps: number;
  emergencyCapMbps: number;
  normalHeadroomMbps: number;     // chỗ còn cho luồng MỚI (đã trừ dự phòng)
  emergencyHeadroomMbps: number;  // chỗ còn khi NHẬN luồng cứu (tới ngưỡng khẩn cấp)
  loadPct: number;                // used / max (0..1+)
  streamCount: number;
  priorityStreamCount: number;
  provider: string;
  region: string;
  failureDomain: string;
}

export interface LossSim {
  lostMachineId: string;
  lostMachineName: string;
  movedMbps: number;              // tổng băng thông luồng phải chuyển đi
  priorityMbps: number;           // trong đó của luồng ưu tiên
  fullAbsorbable: boolean;        // xếp hết MỌI luồng (ngưỡng bình thường)?
  fullShortfallMbps: number;
  priorityAbsorbable: boolean;    // xếp hết luồng ƯU TIÊN (ngưỡng khẩn cấp)?
  priorityShortfallMbps: number;
  suggestedTargetName: string | null;  // máy ĐỀ XUẤT nhận luồng cứu (chỉ gợi ý)
  suggestedTargetReason: string;       // lý do chọn (để người xem hiểu)
}

// Chọn máy ĐỀ XUẤT nhận luồng khi 1 máy chết: đủ chỗ khẩn cấp; ƯU TIÊN khác vùng lỗi (an toàn
// hơn) rồi tới còn nhiều băng thông + đúng vai trò. Chỉ gợi ý — người/hệ thống vẫn quyết sau.
function pickTarget(lost: MachineCapacity, others: MachineCapacity[], needMbps: number): { name: string | null; reason: string } {
  const fit = others.filter((c) => c.emergencyHeadroomMbps >= needMbps && needMbps > 0);
  const pool = (fit.length ? fit : others).filter((c) => c.emergencyHeadroomMbps > 0);
  if (!pool.length) return { name: null, reason: "Không máy nào đủ chỗ khẩn cấp" };
  // MUC DO DOC LAP 3 bac (xem lib/live-move.ts): 2 = khac nha cung cap ·
  // 1 = cung nha cung cap nhung KHAC KHU VUC · 0 = chet chung.
  // So sanh bo qua hoa/thuong: du lieu that co ca "Lowendviet" lan "lowendviet".
  const chuanFD = (v: string) => String(v ?? "").trim().toLowerCase();
  const docLapCua = (c: MachineCapacity): number => {
    const khacNCC = !!c.failureDomain && !!lost.failureDomain && chuanFD(c.failureDomain) !== chuanFD(lost.failureDomain);
    if (khacNCC) return 2;
    const khacKV = !!c.region && !!lost.region && chuanFD(c.region) !== chuanFD(lost.region);
    return khacKV ? 1 : 0;
  };
  const diffFD = (c: MachineCapacity) => docLapCua(c) > 0;
  const roleOk = (c: MachineCapacity) => !c.role || !lost.role || c.role === lost.role || c.role === "shared";
  const best = [...pool].sort((a, b) =>
    (docLapCua(b) - docLapCua(a)) ||
    (Number(roleOk(b)) - Number(roleOk(a))) ||
    (b.emergencyHeadroomMbps - a.emergencyHeadroomMbps))[0];
  const bits: string[] = [`còn ${best.emergencyHeadroomMbps} Mbps khẩn cấp`];
  bits.push(diffFD(best) ? "khác nhà cung cấp (an toàn hơn)" : "⚠ cùng nhà cung cấp với máy hỏng");
  if (best.emergencyHeadroomMbps < needMbps) bits.push("nhưng CHƯA đủ chỗ — cần thêm máy");
  return { name: best.name, reason: bits.join(" · ") };
}

export interface ClusterCapacity {
  machines: MachineCapacity[];
  onlineCount: number;
  machinesTotal: number;
  totalMaxMbps: number;
  totalUsedMbps: number;
  clusterLoadPct: number;
  losses: LossSim[];
  nPlusOneFull: boolean;          // mất BẤT KỲ 1 máy vẫn xếp hết mọi luồng (N+1 thật)
  nPlusOnePriority: boolean;      // mất BẤT KỲ 1 máy vẫn cứu được mọi luồng ưu tiên
  worstFullMachineId: string | null;
}

const clamp01 = (n: number, dflt: number) => (typeof n === "number" && n > 0 && n <= 1 ? n : dflt);
const isActive = (s: CapStreamInput) => s.desiredState === "live" || (s.control === "schedule" && s.scheduleActive === true);
// Ưu tiên = importance mới (priority/critical); nếu CHƯA đặt importance thì tôn trọng cờ "kênh ưu
// tiên" (priority=true) cũ. Để dữ liệu cũ tự động được coi là ưu tiên.
const isPriority = (s: CapStreamInput) => s.importance === "priority" || s.importance === "critical" || (s.importance == null && (s as any).priority === true);

// Băng thông 1 luồng: tra theo presetId (Mbps). Không rõ -> 0 (bỏ qua trong ước lượng).
function bwOf(s: CapStreamInput, presetMbps: Record<string, number>): number {
  return Number(presetMbps[String(s.presetId ?? "")] ?? 0) || 0;
}

export function computeMachineCapacity(
  m: CapMachineInput,
  streams: CapStreamInput[],
  presetMbps: Record<string, number>,
): MachineCapacity {
  const mine = streams.filter((s) => s.machineId === m.id && isActive(s));
  const maxMbps = Number(m.uploadMbps) || 0;
  const estUsed = mine.reduce((sum, s) => sum + bwOf(s, presetMbps), 0);
  const usedIsReal = m.txMbps != null && Number.isFinite(Number(m.txMbps));
  const pendingMbps = Math.max(0, Number(m.pendingMbps) || 0);
  const usedMbps = (usedIsReal ? Number(m.txMbps) : estUsed) + pendingMbps;
  const normalLimitPct = clamp01(Number(m.normalSafeLimit), DEFAULT_NORMAL_LIMIT);
  const emergencyLimitPct = clamp01(Number(m.emergencyLimit), DEFAULT_EMERGENCY_LIMIT);
  const reservedFailoverMbps = Math.max(0, Number(m.reservedFailoverMbps) || 0);
  const normalCapMbps = maxMbps * normalLimitPct;
  const emergencyCapMbps = maxMbps * emergencyLimitPct;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    machineId: m.id,
    name: String(m.name ?? "Máy"),
    online: m.online === true,
    role: String(m.role ?? ""),
    maintenance: m.maintenance === true,
    maxMbps: r2(maxMbps),
    usedMbps: r2(usedMbps),
    usedIsReal,
    normalLimitPct,
    emergencyLimitPct,
    reservedFailoverMbps: r2(reservedFailoverMbps),
    normalCapMbps: r2(normalCapMbps),
    emergencyCapMbps: r2(emergencyCapMbps),
    normalHeadroomMbps: r2(Math.max(0, normalCapMbps - reservedFailoverMbps - usedMbps)),
    emergencyHeadroomMbps: r2(Math.max(0, emergencyCapMbps - usedMbps)),
    loadPct: maxMbps > 0 ? Math.round((usedMbps / maxMbps) * 1000) / 1000 : 0,
    streamCount: mine.length,
    priorityStreamCount: mine.filter(isPriority).length,
    provider: String(m.provider ?? ""),
    region: String(m.region ?? ""),
    failureDomain: String(m.failureDomain ?? m.provider ?? ""),
  };
}

// Xếp các "gói băng thông" (mỗi luồng 1 gói) vào các máy còn chỗ, theo kiểu tham lam: gói lớn
// trước, chọn máy còn NHIỀU chỗ nhất mà đủ chứa. Trả về phần KHÔNG xếp được (shortfall Mbps).
function packShortfall(loads: number[], headrooms: number[]): number {
  const cap = [...headrooms];
  const items = [...loads].filter((x) => x > 0).sort((a, b) => b - a);
  let short = 0;
  for (const it of items) {
    let best = -1;
    for (let i = 0; i < cap.length; i++) if (cap[i] >= it && (best < 0 || cap[i] > cap[best])) best = i;
    if (best < 0) short += it; else cap[best] -= it;
  }
  return Math.round(short * 100) / 100;
}

export function computeClusterCapacity(
  machinesIn: CapMachineInput[],
  streams: CapStreamInput[],
  presetMbps: Record<string, number>,
): ClusterCapacity {
  const caps = machinesIn.map((m) => computeMachineCapacity(m, streams, presetMbps));
  const online = caps.filter((c) => c.online && !c.maintenance);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const totalMaxMbps = r2(online.reduce((s, c) => s + c.maxMbps, 0));
  const totalUsedMbps = r2(online.reduce((s, c) => s + c.usedMbps, 0));

  const losses: LossSim[] = online.map((lost) => {
    const others = online.filter((c) => c.machineId !== lost.machineId);
    const mine = streams.filter((s) => s.machineId === lost.machineId && isActive(s));
    const allLoads = mine.map((s) => bwOf(s, presetMbps));
    const priLoads = mine.filter(isPriority).map((s) => bwOf(s, presetMbps));
    const movedMbps = r2(allLoads.reduce((a, b) => a + b, 0));
    const priorityMbps = r2(priLoads.reduce((a, b) => a + b, 0));
    // FULL: xếp mọi luồng vào chỗ trống ngưỡng BÌNH THƯỜNG của máy khác.
    const fullShort = others.length ? packShortfall(allLoads, others.map((c) => c.normalHeadroomMbps)) : movedMbps;
    // ƯU TIÊN: xếp luồng ưu tiên vào chỗ trống ngưỡng KHẨN CẤP.
    const priShort = others.length ? packShortfall(priLoads, others.map((c) => c.emergencyHeadroomMbps)) : priorityMbps;
    // Máy đề xuất nhận (cứu luồng nặng nhất trước) — chỉ gợi ý.
    const biggest = Math.max(0, ...allLoads);
    const tgt = others.length ? pickTarget(lost, others, biggest) : { name: null, reason: "Không còn máy nào khác" };
    return {
      lostMachineId: lost.machineId, lostMachineName: lost.name,
      movedMbps, priorityMbps,
      fullAbsorbable: fullShort <= 0.001, fullShortfallMbps: fullShort,
      priorityAbsorbable: priShort <= 0.001, priorityShortfallMbps: priShort,
      suggestedTargetName: tgt.name, suggestedTargetReason: tgt.reason,
    };
  });

  const worstFull = losses.filter((l) => !l.fullAbsorbable).sort((a, b) => b.fullShortfallMbps - a.fullShortfallMbps)[0];
  return {
    machines: caps,
    onlineCount: online.length,
    machinesTotal: caps.length,
    totalMaxMbps, totalUsedMbps,
    clusterLoadPct: totalMaxMbps > 0 ? Math.round((totalUsedMbps / totalMaxMbps) * 1000) / 1000 : 0,
    losses,
    // N+1 chỉ có ý nghĩa khi CÓ máy để mất (≥2 online). 1 máy -> không thể N+1.
    nPlusOneFull: online.length >= 2 && losses.every((l) => l.fullAbsorbable),
    nPlusOnePriority: online.length >= 2 && losses.every((l) => l.priorityAbsorbable),
    worstFullMachineId: worstFull?.lostMachineId ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// QUỸ DỰ PHÒNG CỦA MỖI MÁY (Chủ Rise Group chốt 29/08/2026)
//
// Mô hình đúng — hai ngân sách TÁCH RIÊNG, không được lẫn:
//   · 70% băng thông  = quỹ CHẠY luồng của chính máy đó (mức an toàn đã chốt).
//   · 30% còn lại     = quỹ CỨU HỘ. Đây mới là chỗ tính sức chứa bản dự phòng.
//
// Nghĩa là: kể cả khi máy đã chạy KỊCH 70% công suất của nó, vẫn còn nguyên 30%
// để gánh những luồng mà nó đang giữ bản dự phòng. Nhờ vậy bản dự phòng KHÔNG
// tranh chỗ với luồng đang chạy, mà vẫn có trần rõ ràng để chia đều giữa các máy.
//
// Bản dự phòng KHÔNG tiêu băng thông lúc nằm im (nó chỉ là file). Nhưng nó là một
// LỜI HỨA: "máy nguồn chết thì tôi gánh luồng này". Phải tính lời hứa đó vào quỹ,
// nếu không thì mọi bản đều dồn về một máy và lúc cần thì máy đó không gánh nổi
// (đo thật 29/08: 30/48 bản nằm trên VPS 01 — đúng máy băng thông thấp nhất).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TỶ LỆ QUỸ CỨU HỘ — Chủ Rise Group chốt 29/08/2026: **50%** băng thông của máy.
 *
 * PHÉP CỘNG CẦN BIẾT: 70% (chạy luồng của chính nó) + 50% (cứu hộ) = 120% > trần máy.
 * Đây là ĐẶT QUÁ TAY CÓ CHỦ Ý, không phải sơ suất. Lý do chấp nhận được:
 *   · Thực tế cụm đang chạy 25–45%, không máy nào tới 70%.
 *   · Lúc cứu THẬT, hệ vẫn kiểm sức chứa lần nữa trước khi chuyển (preflight). Nên một bản
 *     dự phòng "có thể không vừa" vẫn hơn hẳn KHÔNG CÓ bản nào — file nằm sẵn, còn chỗ là
 *     chuyển được ngay. Đặt quá tay chỉ tốn ổ cứng, không cắt sóng ai.
 *   · Đặt quá chặt (30%) thì nhiều luồng ưu tiên không có bản dự phòng nào — tệ hơn nhiều.
 * Đổi được bằng biến môi trường RL_BACKUP_RESERVE (0.5 = 50%) nếu muốn siết lại.
 */
export function tyLeQuyDuPhong(): number {
  const raw = Number(process.env.RL_BACKUP_RESERVE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.5;
}

/** Quỹ cứu hộ của một máy (Mbps). */
export function quyDuPhongMbps(uploadMbps: unknown, tyLe = tyLeQuyDuPhong()): number {
  const up = Number(uploadMbps) || 0;
  return Math.max(0, Math.round(up * tyLe * 10) / 10);
}

/** Quỹ cứu hộ quy ra SỐ LUỒNG máy này đỡ được — để hiện cho người dùng dễ hình dung.
 *  LƯU Ý: số "bản" KHÔNG cố định — luồng "giữ nguyên gốc" ngốn ~23 Mbps, luồng 1080p ~6,6 Mbps.
 *  Hệ luôn tính theo Mbps thật, con số bản chỉ để dễ đọc. */
export function soBanDuPhongToiDa(uploadMbps: unknown, mbpsMoiLuong: number, tyLe = tyLeQuyDuPhong()): number {
  const per = Number(mbpsMoiLuong) || 0;
  if (per <= 0) return 0;
  return Math.floor(quyDuPhongMbps(uploadMbps, tyLe) / per);
}
