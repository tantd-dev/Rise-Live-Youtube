// RISE LIVE — TỰ ĐỘNG CỨU KHẨN CẤP (endpoint chạy nền, Cloud Scheduler gọi ~mỗi 1 phút). Khi 1 máy
// CHẾT (mất heartbeat), tự chuyển các luồng ƯU TIÊN đặt "tự động chuyển" (failoverMode=automatic)
// sang máy đích phù hợp — DÙNG CHUNG khung bàn giao/agent với chuyển tay. Máy nguồn đã chết nên BỎ
// pha "dừng nguồn" (đi thẳng starting_target); an toàn chống phát trùng dựa vào "tự dừng khi cô lập"
// (RISE_LIVE_LEASE) ở worker máy nguồn nếu nó chỉ bị cô lập chứ chưa chết hẳn.
//
// SAU CỜ RISE_LIVE_AUTOFAILOVER (mặc định TẮT). Bảo vệ bằng x-cron-secret = REPORT_REMINDER_SECRET.
// Lịch (đặt 1 lần):
//   gcloud scheduler jobs create http rise-live-failover \
//     --schedule="*/1 * * * *" --uri="https://<DIA-CHI-MAY-CHU-CUA-BAN>/api/live/failover/run" \
//     --http-method=POST --headers="x-cron-secret=<REPORT_REMINDER_SECRET>" --location=asia-southeast1
import { NextResponse } from "next/server";
import { firestore } from "@/lib/firestore";
import { streamBandwidthMbps, LIVE_QUALITY_PRESETS, isWithinSchedule, nextScheduleStartMs, DEFAULT_SAFETY_FACTOR } from "@/lib/live-catalog";
import { quyDuPhongMbps } from "@/lib/live-capacity";
import { notifyOutcome } from "@/lib/notify";
import { logAudit } from "@/lib/audit";
import { moveTargetPreflight, checkMoveTarget, remapAssetIdsToTarget, MOVE_TIMEOUT_SEC, isMoveActive, MOVE_FEATURE_ON } from "@/lib/live-move";
import { xacMinhMayChet } from "@/lib/live-machine-probe";
import { getConnectionRefreshToken } from "@/lib/live-youtube-store";
import { accessTokenFromRefresh, fetchChannelLiveState } from "@/lib/live-youtube-sync";
import { extractYouTubeVideoId } from "@/lib/youtube-check";

// GIỚI HẠN ĐỌC — phải LỚN HƠN HẲN số bản ghi thật, và phải BÁO khi chạm trần.
// Vì sao (rà soát 29/08/2026): trần cũ 1.000 video. Ở 500 luồng ước ~735 video —
// dưới trần nhưng chỉ dư 1,36 lần; tăng tỉ lệ luồng ưu tiên là vượt. Vượt thì
// Firestore CẮT ÂM THẦM, không báo gì: máy quét thấy thiếu bản dự phòng → cảnh
// báo giả hàng loạt, và tệ hơn là TỪ CHỐI cứu luồng thật sự có dự phòng.
// ── NÚT TẮT KHẨN CƠ CHẾ TỰ CỨU (nghiệm thu R0 #11) ─────────────────────────
// Vì sao cần: cơ chế tự cứu chạy nền, tự chuyển luồng giữa các máy. Nếu nó chạy
// SAI (bug mới, đọc nhầm trạng thái, tình huống chỉ lộ ra ở quy mô lớn) thì thành
// "bão chuyển máy" — luồng bị dời đi dời lại, mỗi lần cắt sóng vài giây.
//
// Trước đây muốn dừng chỉ có 3 cách, cả 3 đều tệ: tắt lịch chạy trên Google Cloud
// (phải vào bảng điều khiển đám mây) · hạ mức ưu tiên từng luồng (chậm + mất cấu
// hình) · tắt cả dịch vụ (DỪNG LUÔN mọi luồng đang phát).
//
// Nút này chỉ dừng phần TỰ CHUYỂN. Luồng đang phát VẪN PHÁT, cảnh báo VẪN CHẠY,
// người vận hành xử lý tay rồi bật lại. Đọc từ Firestore nên bật/tắt được ngay
// từ giao diện, KHÔNG cần deploy lại.
async function tuCuuDangTat(): Promise<{ tat: boolean; boi?: string; luc?: string; lyDo?: string }> {
  // Cờ môi trường vẫn ưu tiên cao nhất — để tắt được cả khi Firestore có sự cố.
  if (process.env.RISE_LIVE_FAILOVER_OFF === "1") return { tat: true, boi: "biến môi trường" };
  const d = await firestore.collection("liveSettings").doc("failover").get().catch(() => null);
  const v: any = d?.exists ? d.data() : null;
  return v?.disabled === true
    ? { tat: true, boi: String(v.disabledBy ?? "—"), luc: String(v.disabledAt ?? ""), lyDo: String(v.reason ?? "") }
    : { tat: false };
}

const TRAN_DOC = { assets: 8000, streams: 8000, machines: 500 };
function canhBaoChamTran(ten: string, so: number, tran: number) {
  if (so >= tran) console.error(`[RISE LIVE] CHAM TRAN DOC ${ten}: ${so}/${tran} — danh sach CO THE bi cat, ket qua khong day du. Nang TRAN_DOC.`);
}

export const dynamic = "force-dynamic";
const M_COL = "liveMachines", A_COL = "liveAssets", S_COL = "liveStreams";
const nowISO = () => new Date().toISOString();
const AUTO_ON = () => process.env.RISE_LIVE_AUTOFAILOVER === "1";
// Máy coi là CHẾT khi mất heartbeat quá lâu (chặt hơn ngưỡng hiển thị 60s để tránh chuyển nhầm khi
// chỉ chớp mạng). Cấu hình RISE_LIVE_FAILOVER_OFFLINE_SEC; mặc định 90s.
const OFFLINE_SEC = (): number => { const n = Number(process.env.RISE_LIVE_FAILOVER_OFFLINE_SEC); return Number.isFinite(n) && n >= 60 ? Math.round(n) : 90; };
// YẾU KÉO DÀI (lỗi bộ phận, máy còn sống): thời gian luồng phải "đang yếu" (tính từ slowSince — mốc
// này đã sau 90s tốc độ<0.92) trước khi TỰ CHUYỂN. THẬN TRỌNG = để dài cho chắc. Mặc định 120s
// (=> tổng ~210s yếu liên tục). Cấu hình RISE_LIVE_DEGRADE_SEC.
const DEGRADE_SEC = (): number => { const n = Number(process.env.RISE_LIVE_DEGRADE_SEC); return Number.isFinite(n) && n >= 60 ? Math.round(n) : 120; };

export async function POST(request: Request) {
  try {
    // BẢO MẬT (S0): fail-CLOSED — thiếu secret hoặc sai header đều chặn (trước đây thiếu secret thì bỏ
    // qua kiểm tra → endpoint mở; đây là cron ĐIỀU KHIỂN luồng live/YouTube nên phải khoá chặt như 13 cron khác).
    const secret = process.env.REPORT_REMINDER_SECRET;
    if (!secret || request.headers.get("x-cron-secret") !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    // KHÔNG chặn sớm ở AUTO_ON: pass "copying_video" (chuyển TAY tự-copy) chạy theo cờ RISE_LIVE_MOVE,
    // độc lập với auto-failover. Các pass cứu tự động mới gate theo AUTO_ON (ở dưới).

    const [mSnap, aSnap, sSnap] = await Promise.all([
      firestore.collection(M_COL).limit(TRAN_DOC.machines).get().catch(() => null),
      firestore.collection(A_COL).limit(TRAN_DOC.assets).get().catch(() => null),
      firestore.collection(S_COL).limit(TRAN_DOC.streams).get().catch(() => null),
    ]);
    // Báo NGAY nếu chạm trần — quá trần thì danh sách bị cắt âm thầm, hệ sẽ TỪ CHỐI
    // cứu những luồng thật ra có bản dự phòng.
    canhBaoChamTran("liveAssets", aSnap?.size ?? 0, TRAN_DOC.assets);
    canhBaoChamTran("liveStreams", sSnap?.size ?? 0, TRAN_DOC.streams);
    canhBaoChamTran("liveMachines", mSnap?.size ?? 0, TRAN_DOC.machines);
    const nowMs = Date.now();
    // Nút tắt khẩn: dừng TỰ CHUYỂN ngay, KHÔNG đụng luồng đang phát.
    const congTac = await tuCuuDangTat();
    if (congTac.tat) {
      console.warn(`[RISE LIVE] TU CUU DANG TAT (boi ${congTac.boi}${congTac.lyDo ? ", ly do: " + congTac.lyDo : ""}) — bo qua luot nay.`);
      return NextResponse.json({ ok: true, skipped: "failover_off", disabledBy: congTac.boi ?? null, disabledAt: congTac.luc ?? null, reason: congTac.lyDo ?? null });
    }
    const offlineSec = OFFLINE_SEC();
    const machines = (mSnap?.docs ?? []).map((d) => { const m: any = { id: d.id, ...(d.data() as any) }; const age = m.lastHeartbeatAt ? (nowMs - Date.parse(m.lastHeartbeatAt)) / 1000 : 1e9; m.online = age < offlineSec && m.forceOffline !== true; return m; });
    const assets = (aSnap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) }));
    const streams = (sSnap?.docs ?? []).map((d) => { const s: any = { id: d.id, ...(d.data() as any) }; if (s.control === "schedule" && s.schedule) s.scheduleActive = isWithinSchedule(s.schedule, nowMs); return s; });
    // ƯU TIÊN HIỆU DỤNG: dùng importance MỚI; nếu chưa đặt thì suy từ cờ priority CŨ — KHỚP cách giao
    // diện hiển thị "⭐ Ưu tiên". Trước đây tự-cứu + auto-backup CHỈ xét importance → luồng cũ (priority
    // =true, importance chưa đặt) bị SÓT: hiện "Ưu tiên" nhưng không được tải dự phòng / tự cứu.
    // LOẠI luồng PUB: pub bật auto-stop nên sự cố là YouTube TỰ ĐÓNG buổi phát → dự phòng/tự cứu vô nghĩa
    // (buổi live kết thúc rồi). Chỉ 24/7 (treo chờ tín hiệu) mới cứu được. Pub luôn KHÔNG auto-backup/tự-cứu.
    const isPrio = (s: any) => { if (String(s.mode) === "live-pub") return false; const i = String(s.importance || (s.priority ? "priority" : "normal")); return i === "priority" || i === "critical"; };
    // XÁC MINH TRƯỚC KHI CHUYỂN LUỒNG (30/08/2026) — đây là chỗ ĐẮT NHẤT nếu kết luận nhầm: mỗi lần
    // chuyển cắt vài giây sóng THẬT. Ca VPS 05 ngày 30/08: máy im 72 giây vì một lượt gửi lạc đường
    // trong khi cả 28 luồng phát liên tục — nếu máy đó có luồng ưu tiên thì đã bị dời vô cớ (thoát
    // chỉ vì tình cờ không có luồng ưu tiên nào).
    // GIỮ NGUYÊN ngưỡng 60 giây theo yêu cầu Chủ Rise Group — không nới thời gian, chỉ THÊM một lần
    // gọi thẳng vào máy để chắc chắn. Máy trả lời → còn sống → KHÔNG chuyển. Không trả lời → chuyển
    // NGAY như cũ. Không kiểm chứng được (máy đối chứng cũng câm) → quay về đúng cách cũ.
    const nghiChet = machines.filter((m) => !m.online && m.forceOffline !== true);
    const xacMinh = nghiChet.length
      ? await xacMinhMayChet(nghiChet.map((m) => ({ id: m.id, ip: m.ip })), machines.filter((m) => m.online).map((m) => ({ id: m.id, ip: m.ip })))
      : null;
    if (xacMinh) console.log("[live-failover] xac minh may:", xacMinh.lyDo, "chet=", xacMinh.chet.size, "song=", xacMinh.songNhungKhongGoiVe.size, "tin duoc=", xacMinh.tinDuoc);
    const deadIds = new Set(
      machines.filter((m) => {
        if (m.online) return false;                                                    // vẫn báo về bình thường
        if (m.forceOffline === true) return true;                                      // người vận hành CHỦ ĐỘNG ngắt → cứu là đúng ý
        if (xacMinh?.tinDuoc && xacMinh.songNhungKhongGoiVe.has(m.id)) return false;    // gọi vào VẪN trả lời → còn sống, KHÔNG chuyển
        return true;                                                                   // im + gọi vào không ai trả lời (hoặc không kiểm chứng được) → cứu như cũ
      }).map((m) => m.id),
    );
    const pm: Record<string, number> = {}; LIVE_QUALITY_PRESETS.forEach((p) => { pm[p.id] = streamBandwidthMbps(p); });

    // ── PASS 0 (CHUYỂN TAY tự-copy): luồng đang "copying_video" — chờ bản sao video sang máy đích SẴN
    //    SÀNG rồi TỰ vào pha chuyển (stopping_source). Luồng VẪN phát ở máy nguồn suốt lúc copy (không
    //    cắt sóng). Máy đích offline / copy lỗi / quá hạn → HUỶ + báo (luồng vẫn ở máy cũ). Gate RISE_LIVE_MOVE.
    let copyMoved = 0, copyFailed = 0;
    if (MOVE_FEATURE_ON()) {
      const waiting = streams.filter((s) => s.moveState === "copying_video" && s.moveTargetId);
      for (const s of waiting) {
        const abort = async (reason: string) => {
          await firestore.collection(S_COL).doc(s.id).set({ moveState: null, moveTargetId: null, moveCopyDeadlineAt: null, updatedAt: nowISO() }, { merge: true });
          if (s.moveExecId) await firestore.collection("liveMoveExecutions").doc(s.moveExecId).set({ state: "failed", failedAt: nowISO(), reason }, { merge: true }).catch(() => {});
          if (s.createdBy) notifyOutcome(firestore, [s.createdBy], { eventType: "live_move", label: `Chuyển "${String(s.name ?? "").slice(0, 60)}" HUỶ — ${reason}. Luồng vẫn phát ở máy cũ.`, tone: "red", pushCategory: "urgent" }).catch(() => {});
          copyFailed++;
        };
        const target = machines.find((m) => m.id === String(s.moveTargetId));
        if (!target || !target.online) { await abort("máy đích offline khi đang copy video"); continue; }
        const targetAssetIds = remapAssetIdsToTarget(s, String(s.moveTargetId), assets as any);
        if (targetAssetIds) {
          // Video đã sẵn sàng → vào pha chuyển thật (agent bàn giao 2 pha: dừng nguồn xong mới bật đích).
          await firestore.collection(S_COL).doc(s.id).set({
            moveState: "stopping_source", moveTargetAssetIds: targetAssetIds,
            moveStartedAt: nowISO(), moveDeadlineAt: new Date(nowMs + MOVE_TIMEOUT_SEC() * 1000).toISOString(),
            moveCopyDeadlineAt: null, updatedAt: nowISO(),
          }, { merge: true });
          if (s.moveExecId) await firestore.collection("liveMoveExecutions").doc(s.moveExecId).set({ state: "stopping_source", videoReadyAt: nowISO() }, { merge: true }).catch(() => {});
          // BÁO "đang chuyển" (trước đây nhánh copy-tay này im lặng — Chủ Rise Group báo không thấy thông báo
          // như đường tự-động-cứu). Có thông báo này để biết luồng đã copy xong và ĐANG chuyển sang máy mới.
          const tname = machines.find((m) => m.id === String(s.moveTargetId))?.name ?? "máy mới";
          if (s.createdBy) notifyOutcome(firestore, [s.createdBy], { eventType: "live_move", label: `🔁 Đã copy xong video sang máy "${tname}" — ĐANG chuyển luồng "${String(s.name ?? "").slice(0, 60)}" sang (dừng máy cũ rồi bật máy mới, không phát trùng).`, tone: "amber", pushCategory: "urgent" }).catch(() => {});
          copyMoved++;
        } else {
          // Dò "copy lỗi": khớp theo copyFromAssetId (video upload tay) HOẶC sourceUrl (Drive) — trước đây chỉ
          // sourceUrl -> video upload tay lỗi không bắt kịp, phải chờ hết hạn mới huỷ.
          const srcIds = (Array.isArray(s.assetIds) && s.assetIds.length ? s.assetIds : (s.assetId ? [s.assetId] : [])).map(String);
          const wantUrls = srcIds.map((aid: string) => { const a = (assets as any[]).find((x) => x.id === aid); return String(a?.sourceUrl ?? "").trim(); }).filter(Boolean);
          const errored = (assets as any[]).some((a) => String(a.machineId) === String(s.moveTargetId) && a.status === "error"
            && (srcIds.includes(String(a.copyFromAssetId ?? "")) || (String(a.sourceUrl ?? "").trim() !== "" && wantUrls.includes(String(a.sourceUrl).trim()))));
          const overdue = (Date.parse(String(s.moveCopyDeadlineAt ?? "")) || 0) && nowMs > Date.parse(String(s.moveCopyDeadlineAt));
          if (errored) await abort("copy video lỗi");
          else if (overdue) await abort("copy video quá lâu");
          // else: chưa xong → chờ lần cron sau.
        }
      }
    }
    if (!AUTO_ON()) return NextResponse.json({ ok: true, disabled: "autofailover off", copyMoved, copyFailed });
    const mById2: Record<string, any> = {}; machines.forEach((m) => { mById2[m.id] = m; });

    let failedOver = 0, noTarget = 0, degradedMoved = 0;

    // ═══ CHỐNG DỒN LUỒNG VỀ MỘT MÁY ═══
    // Phát hiện 27/08/2026 (Chủ Rise Group yêu cầu "phân bổ vào nhiều VPS"): trước đây mỗi luồng
    // tính chỗ trống trên CÙNG ảnh chụp dữ liệu đầu lượt và KHÔNG cập nhật sau mỗi lần chuyển.
    // Nên 1 máy chết mang theo 52 luồng thì cả 52 luồng đều thấy CÙNG một máy "thoáng nhất" và
    // cùng dồn về đó -> máy đó sập theo. MẤT 1 MÁY THÀNH MẤT 2.
    // Nay: mỗi lần hứa một luồng cho máy nào thì TRỪ NGAY băng thông đó, để luồng kế tiếp nhìn thấy
    // bức tranh đã cập nhật và tự rải sang máy khác.
    const pending: Record<string, number> = {};
    const machinesWithPending = () => (machines as any[]).map((m) => ({ ...m, pendingMbps: pending[String(m.id)] ?? 0 }));
    const reserve = (machineId: string, mbps: number) => {
      const k = String(machineId);
      pending[k] = (pending[k] ?? 0) + (Number(mbps) || 0);
    };
    // GIU CHO O CUNG trong cung mot luot (Chu Rise 28/08: "khong the cu don het
    // vao 1 con"). Truoc day chi DOC diskFreeGb roi so sanh — chay 20 luong mot
    // luot thi ca 20 ban du phong cung nham MOT may diem cao nhat, moi cai deu
    // tuong con nhieu o, den khi copy that thi may do day o.
    const diskPending: Record<string, number> = {};
    const oConTrong = (m: any): number =>
      Math.max(0, (Number(m?.diskFreeGb) || 0) - (diskPending[String(m?.id)] ?? 0));
    const giuOCung = (machineId: string, gb: number) => {
      const k = String(machineId);
      diskPending[k] = (diskPending[k] ?? 0) + (Number(gb) || 0);
    };
    // GIỮ CHỖ BĂNG THÔNG cho BẢN DỰ PHÒNG (Chủ Rise Group nhắc 29/08/2026: "kẻo đẩy hết về 1 chỗ").
    // Cùng lý do với giữ chỗ ổ cứng ở trên, nhưng ở TRỤC BĂNG THÔNG — trục này trước đây bỏ quên.
    //
    // Đặt một bản dự phòng lên máy X = HỨA rằng X sẽ GÁNH luồng đó khi máy nguồn chết. Không tính
    // khoản hứa này thì mọi bản dự phòng đều nhắm đúng máy "điểm cao nhất" rồi dồn hết về đó.
    // ĐO THẬT 29/08: 30/48 bản nằm trên VPS 01 — đúng máy có băng thông THẤP NHẤT (chỉ vì nó nhiều
    // ổ trống nhất, mà ổ là tiêu chí phụ). Hệ quả: VPS 02 chết thì VPS 01 phải gánh thêm 280 Mbps
    // trong khi chỉ còn ~220 → KHÔNG gánh nổi, tức bản dự phòng đó chỉ có trên giấy.
    const bwLuong = (x: any): number => pm[String(x?.presetId ?? "")] || 6.5;
    // Ghi theo TỪNG MÁY NGUỒN, không cộng gộp — xem giải thích ở conQuyDuPhong().
    const backupPending: Record<string, Record<string, number>> = {};
    // Tải ĐÃ HỨA từ những bản dự phòng ĐÃ NẰM SẴN trên máy (không chỉ trong lượt này) — nếu bỏ qua
    // thì mỗi lượt lại tiếp tục dồn về đúng chỗ đang quá tải.
    const taiBackupDaCo: Record<string, Record<string, number>> = {};
    for (const st of streams as any[]) {
      if (!(st.desiredState === "live" || st.control === "schedule")) continue;
      const ids: string[] = Array.isArray(st.assetIds) ? st.assetIds : (st.assetId ? [st.assetId] : []);
      const daTinh = new Set<string>();
      for (const i of ids) {
        const goc: any = (assets as any[]).find((x) => String(x.id) === String(i));
        if (!goc) continue;
        for (const x of assets as any[]) {
          if (String(x.machineId) === String(st.machineId)) continue;
          const khop = String(x.copyFromAssetId ?? "") === String(i)
            || (String(goc.sourceUrl ?? "").trim() !== "" && String(x.sourceUrl ?? "").trim() === String(goc.sourceUrl).trim());
          if (!khop || daTinh.has(String(x.machineId))) continue;
          daTinh.add(String(x.machineId));
          const giu = String(x.machineId), nguon = String(st.machineId);
          (taiBackupDaCo[giu] ||= {});
          taiBackupDaCo[giu][nguon] = (taiBackupDaCo[giu][nguon] ?? 0) + bwLuong(st);
        }
      }
    }
    // QUỸ CỨU HỘ RIÊNG (Chủ Rise Group chốt 29/08/2026): bản dự phòng KHÔNG tranh chỗ với luồng
    // đang chạy. Máy dùng tối đa 70% băng thông để CHẠY luồng của nó; 30% chừa ra chính là quỹ để
    // GÁNH luồng cứu hộ. Vì vậy tính bản dự phòng vào 30% đó, KHÔNG trừ vào quỹ 70%.
    const quyDuPhong = (m: any) => quyDuPhongMbps(m?.uploadMbps);   // 50% bang thong (Chu Rise chot 29/08)
    /**
     * Quỹ cứu hộ CÒN LẠI của một máy.
     *
     * KHÔNG cộng gộp mọi lời hứa (Chủ Rise Group 29/08/2026: "không phải lúc nào cũng gặp sự cố
     * để tất cả luồng dự phòng cùng qua một lúc"). Mỗi lần chỉ MỘT máy chết, nên máy giữ bản dự
     * phòng chỉ cần đỡ nổi phần của MÁY NGUỒN NẶNG NHẤT — không phải tổng tất cả.
     * Cộng gộp thì quá chặt: đo thật cho ra VPS 03 "vượt 715 Mbps" trong khi máy nguồn nặng nhất
     * của nó chỉ 421 — số cộng gộp làm hệ ngừng đặt bản dự phòng một cách vô lý.
     */
    const conQuyDuPhong = (m: any) => {
      const k = String(m?.id);
      const theoNguon: Record<string, number> = {};
      Object.entries(taiBackupDaCo[k] ?? {}).forEach(([n, v]) => { theoNguon[n] = (theoNguon[n] ?? 0) + v; });
      Object.entries(backupPending[k] ?? {}).forEach(([n, v]) => { theoNguon[n] = (theoNguon[n] ?? 0) + v; });
      const nangNhat = Math.max(0, ...Object.values(theoNguon));
      return quyDuPhong(m) - nangNhat;
    };
    const giuBangThongBackup = (machineId: string, nguonId: string, mbps: number) => {
      const k = String(machineId), n = String(nguonId);
      (backupPending[k] ||= {});
      backupPending[k][n] = (backupPending[k][n] ?? 0) + (Number(mbps) || 0);
    };
    // KHỞI ĐỘNG 1 lần chuyển tự động. mode="direct" (nguồn CHẾT → cutover ngay); mode="safe" (nguồn
    // CÒN SỐNG nhưng yếu → BÀN GIAO 2 pha, dừng nguồn trước, KHÔNG phát trùng).
    const startMove = async (s: any, mode: "direct" | "safe", reason: string): Promise<boolean> => {
      const pf = moveTargetPreflight(s, machinesWithPending() as any, streams as any, assets as any, pm, "emergency");
      const best = pf.best;
      let targetAssetIds = best ? remapAssetIdsToTarget(s, best.machineId, assets as any) : null;
      let chosen = (!best || !best.hasVideo || !targetAssetIds || checkMoveTarget(pf, best.machineId).level === "block") ? null : best;
      let vuotNguong = false;

      // ═══ LUỒNG ƯU TIÊN KHÔNG BAO GIỜ BỊ BỎ ═══
      // Chủ Rise Group chốt 27/08/2026: "kể cả 80% hay 90% cũng phải cứu".
      // Trước đây: hết máy dưới ngưỡng -> bỏ cuộc, gửi "cần xử lý tay" rồi thôi. Trái luật trên.
      // Nay: nếu không còn máy nào ĐỦ ngưỡng, vẫn chọn máy CÓ VIDEO tốt nhất và cứu, kèm cảnh báo đỏ.
      //
      // ⚠ CHỈ ĐƯỢC bỏ qua rào BĂNG THÔNG. Các rào khác vẫn phải chặn vì bỏ qua là vô nghĩa:
      //   · máy offline / bảo trì  -> chuyển sang cũng không chạy
      //   · sai vai trò/pool       -> máy không dành cho loại luồng này
      // Rào "máy đang nghẽn" thì được bỏ qua nhưng XẾP SAU CÙNG (chọn máy không nghẽn trước).
      if (!chosen && isPrio(s)) {
        const cuuDuoc = pf.candidates
          .filter((c) => c.hasVideo)
          .filter((c) => !c.blockers.some((b) => !/băng thông|đang nghẽn/.test(b)))
          .sort((a, b) => {
            const an = a.blockers.some((x) => /đang nghẽn/.test(x)) ? 1 : 0;
            const bn = b.blockers.some((x) => /đang nghẽn/.test(x)) ? 1 : 0;
            if (an !== bn) return an - bn;                    // máy KHÔNG nghẽn trước
            return b.headroomMbps - a.headroomMbps;           // rồi tới máy thoáng nhất
          })[0];
        if (cuuDuoc) {
          const ids = remapAssetIdsToTarget(s, cuuDuoc.machineId, assets as any);
          if (ids && ids.length) { chosen = cuuDuoc; targetAssetIds = ids; vuotNguong = true; }
        }
      }

      if (!chosen || !targetAssetIds) {
        noTarget++;
        await firestore.collection(S_COL).doc(s.id).set({ cooldownUntil: new Date(nowMs + 5 * 60000).toISOString(), updatedAt: nowISO() }, { merge: true });
        if (s.createdBy) notifyOutcome(firestore, [s.createdBy], { eventType: "live_failover_notarget", label: `⛔ Luồng "${String(s.name ?? "").slice(0, 60)}" cần cứu (${reason}) nhưng KHÔNG có máy nào CÓ SẴN VIDEO để nhận — cần xử lý tay.`, tone: "red", pushCategory: "urgent" }).catch(() => {});
        return false;
      }
      const best2 = chosen;
      const prevAssetIds: string[] = Array.isArray(s.assetIds) && s.assetIds.length ? s.assetIds : (s.assetId ? [s.assetId] : []);
      const exec = await firestore.collection("liveMoveExecutions").add({
        streamId: s.id, streamName: s.name ?? "", moveType: "automatic_failover", trigger: "auto",
        sourceMachineId: String(s.machineId ?? ""), targetMachineId: best2.machineId, reason,
        startedAt: nowISO(), state: mode === "direct" ? "starting_target" : "stopping_source", initiatedBy: "system",
      });
      const base: any = {
        moveType: "automatic_failover", moveSourceId: String(s.machineId ?? ""), moveTargetId: best2.machineId,
        moveTargetAssetIds: targetAssetIds, movePrevAssetIds: prevAssetIds,
        moveExecId: exec.id, moveStartedAt: nowISO(), moveDeadlineAt: new Date(nowMs + MOVE_TIMEOUT_SEC() * 1000).toISOString(), updatedAt: nowISO(),
      };
      if (mode === "direct") { base.machineId = best2.machineId; base.fencingToken = (Number(s.fencingToken) || 0) + 1; base.moveState = "starting_target"; base.assetIds = targetAssetIds; base.assetId = targetAssetIds[0]; }
      else { base.moveState = "stopping_source"; }   // nguồn còn sống → bàn giao an toàn (agent tự tiến)
      await firestore.collection(S_COL).doc(s.id).set(base, { merge: true });
      // GIỮ CHỖ ngay trên máy đích để luồng kế tiếp trong CÙNG lượt không dồn về đây nữa.
      reserve(best2.machineId, Number(pf.streamBwMbps ?? 0) || 0);
      await logAudit(firestore, { action: "live_auto_failover", entityType: "liveStream", entityId: s.id, performedBy: "system", detail: `tự cứu "${s.name}" → máy ${best2.name} (${reason})` });
      // Cứu VƯỢT NGƯỠNG -> cảnh báo ĐỎ + đẩy điện thoại cho CẢ quản trị, vì máy đích sẽ chạy quá tải
      // và cần người vào xử lý tay (Chủ Rise Group yêu cầu 27/08/2026).
      if (vuotNguong) {
        // Cùng cách lấy BLĐ/Admin như route cảnh báo Live (giữ một luật, khỏi lệch nhau).
        const adSnap = await firestore.collection("users").where("role", "==", "admin").limit(50).get().catch(() => null);
        const ai = Array.from(new Set([
          ...((adSnap?.docs ?? []).map((d) => String((d.data() as any).email ?? "").toLowerCase()).filter(Boolean)),
          ...(s.createdBy ? [String(s.createdBy).toLowerCase()] : []),
        ]));
        if (ai.length) notifyOutcome(firestore, ai, { eventType: "live_failover_over", label: `🚨 Luồng ưu tiên "${String(s.name ?? "").slice(0, 60)}" ĐÃ ĐƯỢC CỨU sang máy "${best2.name}" nhưng máy này VƯỢT NGƯỠNG an toàn — có thể giật. Vào xử lý tay (giảm bớt luồng thường hoặc chuyển sang máy khác).`, tone: "red", pushCategory: "urgent" }).catch(() => {});
      } else if (s.createdBy) notifyOutcome(firestore, [s.createdBy], { eventType: "live_failover", label: `🔁 Luồng "${String(s.name ?? "").slice(0, 60)}" — ${reason} — hệ thống ĐANG tự chuyển sang máy "${best2.name}".`, tone: "amber", pushCategory: "urgent" }).catch(() => {});
      return true;
    };

    // (A) Chủ Rise chốt 2026-08-18: luồng ƯU TIÊN/TRỌNG YẾU LUÔN được bảo vệ (tự cứu) — khỏi cần
    //     tích riêng "tự động cứu". Coi như automatic kể cả khi failoverMode chưa đặt/tắt.
    const isAutoProtected = (s: any) => String(s.mode) !== "live-pub" && (s.failoverMode === "automatic" || isPrio(s));

    // PASS 1 — MÁY CHẾT (mất heartbeat / bị ngắt): cứu trực tiếp.
    const dead = streams.filter((s) => isAutoProtected(s) && (s.desiredState === "live" || (s.control === "schedule" && s.scheduleActive)) && deadIds.has(String(s.machineId ?? "")) && !isMoveActive(s.moveState) && !(s.cooldownUntil && nowMs < Date.parse(s.cooldownUntil)));
    for (const s of dead) { if (await startMove(s, "direct", "máy nguồn mất kết nối")) failedOver++; }

    // PASS 2 — YẾU KÉO DÀI (lỗi bộ phận, máy CÒN SỐNG). THẬN TRỌNG: chỉ khi đang "slow" (tốc độ<0.92
    // liên tục >90s) VÀ đã yếu thêm ≥DEGRADE_SEC. Bỏ qua nếu nghi lỗi YouTube (ytIssue) hoặc lỗi tiến
    // trình (restartHalted) — mấy cái đó chuyển máy vô ích. Bàn giao AN TOÀN (nguồn còn sống).
    const degradeSec = DEGRADE_SEC();
    const degraded = streams.filter((s) => {
      if (!isAutoProtected(s)) return false;
      if (!(s.desiredState === "live" || (s.control === "schedule" && s.scheduleActive))) return false;
      const m = mById2[String(s.machineId ?? "")];
      if (!m || !m.online || deadIds.has(String(s.machineId ?? ""))) return false;   // máy chết đã xử ở PASS 1
      if (isMoveActive(s.moveState) || (s.cooldownUntil && nowMs < Date.parse(s.cooldownUntil))) return false;
      if (s.ytIssue) return false;          // nghi lỗi YouTube → chuyển máy vô ích
      if (s.restartHalted) return false;    // lỗi tiến trình/nguồn → cần người, không chuyển
      if (s.slow !== true || !s.slowSince) return false;                              // phải ĐANG yếu (đẩy chậm hơn thời gian thực)
      if ((nowMs - Date.parse(s.slowSince)) < degradeSec * 1000) return false;        // + đủ LÂU (thận trọng)
      return true;
    });
    for (const s of degraded) {
      if (await startMove(s, "safe", "tín hiệu yếu kéo dài (nghi lỗi VPS)")) {
        degradedMoved++;
        await firestore.collection(S_COL).doc(s.id).set({ cooldownUntil: new Date(nowMs + 15 * 60000).toISOString() }, { merge: true });   // nghỉ dài chống nhảy qua lại
      }
    }
    // ── XÁC NHẬN YOUTUBE SAU CHUYỂN ── Luồng "verifying" (đích đã lên sóng) + kênh CÓ nối L3 → đối
    // chiếu YouTube đã nhận lại ĐÚNG video chưa. Có → chốt XONG + youtubeConfirmedAt. Không có L3 /
    // chưa xác nhận → để agent tự chốt sau ân hạn (đích vẫn đang phát). Best-effort, không chặn.
    let ytConfirmed = 0;
    const clearMoveFields = { moveState: null, moveSourceId: null, moveTargetId: null, moveExecId: null, moveStartedAt: null, moveDeadlineAt: null, moveTargetAssetIds: null, movePrevAssetIds: null, moveType: null, moveVerifyAt: null };
    const verifying = streams.filter((s) => s.moveState === "verifying" && s.channelId && s.watchUrl);
    for (const s of verifying) {
      try {
        const connSnap = await firestore.collection("liveYoutubeConnections").where("riseChannelId", "==", String(s.channelId)).limit(1).get();
        if (connSnap.empty) continue;   // kênh chưa nối L3 → agent tự chốt sau ân hạn
        const refresh = await getConnectionRefreshToken(connSnap.docs[0].id);
        if (!refresh) continue;
        const access = await accessTokenFromRefresh(refresh);
        const yt = await fetchChannelLiveState(access);
        const vid = extractYouTubeVideoId(String(s.watchUrl ?? ""));
        const confirmed = !!vid && (yt?.broadcasts ?? []).some((b: any) => String(b.videoId) === vid);
        if (!confirmed) continue;
        await firestore.collection(S_COL).doc(s.id).set({ ...clearMoveFields, updatedAt: nowISO() }, { merge: true });
        if (s.moveExecId) await firestore.collection("liveMoveExecutions").doc(s.moveExecId).set({ completedAt: nowISO(), state: "done", result: "success", youtubeConfirmedAt: nowISO() }, { merge: true }).catch(() => {});
        if (s.createdBy) { const fromN = mById2[String(s.moveSourceId ?? "")]?.name ?? "máy cũ"; const toN = mById2[String(s.moveTargetId ?? "")]?.name ?? "máy mới"; notifyOutcome(firestore, [s.createdBy], { eventType: "live_move_done", label: `✅ Đã chuyển luồng "${String(s.name ?? "").slice(0, 60)}" từ "${fromN}" sang "${toN}" thành công — YouTube ĐÃ nhận lại tín hiệu.`, tone: "green", pushCategory: "urgent" }).catch(() => {}); }
        ytConfirmed++;
      } catch { /* best-effort — agent sẽ tự chốt sau ân hạn */ }
    }

    // ── TỰ ĐỘNG SAO LƯU (ghim) VIDEO LUỒNG ƯU TIÊN ── Mỗi luồng priority/critical + automatic phải
    // có bản video SẴN trên 1 máy KHÁC (ưu tiên khác vùng lỗi) để cứu tức thì. Thiếu → tự tạo bản
    // copy (worker máy đó tự tải) — KHÔNG tạo lại nếu đã có/đang tải. Chỉ áp luồng ưu tiên.
    const INFLIGHT = ["ready", "downloading", "normalizing", "pending", "queued"];
    let backupsStarted = 0;
    // (A) Chủ Rise chốt 2026-08-18: TẢI SẴN bản dự phòng cho luồng ƯU TIÊN ĐÃ LÊN LỊCH, TRƯỚC giờ
    // chạy (mặc định trong 2h tới) → đến giờ phát là đã có dự phòng, khỏi cửa sổ hở đầu giờ. Luồng
    // thường KHÔNG tải sẵn (giữ nhẹ ổ máy dự phòng).
    const prestageMs = (Number(process.env.RISE_LIVE_PRESTAGE_HOURS) || 2) * 3600 * 1000;
    const startingSoon = (s: any) => {
      if (s.control !== "schedule" || !s.schedule || s.scheduleActive) return false;
      const nx = nextScheduleStartMs(s.schedule, nowMs);
      return nx != null && nx > nowMs && (nx - nowMs) <= prestageMs;
    };
    const priorityStreams = streams.filter((s) => isPrio(s) && (s.desiredState === "live" || (s.control === "schedule" && s.scheduleActive) || startingSoon(s)));
    for (const s of priorityStreams) {
      const ids: string[] = Array.isArray(s.assetIds) && s.assetIds.length ? s.assetIds : (s.assetId ? [s.assetId] : []);
      const srcAssets = ids.map((id) => assets.find((a: any) => a.id === id)).filter(Boolean) as any[];
      if (!srcAssets.length || srcAssets.length < ids.length) continue;
      // COPY VPS->VPS: cần địa chỉ máy NGUỒN (đang giữ file đã chuẩn) -> bản dự phòng KÉO THẲNG file đó về,
      // giữ nguyên chất lượng, KHÔNG tải Drive (Drive hạ file lớn xuống 360p). NAY dùng cho CẢ video upload tay
      // (không có link Drive) — trước đây bị bỏ qua. Thiếu IP máy nguồn -> bỏ qua (không tự copy được).
      const srcMachine = machines.find((m: any) => m.id === String(s.machineId ?? ""));
      const srcIp = String(srcMachine?.ip ?? "").trim();
      if (!srcIp) continue;
      const copyFromUrl = `http://${srcIp}:${Number(process.env.RISE_LIVE_UPLOAD_PORT) || 8099}`;
      const cands = machines.filter((m) => m.online && !m.maintenance && m.id !== String(s.machineId ?? ""));
      // Đã có 1 máy KHÁC giữ đủ mọi video chưa? → dedup theo id asset nguồn (hoạt động cả video upload tay),
      // vẫn nhận diện bản cũ theo sourceUrl (Drive) để không tạo trùng.
      // ═══ SỐ BẢN DỰ PHÒNG THEO MỨC QUAN TRỌNG ═══
      // Chủ Rise Group chốt 27/08/2026: luồng "Rất quan trọng" phải có bản trên ÍT NHẤT 2 máy khác
      // (cộng máy đang live = 3 bản). Luồng "Ưu tiên" giữ 1 bản như cũ.
      // Vì sao: khi cứu sự cố, máy phải VỪA có video VỪA còn băng thông. Chỉ 1 bản mà đúng máy đó
      // đang đầy thì hết đường. Càng nhiều bản, càng nhiều máy lọt qua điều kiện bắt buộc "có video",
      // nên tiêu chí băng thông mới có chỗ phát huy.
      // Chi phí đo thật: video trung vị 2,5 GB → nâng lên 3 bản chỉ tốn thêm ~2% ổ trống toàn hệ.
      // Số này CHỈNH ĐƯỢC khi Rise có thêm VPS (không gắn cứng "mọi máy" — sẽ vô lý khi có 20 máy).
      const soBanCan = String(s.importance ?? "") === "critical"
        ? (Number(process.env.RISE_LIVE_REPLICAS_CRITICAL) || 2)
        : (Number(process.env.RISE_LIVE_REPLICAS_PRIORITY) || 1);
      const mayDangGiu = cands.filter((m) => {
        const have = new Set<string>();
        assets.filter((x: any) => String(x.machineId) === m.id && INFLIGHT.includes(x.status)).forEach((x: any) => {
          if (x.copyFromAssetId) have.add("id:" + String(x.copyFromAssetId));
          const su = String(x.sourceUrl ?? "").trim(); if (su) have.add("url:" + su);
        });
        return srcAssets.every((a) => have.has("id:" + String(a.id)) || (String(a.sourceUrl ?? "").trim() !== "" && have.has("url:" + String(a.sourceUrl).trim())));
      }).length;
      if (mayDangGiu >= soBanCan) continue;
      // CHỌN MÁY ĐÍCH cho bản dự phòng: KHÔNG chỉ theo ổ cứng trống (trước đây dồn vào máy nhiều ổ dù ÍT
      // BĂNG THÔNG). Dùng xếp hạng ĐẦY ĐỦ như khi "Chuyển máy" — đã cân BĂNG THÔNG còn trống (đủ để THẬT SỰ
      // chạy luồng khi failover) + khác vùng lỗi + độ tin cậy — rồi lọc thêm ĐỦ Ổ CỨNG cho file.
      const fileGb = srcAssets.reduce((sum, a) => sum + (Number(a.sizeMb) || 0) / 1024, 0);
      // Dung machinesWithPending(): bang thong da hen cho o buoc tu-cuu phia tren
      // phai duoc tru ra, khong thi ban du phong lai nham dung may vua nhan luong.
      const pfBackup = moveTargetPreflight(s, machinesWithPending() as any, streams as any, assets as any, pm, "planned");
      // Chỉ xét máy CHƯA giữ bản nào của luồng này — tránh dồn 2 bản lên cùng một máy (vô nghĩa:
      // máy đó chết là mất cả hai).
      const daGiu = new Set(cands.filter((m) => {
        const have = new Set<string>();
        assets.filter((x: any) => String(x.machineId) === m.id && INFLIGHT.includes(x.status)).forEach((x: any) => {
          if (x.copyFromAssetId) have.add("id:" + String(x.copyFromAssetId));
          const su = String(x.sourceUrl ?? "").trim(); if (su) have.add("url:" + su);
        });
        return srcAssets.every((a) => have.has("id:" + String(a.id)) || (String(a.sourceUrl ?? "").trim() !== "" && have.has("url:" + String(a.sourceUrl).trim())));
      }).map((m) => m.id));
      const candSet = new Set(cands.filter((m) => !daGiu.has(m.id)).map((m) => m.id));
      const best = pfBackup.candidates
        .filter((c) => c.eligible && candSet.has(c.machineId))                              // đủ băng thông/vai trò + online (trong danh sách ứng viên)
        .map((c) => ({ c, m: mById2[c.machineId] as any }))
        .filter((x) => x.m && oConTrong(x.m) > fileGb + 10)                                 // đủ ổ cho file + 10GB đệm (đã trừ phần hẹn trước trong lượt này)
        .filter((x) => conQuyDuPhong(x.m) >= bwLuong(s))                                    // QUỸ CỨU HỘ (30%) còn đủ để THẬT SỰ gánh luồng này
        // ƯU TIÊN SỐ 1: máy còn NHIỀU QUỸ CỨU HỘ nhất -> chia đều, không dồn một chỗ.
        // Bằng nhau mới xét tới điểm tổng (độc lập/tin cậy) rồi tới ổ cứng.
        .sort((a, b) => (conQuyDuPhong(b.m) - conQuyDuPhong(a.m)) || (b.c.score - a.c.score) || (oConTrong(b.m) - oConTrong(a.m)))[0]?.m;
      if (!best) {
        // Không máy nào ĐỦ SỨC GÁNH thêm luồng này -> KHÔNG tạo bản dự phòng giả. Nói rõ ra
        // thay vì im lặng: bản dự phòng đặt ở máy không gánh nổi thì lúc cần cũng vô dụng.
        console.warn(`[RISE LIVE] chua dat duoc ban du phong cho luong "${String(s.name ?? s.id)}": khong may nao con du QUY CUU HO (30%) de ganh (~${Math.round(bwLuong(s))} Mbps).`);
        continue;
      }
      giuOCung(best.id, fileGb);
      giuBangThongBackup(best.id, String(s.machineId), bwLuong(s));   // hẹn chỗ băng thông NGAY -> luồng kế tiếp nhìn thấy máy này đã "hứa" rồi   // hen cho o NGAY -> luong ke tiep se nhin thay o da voi di
      for (const a of srcAssets) {
        const su = String(a.sourceUrl ?? "").trim();
        // "Máy đó đã có bản này" — nhưng BẢN HỎNG THÌ KHÔNG TÍNH (30/08/2026, Chủ Rise Group phát hiện).
        // Trước đây không xét trạng thái: một lần chép thất bại để lại dòng lỗi trên máy đích, và dòng
        // đó bị hiểu là "đã có bản dự phòng" → hệ KHÔNG BAO GIỜ tạo bản thật ở máy đó nữa, im lặng.
        // Ca thật: luồng "30.08 Quiet Mind Live 247" — chép sang VPS 06 hỏng vì máy nguồn (VPS 03) chết.
        // Chỗ CHUYỂN MÁY (lib/live-move.ts) vốn đã chỉ nhận `status === "ready"` — đây là cho khớp lại.
        if (assets.some((x: any) => String(x.machineId) === best.id && String(x.status ?? "") !== "error" && (String(x.copyFromAssetId ?? "") === String(a.id) || (su !== "" && String(x.sourceUrl ?? "").trim() === su)))) continue;
        await firestore.collection(A_COL).add({ name: `${String(a.name ?? "video").slice(0, 90)} (dự phòng)`, sourceUrl: a.sourceUrl ?? null, presetId: a.presetId, machineId: best.id, status: "pending", createdAt: nowISO(), createdBy: "system", source: "auto-backup", copyFromUrl, copyFromAssetId: String(a.id) });
        backupsStarted++;
      }
    }
    // ══ PASS 5 — LUỒNG HẸN GIỜ SẮP BẬT MÀ MÁY SẼ QUÁ TẢI ══════════════════════
    // Vấn đề (Chủ Rise Group phát hiện 28/08/2026): cửa chặn 70% băng thông CHỈ
    // chạy khi người dùng bấm "lên sóng ngay". Luồng HẸN GIỜ đi đường khác — cứ
    // tới giờ là agent bật — nên lọt hoàn toàn. Có thể hẹn 50 luồng cùng khung
    // giờ trên MỘT máy rồi tới giờ chúng đồng loạt bật và bóp chết máy đó.
    //
    // Quyết định của Chủ Rise Group:
    //   • Luồng 24/7  → ĐẨY SANG MÁY KHÁC được
    //   • Luồng Pub   → CỨ PHÁT, chỉ cảnh báo (Pub rớt là YouTube đóng buổi phát,
    //                   chuyển máy vô nghĩa — khớp với cách hệ đang loại Pub khỏi tự-cứu)
    //
    // Vì sao xử lý TRƯỚC giờ phát: lúc này luồng đang DỪNG, nên "chuyển máy" chỉ
    // là đổi máy phụ trách — KHÔNG phải cắt sóng bàn giao như chuyển lúc đang phát.
    // Không mất một giây sóng nào.
    const PRE_MIN = (): number => { const n = Number(process.env.RISE_LIVE_SCHEDULE_LOOKAHEAD_MIN); return Number.isFinite(n) && n >= 2 ? Math.round(n) : 10; };
    let schedMoved = 0, schedWarned = 0;
    {
      const mById3: Record<string, any> = {}; machines.forEach((m: any) => { mById3[m.id] = m; });
      const sapBat = streams.filter((s: any) => {
        if (String(s.control) !== "schedule") return false;
        if (isWithinSchedule(s.schedule, nowMs)) return false;          // đang trong khung giờ = đã/đang phát
        if (String(s.status) === "live" || isMoveActive(s)) return false;
        const nx = nextScheduleStartMs(s.schedule, nowMs);
        return nx != null && nx - nowMs > 0 && nx - nowMs <= PRE_MIN() * 60000;
      });
      for (const s of sapBat) {
        const m = mById3[String(s.machineId ?? "")];
        if (!m || !m.online) continue;
        const up = Number(m.uploadMbps) || 0;
        const tx = Number(m.txMbps);
        if (!(up > 0 && Number.isFinite(tx) && tx <= up * 1.05)) continue;   // trần ghi sai → không tin được, bỏ qua
        const bw = Number(pm[String(s.presetId ?? "")] ?? 0) || 0;
        const duKien = tx + bw + (pending[String(m.id)] ?? 0);
        if (duKien <= up * DEFAULT_SAFETY_FACTOR) continue;                          // vẫn trong ngưỡng → không cần làm gì
        const ten = String(s.name ?? "").slice(0, 60);
        const soSanh = `${Math.round(duKien)}/${Math.round(up)} Mbps ~ ${Math.round((duKien / up) * 100)}%`;

        // ── Live Pub: KHÔNG chuyển, chỉ báo ──
        if (String(s.mode) === "live-pub") {
          schedWarned++;
          if (s.createdBy) await notifyOutcome(firestore, [String(s.createdBy)], { eventType: "live_incident",
            label: `⚠ Luồng Pub "${ten}" sắp tới giờ phát trên máy "${m.name}" đã gần đầy băng thông (${soSanh}). Luồng VẪN phát như lịch, nhưng có thể giật — cân nhắc hạ chất lượng hoặc dừng bớt luồng khác.`,
            tone: "amber", pushCategory: "urgent" }).catch(() => {});
          continue;
        }

        // ── Luồng 24/7: tìm máy khác CÓ SẴN video rồi đổi máy phụ trách ──
        const pfS = moveTargetPreflight(s, machinesWithPending() as any, streams as any, assets as any, pm, "planned");
        const ungVien = pfS.candidates.find((c) => c.eligible && c.hasVideo);
        const ids = ungVien ? remapAssetIdsToTarget(s, ungVien.machineId, assets as any) : null;
        if (!ungVien || !ids) {
          schedWarned++;
          if (s.createdBy) await notifyOutcome(firestore, [String(s.createdBy)], { eventType: "live_incident",
            label: `⚠ Luồng "${ten}" sắp tới giờ phát nhưng máy "${m.name}" sẽ quá ngưỡng an toàn (${soSanh}), mà KHÔNG có máy nào khác đủ chỗ + đã có sẵn video. Luồng vẫn sẽ phát — kiểm tra kẻo giật.`,
            tone: "red", pushCategory: "urgent" }).catch(() => {});
          continue;
        }
        // Luồng đang DỪNG → chỉ đổi máy phụ trách, không cần bàn giao/cắt sóng.
        await firestore.collection(S_COL).doc(s.id).set({ machineId: ungVien.machineId, assetIds: ids, assetId: ids[0], updatedAt: nowISO() }, { merge: true });
        reserve(ungVien.machineId, bw);
        schedMoved++;
        await logAudit(firestore, { action: "live_move_stream", entityType: "liveStream", entityId: s.id, performedBy: "system",
          detail: `dời trước giờ phát: "${ten}" từ "${m.name}" (sẽ quá tải ${soSanh}) sang "${ungVien.name}"` }).catch(() => {});
        if (s.createdBy) await notifyOutcome(firestore, [String(s.createdBy)], { eventType: "live_move",
          label: `🔁 Luồng "${ten}" đã được dời sang máy "${ungVien.name}" TRƯỚC giờ phát — máy cũ "${m.name}" sắp quá ngưỡng an toàn (${soSanh}). Không mất sóng vì luồng chưa bật.`,
          tone: "amber", pushCategory: "urgent" }).catch(() => {});
      }
    }

    return NextResponse.json({ ok: true, failedOver, degradedMoved, ytConfirmed, noTarget, dead: deadIds.size, backupsStarted, copyMoved, copyFailed, schedMoved, schedWarned });
  } catch (error: any) {
    console.error("POST /api/live/failover/run failed", error);
    return NextResponse.json({ error: error?.message ?? "Lỗi máy chủ." }, { status: 500 });
  }
}
