// RISE LIVE R1.2 — API cho WORKER trên VPS. Worker "gọi về" (poll) mỗi ~10s: báo heartbeat +
// trạng thái asset/luồng của nó → nhận lại DANH SÁCH MONG MUỐN (asset cần nén, luồng cần chạy).
// Xác thực bằng TOKEN (env RISE_LIVE_WORKER_TOKEN) — KHÔNG phiên đăng nhập. Worker chỉ thấy dữ
// liệu của MÁY nó (theo machineId). KHÔNG dùng cho giao diện người dùng.
import { NextResponse } from "next/server";
import { firestore } from "@/lib/firestore";
import { resolveLivePreset, YOUTUBE_RTMP_BASE, isWithinSchedule, currentScheduleStartMs } from "@/lib/live-catalog";
import { notifyOutcome } from "@/lib/notify";
import { verifyWorkerToken } from "@/lib/live-worker-auth";
import { streamLeaseEnabled, LEASE_GRACE_SEC } from "@/lib/live-lease";
import { VERIFY_GRACE_SEC } from "@/lib/live-move";
import { thumbPushSec as nhipDayAnh } from "@/lib/live-thumb-store";
import { POLL_SLOW_SEC, POLL_FAST_SEC, POLL_FAST_WINDOW_MS, WRITE_ON_CHANGE_REFRESH_SEC } from "@/lib/live-cadence";
import { cheKhoaTrongCau } from "@/lib/live-stream-key";

export const dynamic = "force-dynamic";
const M_COL = "liveMachines", A_COL = "liveAssets", S_COL = "liveStreams";
const nowISO = () => new Date().toISOString();

// Lấy file id Google Drive từ link chia sẻ (…/file/d/<ID>/view hoặc ?id=<ID>).
function driveIdFromUrl(url: string): string {
  const s = String(url ?? "");
  const m1 = s.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
  if (m1) return m1[1];
  const m2 = s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (m2) return m2[1];
  return "";
}

export async function POST(request: Request) {
  try {
    if (!process.env.RISE_LIVE_WORKER_TOKEN) return NextResponse.json({ error: "Worker chưa cấu hình (thiếu RISE_LIVE_WORKER_TOKEN)." }, { status: 503 });
    const given = request.headers.get("x-rise-live-token") ?? "";
    const body = await request.json().catch(() => ({}));
    const machineId = String(body.machineId ?? "");
    if (!machineId) return NextResponse.json({ error: "Thiếu machineId." }, { status: 400 });
    // Vé CHUNG (cũ) hoặc vé RIÊNG của đúng máy này — xem lib/live-worker-auth.
    if (!verifyWorkerToken(machineId, given)) return NextResponse.json({ error: "Token không hợp lệ." }, { status: 401 });
    const mRef = firestore.collection(M_COL).doc(machineId);
    const mDoc = await mRef.get();
    if (!mDoc.exists) return NextResponse.json({ error: "Máy chưa đăng ký." }, { status: 404 });

    // 1) Cập nhật HEARTBEAT + specs máy tự báo.
    const hb = body.heartbeat ?? {};
    // Nếu admin đã ĐẶT TAY băng thông (uploadMbpsManual) → KHÔNG cho worker tự đo ghi đè.
    // (dùng lại mDoc đã đọc ở trên — khỏi đọc Firestore lần 2 mỗi heartbeat.)
    const bwManual = (mDoc.data() as any)?.uploadMbpsManual === true;
    // Admin ĐÃ NGẮT máy này (giả lập sự cố / bảo trì) → bảo worker DỪNG hết luồng (auto-failover cứu luồng ưu tiên).
    const forceOff = (mDoc.data() as any)?.forceOffline === true;
    const patch: any = { lastHeartbeatAt: nowISO(), status: "online", agentVersion: String(body.agentVersion ?? "") };
    for (const k of ["vcpu", "ramGb", "diskGb", "uploadMbps", "loadAvg", "diskFreeGb", "txMbps"]) {
      if (k === "uploadMbps" && bwManual) continue;   // tôn trọng băng thông đặt tay
      if (hb[k] != null && Number.isFinite(Number(hb[k]))) patch[k] = Number(hb[k]);
    }
    // CÔNG CỤ TẢI (V71.17, worker r2.34): máy tự khai bản yt-dlp + có gdown chưa + lý do tự cập nhật
    // hỏng. Sự cố 29-30/08/2026: VPS 06 mới dựng không có pip3 → cả khối cài lẫn cơ chế tự cập nhật
    // hằng ngày đều thất bại IM LẶNG → máy chạy yt-dlp bản 2022, tải Drive chậm 56 lần khả năng thật
    // của máy, suốt một ngày không ai biết. Từ nay máy phải KHAI ra để giao diện cảnh báo được.
    if (hb.ytdlpVersion != null) patch.ytdlpVersion = String(hb.ytdlpVersion).slice(0, 40);
    if (hb.gdownOk != null) patch.gdownOk = !!hb.gdownOk;
    if (hb.toolError != null) patch.toolError = String(hb.toolError).slice(0, 300);
    await mRef.set(patch, { merge: true });

    // 2) Ghi nhận trạng thái ASSET worker báo. DÙNG update() (KHÔNG set-merge) — để nếu admin
    //    vừa XOÁ thì worker báo trễ 1 nhịp KHÔNG tạo lại doc "ma" (update thất bại lặng nếu đã xoá).
    //    GHI-KHI-ĐỔI CHO VIDEO (sau cờ RISE_LIVE_ASSET_WRITE_ON_CHANGE, mặc định TẮT).
    //    PHÁT HIỆN 29/08/2026 từ màn đo thật (/live-realtime-probe): mỗi nhịp heartbeat, worker báo lại
    //    TOÀN BỘ video trên máy nó, và chỗ này GHI ĐÈ hết — kể cả khi KHÔNG có gì đổi, vì `updatedAt`
    //    luôn mới. Đo được ~12 bản ghi/giây (~800 thay đổi trong 68 giây) → ~1 triệu lượt ghi/ngày chỉ
    //    riêng kho video. Cách hỏi-lại-mỗi-20-giây cũ GIẤU chuyện này vì nó tốn cố định, không lộ ra.
    //    "Ghi-khi-đổi" bản V63.13 chỉ áp cho LUỒNG, bỏ sót VIDEO — đây là vá nốt phần bỏ sót đó.
    //    Cách làm: đọc 1 lần trạng thái video của máy này rồi CHỈ ghi cái nào thật sự khác.
    //    Đọc lỗi → aCur = null → ghi y như cũ (KHÔNG đoán im lặng, quy tắc 5).
    //    An toàn: đã kiểm, KHÔNG chỗ nào phụ thuộc `updatedAt` của video (chỉ luồng dùng, ở mục nhịp
    //    thích ứng phía dưới) — nên bỏ ghi thừa không làm hỏng gì.
    const ASSET_WOC = process.env.RISE_LIVE_ASSET_WRITE_ON_CHANGE === "1";
    const bodyAssets = Array.isArray(body.assets) ? body.assets : [];
    // ĐỌC DANH SÁCH VIDEO CỦA MÁY — ĐÚNG MỘT LẦN CHO CẢ NHỊP (V71.23).
    // Trước đây chỗ này đọc một lần (để so xem có gì đổi), rồi ở mục 4 phía dưới ĐỌC LẠI Y HỆT một lần
    // nữa (để dựng danh sách gửi xuống máy). Cùng câu hỏi, cùng dữ liệu, cách nhau vài mili giây.
    // Đo thật 30/08/2026: mỗi nhịp hỏi tốn ~144 lượt đọc, trong đó 56 là của lần đọc thừa này — tức
    // 39% chi phí đọc của toàn bộ Rise Live worker, khoảng 21 đô-la mỗi tháng cho không.
    // Ghi xong thì CẬP NHẬT LUÔN vào bản đã đọc (dòng `aCur.set` bên dưới) nên danh sách gửi xuống
    // máy vẫn MỚI Y HỆT như đọc lại — không lệch nhịp nào.
    const aSnapChung = await firestore.collection(A_COL).where("machineId", "==", machineId).limit(500).get().catch(() => null);
    let aCur: Map<string, any> | null = null;
    if (ASSET_WOC && aSnapChung) aCur = new Map(aSnapChung.docs.map((d) => [d.id, d.data() as any]));
    for (const a of bodyAssets) {
      const id = String(a.id ?? ""); if (!id) continue;
      const moi: any = {};                              // đúng những gì worker vừa báo
      if (a.status) moi.status = String(a.status);
      if (a.normalizedPath) moi.normalizedPath = String(a.normalizedPath);
      if (a.sizeMb != null) moi.sizeMb = Number(a.sizeMb) || 0;
      if (a.durationSec != null) moi.durationSec = Number(a.durationSec) || 0;
      if (a.width != null) moi.width = Number(a.width) || 0;
      if (a.height != null) moi.height = Number(a.height) || 0;
      if (a.error != null) moi.error = String(a.error).slice(0, 300);
      // TIẾN ĐỘ TẢI (V71.17): worker r2.34 báo % + đã tải/tổng + số video xếp hàng trước. Trước đây
      // người dùng chỉ thấy "Chờ xử lý" đứng im 30 phút, không biết là đang tải, đang chờ, hay treo.
      if (a.progressPct != null) moi.progressPct = Math.max(0, Math.min(100, Number(a.progressPct) || 0));
      if (a.downloadedMb != null) moi.downloadedMb = Number(a.downloadedMb) || 0;
      if (a.totalMb != null) moi.totalMb = Number(a.totalMb) || 0;
      if (a.queueAhead != null) moi.queueAhead = Number(a.queueAhead) || 0;
      if (a.dlMbPerMin != null) moi.dlMbPerMin = Number(a.dlMbPerMin) || 0;
      // Xong (sẵn sàng/lỗi) → XOÁ tiến độ cũ, đừng để "47%" đứng lại vĩnh viễn trên bản ghi.
      if (moi.status === "ready" || moi.status === "error") {
        moi.progressPct = null; moi.downloadedMb = null; moi.totalMb = null; moi.queueAhead = null;
      }
      if (aCur) {
        const truoc = aCur.get(id);
        // Y HỆT bản đang lưu → bỏ qua, không ghi. (Chỉ bỏ khi ĐÃ đọc được bản cũ.)
        // `?? null` cả hai vế: trường tiến độ khi xong được đặt null — nếu so thẳng thì `undefined !== null`
        // sẽ coi là "có đổi" và ghi lại MỌI nhịp cho MỌI video đã sẵn sàng (đúng lỗi ~1 triệu lượt ghi/ngày
        // vừa vá ở V71.x). Chuẩn hoá về null trước khi so là bịt đường đó.
        if (truoc && Object.keys(moi).every((k) => (truoc[k] ?? null) === (moi[k] ?? null))) continue;
      }
      await firestore.collection(A_COL).doc(id).update({ ...moi, updatedAt: nowISO() }).catch(() => { /* doc đã xoá → bỏ qua */ });
      // Ghi xong thì sửa luôn bản trong bộ nhớ → mục 4 dựng danh sách từ đây, dữ liệu MỚI y như đọc lại.
      if (aCur?.has(id)) aCur.set(id, { ...aCur.get(id), ...moi });
    }

    // GIẢM LƯỢT ĐỌC (Giai đoạn 1, sau cờ RISE_LIVE_READ_CONSOLIDATE, mặc định TẮT): đọc trạng thái MỌI
    // luồng của máy 1 LẦN/nhịp rồi dùng lại cho vòng cập nhật + nhật ký + mục 4 (desired list). Trước đây
    // đọc lặp 2–3 lần/nhịp (từng luồng ở vòng live + đọc lại toàn bộ ở mục 4). Ở 300 luồng, ĐỌC là khoản
    // TỐN NHẤT (nhiều gấp mấy lần ghi) → cắt ~1/2 lượt đọc. Đọc lỗi → sMap=null → tự về đọc lẻ như cũ.
    const READCON = process.env.RISE_LIVE_READ_CONSOLIDATE === "1";
    let sMap: Map<string, any> | null = null;
    if (READCON) {
      const snap0 = await firestore.collection(S_COL).where("machineId", "==", machineId).limit(1000).get().catch(() => null);
      if (snap0) sMap = new Map(snap0.docs.map((d) => [d.id, d.data()]));
    }
    // Đọc 1 luồng theo id: ưu tiên ảnh chụp đã đọc 1 lần (khỏi đọc lại); tắt cờ → đọc lẻ đúng như cũ.
    const curOf = async (id: string): Promise<{ exists: boolean; data: any }> => {
      if (sMap) return sMap.has(id) ? { exists: true, data: sMap.get(id) } : { exists: false, data: null };
      const g = await firestore.collection(S_COL).doc(id).get().catch(() => null);
      return { exists: !!g?.exists, data: g?.exists ? g.data() : null };
    };

    // 3) Ghi nhận trạng thái LUỒNG worker báo. Cũng dùng update() để tránh luồng "ma" tự hiện lại
    //    sau khi xoá (bug: set-merge tạo lại doc đã xoá khi worker báo trễ 1 nhịp).
    for (const s of (Array.isArray(body.streams) ? body.streams : [])) {
      const id = String(s.id ?? ""); if (!id) continue;
      const up: any = { lastHeartbeatAt: nowISO() };
      if (s.status) up.status = String(s.status);
      if (s.health) up.health = String(s.health);
      if (s.restarts != null) up.restarts = Number(s.restarts) || 0;
      if (s.uptimeSec != null) up.uptimeSec = Math.max(0, Number(s.uptimeSec) || 0);   // uptime từ lần restart gần nhất
      // CHE KHOA LUONG: dong loi cua ffmpeg thuong kem nguyen duong dan day (co khoa).
      if (s.error != null) up.error = cheKhoaTrongCau(s.error).slice(0, 300);
      // Bitrate ĐANG ĐẨY (kbits/s) + tốc độ thời gian thực (1x = bình thường) — worker đọc từ ffmpeg -progress.
      // Đặt luôn (kể cả null) để khi luồng dừng thì tự xoá số cũ, không hiển thị số "ma".
      up.bitrateKbps = (s.bitrateKbps != null && isFinite(Number(s.bitrateKbps))) ? Number(s.bitrateKbps) : null;
      up.speed = (s.speed != null && isFinite(Number(s.speed))) ? Number(s.speed) : null;
      up.restartHalted = s.restartHalted === true;   // circuit breaker (RL-PRC-003): tạm ngừng, đang tự thử lại (lỗi tạm thời)
      up.needsHuman = s.needsHuman === true;          // DỪNG HẲN vì LỖI NGUỒN/FILE — cần người sửa nguồn (không tự thử lại)
      up.haltReason = s.haltReason != null ? cheKhoaTrongCau(s.haltReason).slice(0, 200) : null;
      up.black = s.black === true;   // worker báo màn ĐEN liên tục ≥60s (đặt luôn để tự xóa khi hết đen)
      // liveSince = MỐC lần ĐẦU lên sóng của phiên này — KHÔNG reset khi tự khởi động lại (đọc để đặt
      // 1 lần; giữ update() để không tái tạo luồng đã xoá). Chủ động DỪNG mới xoá mốc (ở set_stream).
      if (s.status === "live") {
        const ref = firestore.collection(S_COL).doc(id);
        const cur = await curOf(id);
        if (!cur.exists) continue;   // luồng đã xoá → bỏ qua (không tái tạo)
        const cd = cur.data as any;
        // "Live từ" = mốc bắt đầu PHIÊN phát — KHÔNG được reset khi luồng tự KẾT NỐI LẠI:
        //  • Luồng HẸN GIỜ: mốc = đầu KHUNG GIỜ hiện tại (ổn định suốt khung; sang ngày/khung mới mới đổi).
        //  • Luồng 24/7 / thủ công: đặt 1 LẦN khi lên sóng lần đầu; giữ nguyên qua mọi lần tự khởi động lại.
        if (cd.control === "schedule" && cd.schedule) {
          const winStart = currentScheduleStartMs(cd.schedule, Date.now());
          const iso = winStart != null ? new Date(winStart).toISOString() : (cd.liveSince || nowISO());
          if (cd.liveSince !== iso) up.liveSince = iso;
        } else if (!cd.liveSince) {
          up.liveSince = nowISO();
        }
        // Luồng ĐÁNG LẼ đang chạy (chưa bị Dừng tay). Chặn báo cáo cũ của worker (gửi nốt sau khi
        // người dùng bấm Dừng) làm bắn nhầm thông báo "lên sóng ổn định"/"màn đen"/"đang tụt".
        const shouldBeLive = cd.desiredState === "live" || cd.control === "schedule";
        // THÔNG BÁO CHUÔNG: luồng LÊN SÓNG ỔN ĐỊNH (health chuyển sang "good") → báo chủ luồng. Giãn
        // 30 phút/luồng để luồng chớp tắt không dội "đã ổn định" liên tục.
        if (shouldBeLive && s.health === "good" && cd.health !== "good" && cd.createdBy) {
          const lastUp = Date.parse(String(cd.lastStableNotifyAt ?? "")) || 0;
          if (Date.now() - lastUp > 30 * 60 * 1000) {
            up.lastStableNotifyAt = nowISO();
            await notifyOutcome(firestore, [cd.createdBy], {
              eventType: "live_stable",
              label: `Luồng "${cd.name ?? "livestream"}" đã lên sóng ổn định ✅`,
              tone: "green", noPush: true,   // tin vui nhẹ → CHỈ chuông, không rung điện thoại
            }).catch(() => { /* thông báo lỗi không chặn */ });
          }
        }
        // ĐANG TỤT: tốc độ đẩy < thời gian thực (0.92×) kéo dài ≥90s → cờ slow + báo chủ luồng (giãn 30').
        // Chống báo oan: phải tụt LIÊN TỤC (đủ lâu), không kêu khi chớp một nhịp.
        if (shouldBeLive && up.speed != null && up.speed < 0.92) {
          if (!cd.slowSince) up.slowSince = nowISO();
          const since = Date.parse(String(cd.slowSince ?? up.slowSince ?? "")) || Date.now();
          up.slow = Date.now() - since > 90 * 1000;
          if (up.slow && cd.createdBy) {
            const lastSlow = Date.parse(String(cd.lastSlowNotifyAt ?? "")) || 0;
            if (Date.now() - lastSlow > 30 * 60 * 1000) {
              up.lastSlowNotifyAt = nowISO();
              const mbps = up.bitrateKbps != null ? Math.round(up.bitrateKbps / 100) / 10 : null;
              await notifyOutcome(firestore, [cd.createdBy], {
                eventType: "live_incident",
                label: `Luồng "${cd.name ?? "livestream"}" đang TỤT tốc độ (${up.speed}×${mbps != null ? ` · ${mbps} Mbps` : ""}) — nghi nghẽn băng thông/CPU, người xem có thể bị giật.`,
                tone: "amber", pushCategory: "urgent",
              }).catch(() => { /* thông báo lỗi không chặn */ });
            }
          }
        } else { up.slow = false; up.slowSince = null; }
        // MÀN ĐEN: worker báo đen ≥60s. Người dùng muốn chỉ cảnh báo khi đen KÉO DÀI TRÊN 3 PHÚT.
        // Máy chủ đếm từ lúc worker bắt đầu báo đen (blackSince); chỉ báo khi đủ ~3 phút (60s worker +
        // 120s ở đây). Không đụng worker (khỏi khởi động lại luồng). Giãn 30 phút chống dội.
        if (shouldBeLive && s.black === true && !cd.allowBlack) {
          if (!cd.blackSince) up.blackSince = nowISO();
          const bSince = Date.parse(String(cd.blackSince ?? up.blackSince ?? "")) || Date.now();
          const blackLongEnough = Date.now() - bSince >= 120 * 1000;   // +120s ≈ tổng 3 phút đen thật
          if (blackLongEnough && cd.createdBy) {
            const lastB = Date.parse(String(cd.lastBlackNotifyAt ?? "")) || 0;
            if (Date.now() - lastB > 30 * 60 * 1000) {
              up.lastBlackNotifyAt = nowISO();
              await notifyOutcome(firestore, [cd.createdBy], {
                eventType: "live_black",
                label: `Luồng "${cd.name ?? "livestream"}" MÀN ĐEN kéo dài (trên 3 phút) — kiểm tra video/nguồn. Nếu hình tối/đen CHỦ Ý, vào Live Rise bấm "✓ Nền đen chủ ý" ở cảnh báo.`,
                tone: "amber", pushCategory: "urgent",
              }).catch(() => { /* thông báo lỗi không chặn */ });
            }
          }
        } else if (s.black !== true) { up.blackSince = null; }
        // GHI-KHI-ĐỔI (Giai đoạn 1, sau cờ RISE_LIVE_WRITE_ON_CHANGE): luồng ổn định thì KHÔNG ghi lại
        // mỗi nhịp (~20s) — chỉ ghi khi có thay đổi ĐÁNG KỂ (status/health/lỗi/khởi động lại/đen/tụt/mốc…)
        // HOẶC đã quá 120s chưa "điểm danh" (để giữ tươi). Số đo thời gian thực (bitrate/speed/uptime) KHÔNG
        // tính là thay đổi — nếu tính thì tick nào cũng khác → ghi liên tục vô nghĩa. Cắt ~80% lượt ghi khi
        // scale lên 300 luồng. Mặc định TẮT → hành vi cũ (ghi mỗi nhịp).
        if (process.env.RISE_LIVE_WRITE_ON_CHANGE === "1") {
          const SKIP = new Set(["lastHeartbeatAt", "bitrateKbps", "speed", "uptimeSec"]);
          let changed = false;
          for (const k of Object.keys(up)) {
            if (SKIP.has(k)) continue;
            const nv = (up as any)[k], ov = (cd as any)[k];
            if (nv !== ov && !(nv == null && ov == null)) { changed = true; break; }
          }
          const lastHb = Date.parse(String(cd.lastHeartbeatAt ?? "")) || 0;
          const hbStale = Date.now() - lastHb >= WRITE_ON_CHANGE_REFRESH_SEC * 1000;
          if (!changed && !hbStale) continue;   // luồng ổn định, vừa điểm danh → GIỮ nguyên bản ghi, đỡ 1 lượt ghi
        }
        await ref.update(up).catch(() => { /* doc đã xoá */ });
      } else {
        await firestore.collection(S_COL).doc(id).update(up).catch(() => { /* doc đã xoá → bỏ qua */ });
      }
    }

    // 3a) NHẬT KÝ SỰ CỐ: worker báo các lần luồng rớt → tự khởi động lại (kèm số giây gián đoạn).
    //     Gộp theo luồng, ghi vào stream doc (giữ 10 gần nhất) để giao diện hiện timeline phục hồi.
    const incByStream: Record<string, any[]> = {};
    for (const ev of (Array.isArray(body.incidents) ? body.incidents : [])) {
      const sid = String(ev.streamId ?? ""); if (!sid) continue;
      // ĐÓNG DẤU MÁY (30/08/2026). Bản ghi sự cố worker gửi về chỉ có {lúc nào, mất bao lâu, lý do} —
      // KHÔNG có máy. Giao diện phải lấy `machineId` HIỆN TẠI của luồng để hiển thị, nên luồng nào
      // chuyển máy là TOÀN BỘ lịch sử nhảy sang máy mới (Chủ Rise Group: sự cố ở VPS 03, chuyển sang
      // VPS 05, nhật ký ghi VPS 05 → bộ lọc theo máy đếm nhầm, nhìn tưởng máy mới hay hỏng).
      // Máy chủ ĐÃ BIẾT máy nào đang báo — nó nằm ngay trong yêu cầu này. Đóng dấu tại đây là xong,
      // KHÔNG cần đụng worker, KHÔNG cần cập nhật VPS.
      (incByStream[sid] ??= []).push({ kind: String(ev.kind ?? "restart"), at: String(ev.at ?? nowISO()), downSec: Math.max(0, Number(ev.downSec) || 0), reason: String(ev.reason ?? "").slice(0, 200), machineId });
    }
    for (const [sid, evs] of Object.entries(incByStream)) {
      const ref = firestore.collection(S_COL).doc(sid);
      const cur = await curOf(sid);
      if (!cur.exists) continue;
      const scur: any = cur.data;
      const prev: any[] = Array.isArray(scur.recentIncidents) ? scur.recentIncidents : [];
      const merged = [...evs, ...prev].slice(0, 10);   // mới nhất lên đầu, giữ 10
      const upd: any = { recentIncidents: merged, incidentCount: (Number(scur.incidentCount) || 0) + evs.length };
      // THÔNG BÁO CHUÔNG cho chủ luồng khi luồng gián đoạn — GIÃN 60 phút/luồng (luồng chớp tắt liên tục
      // KHÔNG dội thông báo). Dùng cơ chế thông báo chung (channelEvents + push).
      const lastN = Date.parse(String(scur.lastIncidentNotifyAt ?? "")) || 0;
      if (scur.createdBy && Date.now() - lastN > 60 * 60 * 1000) {
        upd.lastIncidentNotifyAt = nowISO();
        const rs = String(evs[0]?.reason ?? "").trim();
        // Blip NHẸ (tự khỏi nhanh, 1 lần) → CHỈ chuông (khỏi rung điện thoại). Chỉ đẩy điện thoại khi
        // gián đoạn ĐÁNG KỂ: tổng thời gian rớt ≥ 30s HOẶC rớt ≥ 2 lần trong đợt (nghi vấn đề thật).
        const totalDown = evs.reduce((a: number, e: any) => a + (Number(e.downSec) || 0), 0);
        const significant = totalDown >= 30 || evs.length >= 2;
        await notifyOutcome(firestore, [scur.createdBy], {
          eventType: "live_incident",
          label: `Luồng "${scur.name ?? "livestream"}" vừa gián đoạn${rs ? ` (${rs})` : ""} — hệ thống đã tự phục hồi. Kiểm tra nếu lặp lại.`,
          tone: "amber", pushCategory: "urgent", noPush: !significant,
        }).catch(() => { /* thông báo lỗi không chặn luồng chính */ });
      }
      await ref.update(upd).catch(() => { /* doc đã xoá */ });
    }

    // 3b) Đăng ký VIDEO TẢI THẲNG TỪ MÁY (tool nén sẵn) → tạo bản ghi "sẵn sàng" (KHÔNG nén lại).
    //     Doc id = id file worker đặt → khớp file assets/<id>.mp4 khi phát. createdBy = người tải (phạm vi).
    // ⚠ VIDEO VỪA TẢI LÊN PHẢI CÓ MẶT TRONG DANH SÁCH TRẢ VỀ NGAY NHỊP NÀY (30/08/2026).
    //
    // MẤT DỮ LIỆU THẬT đã đo được: 2 video Chủ Rise Group tải thẳng lên VPS 03 NEW (296 MB và 223 MB)
    // BIẾN MẤT khỏi ổ trong khi Firestore vẫn ghi "sẵn sàng". Video CHÉP từ máy khác thì còn nguyên.
    //
    // Vì sao chỉ video TẢI-THẲNG dính:
    //   · dòng 84  — máy chủ CHỤP danh sách video của máy (chụp TRƯỚC)
    //   · dòng này — máy chủ mới TẠO bản ghi cho video vừa tải (SAU khi đã chụp)
    //   · mục 4    — gửi danh sách về worker, dựng từ ảnh chụp CŨ → THIẾU video vừa tải
    //   · worker   — POST thành công là BỎ NGAY video khỏi hàng chờ được bảo vệ, rồi dọn ổ theo
    //                danh sách vừa nhận → không thấy tên nó → XOÁ ĐÚNG FILE VỪA NHẬN.
    // Video chép/tải từ link không dính vì bản ghi được tạo TRƯỚC, nên luôn có trong ảnh chụp.
    //
    // Sửa: gom id các video vừa đăng ký trong chính nhịp này, rồi CỘNG THÊM vào danh sách trả về ở
    // mục 4. Sửa ở máy chủ nên KHÔNG phải kéo lại worker, KHÔNG chớp sóng.
    const vuaTaiLen: any[] = [];
    for (const u of (Array.isArray(body.uploaded) ? body.uploaded : [])) {
      const id = String(u.id ?? ""); if (!id) continue;
      const aref = firestore.collection(A_COL).doc(id);
      const existed = (await aref.get().catch(() => null))?.exists;   // đã đăng ký trước chưa (để báo đúng 1 lần)
      const uploader = String(u.uploaderEmail ?? "").toLowerCase();
      await aref.set({
        name: String(u.name ?? "Video tải lên").slice(0, 120),
        presetId: String(u.presetId ?? ""), machineId, status: "ready", source: "upload",
        createdBy: uploader, sizeMb: Number(u.sizeMb) || 0,
        width: Number(u.width) || 0, height: Number(u.height) || 0, durationSec: Number(u.durationSec) || 0,
        createdAt: nowISO(),
      }, { merge: true });
      vuaTaiLen.push({ id, name: String(u.name ?? "Video tải lên").slice(0, 120), presetId: String(u.presetId ?? "") });
      // THÔNG BÁO CHUÔNG: video SẴN SÀNG → báo người tải (chỉ 1 lần, lúc đăng ký mới).
      if (!existed && uploader) {
        await notifyOutcome(firestore, [uploader], {
          eventType: "live_asset_ready",
          label: `Video "${String(u.name ?? "").slice(0, 80) || "tải lên"}" đã sẵn sàng — có thể tạo luồng phát.`,
          tone: "green", pushCategory: "urgent",
        }).catch(() => { /* thông báo lỗi không chặn */ });
      }
    }

    // 3c) ĐỐI CHIẾU KHO VIDEO — SỔ NÓI CÓ, MÁY CÓ THẬT KHÔNG? (30/08/2026 — Chủ Rise Group duyệt)
    //
    // VÌ SAO CẦN. Sự cố 30/08: sổ ghi 2 video "sẵn sàng" trên VPS 03 NEW nhưng file đã bị xoá khỏi ổ.
    // Luồng dùng chúng đứng im ở "Chờ chạy" KHÔNG BÁO GÌ (worker gặp thiếu video thì lặng lẽ bỏ qua).
    // Chủ Rise Group phải tự phát hiện rồi ngồi đoán "hay do video sai định dạng". Cần hệ tự thấy.
    //
    // CÁCH: worker VỐN ĐÃ báo về danh sách video nó thật sự đang giữ (body.assets) — chỉ cần đem so
    // với sổ. Không thêm việc gì cho worker, không cần kéo lại VPS.
    //
    // BA ĐIỀU PHẢI CẨN THẬN, nếu không sẽ báo nhầm hàng loạt:
    //  1. Worker VỪA KHỞI ĐỘNG LẠI thì bộ nhớ của nó trống → báo về rỗng → nhìn như mất sạch video.
    //     Nó tự nhận lại trong 1–2 nhịp. Vì vậy chỉ GHI NHẬN mốc thời điểm, KHÔNG kết luận ngay;
    //     cảnh báo chỉ bắn khi lệch KÉO DÀI (ngưỡng ở lib/live-alerts.ts).
    //  2. Chỉ soi video sổ ghi "sẵn sàng". Video đang tải/đang nén dĩ nhiên chưa có trên ổ.
    //  3. Bỏ qua video VỪA ĐĂNG KÝ trong chính nhịp này — worker phải đến nhịp sau mới báo về.
    try {
      const idWorker = new Set(bodyAssets.map((a: any) => String(a.id ?? "")).filter(Boolean));
      const vuaTaiIds = new Set(vuaTaiLen.map((u) => u.id));
      const thieu: string[] = [];
      for (const d of (aSnapChung?.docs ?? [])) {
        const a: any = aCur?.get(d.id) ?? (d.data() as any);
        if (String(a.status ?? "") !== "ready") continue;
        if (vuaTaiIds.has(d.id) || idWorker.has(d.id)) continue;
        thieu.push(d.id);
      }
      const mNow: any = (await mRef.get().catch(() => null))?.data() ?? {};
      const cu: string[] = Array.isArray(mNow.assetMissing) ? mNow.assetMissing : [];
      // GHI LẦN ĐẦU DÙ KHỚP — để CHỨNG MINH ĐƯỢC phép đối chiếu có thật sự chạy.
      // Nếu chỉ ghi khi lệch thì ô này trống trong cả hai trường hợp "khớp" và "chưa bao giờ chạy" —
      // không phân biệt được, tức là một cái lưới an toàn KHÔNG KIỂM CHỨNG ĐƯỢC. Ghi một lần lúc đầu
      // (rồi thôi) tốn đúng 1 lượt ghi cho mỗi máy, đổi lại lúc nào cũng soi được nó còn sống hay không.
      const chuaTungChay = mNow.assetMissing === undefined;
      const doiKhac = chuaTungChay || thieu.length !== cu.length || thieu.some((x) => !cu.includes(x));
      if (doiKhac) {
        // GHI KHI ĐỔI: danh sách y như cũ thì không ghi lại (giữ nguyên mốc `since` để đo được đã lệch bao lâu).
        await mRef.set(thieu.length
          ? { assetMissing: thieu.slice(0, 50), assetMissingSince: (cu.length ? (mNow.assetMissingSince ?? nowISO()) : nowISO()) }
          : { assetMissing: [], assetMissingSince: null }, { merge: true });
      }
    } catch { /* đối chiếu hỏng KHÔNG được chặn nhịp làm việc của máy */ }

    // 4) Trả về DANH SÁCH MONG MUỐN cho MÁY này. Luồng: DÙNG LẠI ảnh chụp đầu nhịp (sMap) nếu đã đọc —
    //    khỏi đọc lại toàn bộ luồng lần 2. Assets vẫn đọc (cho danh sách nén/tải).
    // DÙNG LẠI kết quả đã đọc ở đầu nhịp (aSnapChung) — KHÔNG hỏi Firestore lần hai. Nếu lần đọc đầu
    // hỏng (aSnapChung = null) thì mới hỏi lại, để không bao giờ gửi xuống máy một danh sách rỗng oan.
    const aSnap = aSnapChung ?? await firestore.collection(A_COL).where("machineId", "==", machineId).limit(500).get().catch(() => null);
    const sSnap = sMap ? null : await firestore.collection(S_COL).where("machineId", "==", machineId).limit(1000).get().catch(() => null);
    // Danh sách luồng dùng chung (mục 4b move + desired list): ưu tiên ảnh chụp đã đọc 1 lần đầu nhịp.
    const streamDocs: Array<{ id: string; data: () => any }> = sMap
      ? Array.from(sMap.entries()).map(([id, data]) => ({ id, data: () => data }))
      : (sSnap?.docs ?? []).map((d) => ({ id: d.id, data: () => d.data() }));
    const assets = (aSnap?.docs ?? []).map((d) => {
      // Ưu tiên bản ĐÃ CẬP NHẬT trong nhịp này (aCur) — bằng đúng kết quả của việc đọc lại.
      const a: any = aCur?.get(d.id) ?? (d.data() as any); const p = resolveLivePreset(String(a.presetId ?? ""));
      return {
        id: d.id, status: String(a.status ?? "pending"),
        driveFileId: driveIdFromUrl(String(a.sourceUrl ?? "")),
        // COPY VPS->VPS: neu la ban SAO tu VPS khac -> agent keo thang file da chuan tu nguon (giu chat luong,
        // khong qua Drive). copyFromUrl luu san dia chi VPS nguon luc tao ban sao.
        // `optional` = bản sao này do MÁY CHỦ tự chọn thay cho tải Drive (đỡ đốt hạn mức Drive, mục E
        // V71.17) — chép hỏng thì worker LUI VỀ tải Drive như cũ. Copy TAY (người bấm) không có cờ này
        // nên vẫn báo lỗi rõ, không âm thầm lui về Drive (Drive hạ chất lượng file lớn).
        copyFrom: a.copyFromUrl ? { url: String(a.copyFromUrl), assetId: String(a.copyFromAssetId ?? ""), optional: a.copyOptional === true } : null,
        preset: p ? { width: p.width, height: p.height, fps: p.fps, videoBitrateKbps: p.videoBitrateKbps, audioBitrateKbps: p.audioBitrateKbps, keepOriginal: !!p.keepOriginal } : null,
      };
    });
    // CỘNG THÊM video VỪA ĐĂNG KÝ trong chính nhịp này (xem khối giải thích ở mục 3b). Ảnh chụp ở
    // dòng 84 được chụp TRƯỚC khi tạo bản ghi nên không thể có chúng — thiếu là worker xoá mất file.
    for (const u of vuaTaiLen) {
      if (assets.some((x: any) => String(x.id) === u.id)) continue;   // đã có (đăng ký lại) → khỏi thêm
      const p = resolveLivePreset(String(u.presetId ?? ""));
      assets.push({
        id: u.id, status: "ready", driveFileId: "", copyFrom: null,
        preset: p ? { width: p.width, height: p.height, fps: p.fps, videoBitrateKbps: p.videoBitrateKbps, audioBitrateKbps: p.audioBitrateKbps, keepOriginal: !!p.keepOriginal } : null,
      });
    }
    const nowMs = Date.now();

    // 4b) TIẾN các lần CHUYỂN MÁY (bàn giao 2 pha AN TOÀN — KHÔNG bao giờ 2 máy cùng phát). Chạy trên
    //     heartbeat của cả máy nguồn lẫn đích. Blast-radius = CHỈ luồng ĐANG chuyển (moveState set) —
    //     luồng thường không dính. moveState: stopping_source → (nguồn báo đã dừng) → CUTOVER machineId
    //     sang đích → starting_target → (đích báo live) → done. Quá hạn → HOÀN TÁC về nguồn.
    const reportedStatus: Record<string, string> = {};
    for (const rs of (Array.isArray(body.streams) ? body.streams : [])) { if (rs?.id) reportedStatus[String(rs.id)] = String(rs.status ?? ""); }
    const movedAway = new Set<string>();
    const clearMove = { moveState: null, moveSourceId: null, moveTargetId: null, moveExecId: null, moveStartedAt: null, moveDeadlineAt: null, moveTargetAssetIds: null, movePrevAssetIds: null, moveType: null, moveVerifyAt: null };
    // Tên máy (đọc 1 doc theo id) — chỉ gọi khi 1 lần chuyển XONG (hiếm) nên không tốn kém.
    const machineNameById = async (id: string): Promise<string> => {
      if (!id) return "máy";
      try { const d = await firestore.collection(M_COL).doc(String(id)).get(); return String((d.data() as any)?.name ?? id); } catch { return String(id); }
    };
    const finishMove = async (sid: string, s: any, ytAt: string | null) => {
      await firestore.collection(S_COL).doc(sid).set({ ...clearMove, updatedAt: nowISO() }, { merge: true });
      if (s.moveExecId) await firestore.collection("liveMoveExecutions").doc(s.moveExecId).set({ completedAt: nowISO(), state: "done", result: "success", youtubeConfirmedAt: ytAt }, { merge: true }).catch(() => {});
      // Nêu RÕ từ máy nào sang máy nào (Chủ Rise Group đề nghị) — dễ theo dõi hơn "sang máy mới".
      const [fromN, toN] = await Promise.all([machineNameById(String(s.moveSourceId ?? "")), machineNameById(String(s.moveTargetId ?? ""))]);
      if (s.createdBy) notifyOutcome(firestore, [s.createdBy], { eventType: "live_move_done", label: `✅ Đã chuyển luồng "${String(s.name ?? "").slice(0, 60)}" từ "${fromN}" sang "${toN}" thành công — đang phát bình thường${ytAt ? " (YouTube đã nhận lại)" : ""}.`, tone: "green", pushCategory: "urgent" }).catch(() => {});
    };
    const rollbackMove = async (sid: string, s: any) => {
      const emergency = String(s.moveType ?? "").includes("emergency") || String(s.moveType ?? "") === "automatic_failover";
      if (emergency) {
        // KHẨN CẤP (máy nguồn đã chết): KHÔNG hoàn tác về nguồn. Xoá cờ move, giữ máy đích tự thử
        // tiếp (đã có video), báo sự cố để người xử lý nếu vẫn không lên.
        await firestore.collection(S_COL).doc(sid).set({ ...clearMove, cooldownUntil: new Date(Date.now() + 10 * 60000).toISOString(), updatedAt: nowISO() }, { merge: true });
        if (s.moveExecId) await firestore.collection("liveMoveExecutions").doc(s.moveExecId).set({ completedAt: nowISO(), state: "failed", result: "failover_failed", failureReason: "đích không lên sóng trong hạn" }, { merge: true }).catch(() => {});
        if (s.createdBy) notifyOutcome(firestore, [s.createdBy], { eventType: "live_failover_failed", label: `⚠ Tự động cứu luồng "${String(s.name ?? "").slice(0, 60)}" CHƯA lên sóng được — cần kiểm tra tay.`, tone: "red", pushCategory: "urgent" }).catch(() => {});
        return;
      }
      const pIds: string[] | null = Array.isArray(s.movePrevAssetIds) && s.movePrevAssetIds.length ? s.movePrevAssetIds : null;
      // CHỦ ĐỘNG: KHÔI PHỤC máy nguồn + assetId gốc (đã đổi sang đích lúc cutover) → nguồn phát lại.
      await firestore.collection(S_COL).doc(sid).set({ machineId: s.moveSourceId ?? s.machineId, ...(pIds ? { assetIds: pIds, assetId: pIds[0] } : {}), ...clearMove, updatedAt: nowISO() }, { merge: true });
      if (s.moveExecId) await firestore.collection("liveMoveExecutions").doc(s.moveExecId).set({ completedAt: nowISO(), state: "failed", result: "rolled_back", failureReason: "quá hạn - đích không lên sóng" }, { merge: true }).catch(() => {});
    };
    for (const d of streamDocs) {
      const s: any = d.data(); const sid = d.id; const ms = String(s.moveState ?? "");
      if (!ms) continue;
      const overdue = s.moveDeadlineAt && nowMs > Date.parse(s.moveDeadlineAt);
      if (ms === "stopping_source" && String(s.machineId) === machineId) {
        const st = reportedStatus[sid];
        if (st === "live") { if (overdue) await rollbackMove(sid, s); continue; }   // chưa dừng hẳn → chờ (hoặc hoàn tác nếu quá hạn)
        // Nguồn ĐÃ DỪNG → CUTOVER: giao quyền sang đích (bump fencing token) + ĐỔI assetId sang bản
        // trên máy đích (mỗi máy 1 id riêng cho cùng video) rồi đích tự bật.
        const tIds: string[] = Array.isArray(s.moveTargetAssetIds) && s.moveTargetAssetIds.length ? s.moveTargetAssetIds : [];
        await firestore.collection(S_COL).doc(sid).set({ machineId: s.moveTargetId, fencingToken: (Number(s.fencingToken) || 0) + 1, moveState: "starting_target", ...(tIds.length ? { assetIds: tIds, assetId: tIds[0] } : {}), updatedAt: nowISO() }, { merge: true });
        if (s.moveExecId) await firestore.collection("liveMoveExecutions").doc(s.moveExecId).set({ sourceStoppedAt: nowISO(), targetStartedAt: nowISO(), state: "starting_target" }, { merge: true }).catch(() => {});
        movedAway.add(sid);
      } else if ((ms === "starting_target" || ms === "verifying") && String(s.machineId) === machineId) {
        const st = reportedStatus[sid];
        if (st === "live" && ms === "starting_target") {
          // Máy đích ĐÃ lên sóng → sang "verifying": chờ YouTube xác nhận nhận lại (cron làm nếu kênh có L3).
          await firestore.collection(S_COL).doc(sid).set({ moveState: "verifying", moveVerifyAt: nowISO(), updatedAt: nowISO() }, { merge: true });
        } else if (st === "live" && ms === "verifying") {
          // Quá ân hạn xác nhận (không có L3 / YouTube chậm) → vẫn chốt XONG vì đích ĐANG phát thật.
          const vAt = s.moveVerifyAt ? Date.parse(s.moveVerifyAt) : 0;
          if (!vAt || (nowMs - vAt) > VERIFY_GRACE_SEC() * 1000) await finishMove(sid, s, null);
        } else if (overdue) { await rollbackMove(sid, s); }
      }
    }

    const streams = streamDocs.filter((d) => !movedAway.has(d.id)).map((d) => {
      const s: any = d.data();
      // Máy đã bị NGẮT (forceOffline) → dừng hết. Bàn giao: luồng "stopping_source" trên máy NGUỒN → dừng.
      const desired = forceOff
        ? "stopped"
        // YouTube báo bị CHẶN/ĐÌNH CHỈ/kết thúc (ytIssue đã xác nhận) → DỪNG đẩy (đừng đẩy vào buổi đã chết);
        // cần người kiểm tra YouTube Studio rồi Lên sóng lại. (Chủ Rise Group chốt.)
        : (s.ytIssue
            ? "stopped"
            : ((String(s.moveState ?? "") === "stopping_source" && String(s.machineId) === machineId)
            ? "stopped"
            : (s.control === "schedule"
                ? (isWithinSchedule(s.schedule, nowMs) ? "live" : "stopped")
                : (s.desiredState === "live" ? "live" : "stopped"))));
      return {
        id: d.id, assetId: String(s.assetId ?? ""),
        assetIds: Array.isArray(s.assetIds) ? s.assetIds.map((x: any) => String(x)) : undefined,   // danh sách phát (nếu có)
        playMode: s.playMode === "random" ? "random" : "sequence",
        desiredState: desired,
        mode: String(s.mode ?? "stream-247"),   // để agent biết Live Pub (rớt = kết thúc, không thử lại) vs 24/7
        rtmpBase: String(s.rtmpBase ?? YOUTUBE_RTMP_BASE), streamKey: String(s.streamKey ?? ""),
        // Dự phòng nhiều VPS: luồng TỰ ĐỘNG CHUYỂN mới bật "tự dừng khi cô lập" (mặc định tắt).
        leaseEnabled: streamLeaseEnabled(s),
      };
    });
    // pollSeconds = NHỊP HEARTBEAT (agent tự đọc). Giãn 10→20s để CẮT ~50% lượt đọc/ghi Firestore của Rise Live
    // (chi phí lớn nhất). KHÔNG làm chậm khôi phục: agent có supervisor cục bộ ~2s lo tự-khởi-động-lại tại VPS;
    // chỉ server cập nhật trạng thái + bấm Lên sóng/Dừng hiệu lực chậm thêm ~10s (không đáng kể). Agent tự áp,
    // KHÔNG cần cập nhật lại VPS.
    // NHỊP ĐẨY ẢNH xem trước (giây/luồng). Trước đây worker vừa chụp vừa đẩy mỗi 45s → ~100 luồng dội
    // ~140 ảnh/phút lên /api/live/agent-thumb → route NẶNG NHẤT, ăn hết CPU Cloud Run, làm CHẬM TOÀN APP
    // Rise Work (không riêng Live). Nay TÁCH ĐÔI ở worker r2.31: dò MÀN ĐEN vẫn 60s tại VPS (không tốn
    // máy chủ), chỉ ĐẨY ảnh giãn ra — mặc định 300s (5 phút). Chỉnh bằng biến RISE_LIVE_THUMB_PUSH_SEC,
    // KHÔNG cần cập nhật lại VPS. (Worker cũ hơn r2.31 bỏ qua giá trị này.)
    const thumbPushSec = nhipDayAnh();   // MOT nguon duy nhat: lib/live-thumb-store.ts

    // ── NHỊP THÍCH ỨNG: nhanh khi VỪA CÓ THAY ĐỔI, chậm khi đã ổn định ──────────
    // Vì sao (Chủ Rise Group 29/08): bấm "Bật" xong phải chờ khá lâu mới thấy luồng
    // chạy. Không phải một nhịp chờ mà BA nhịp cộng dồn: máy nhận lệnh (≤20s) →
    // máy báo trạng thái về (≤20s) → giao diện làm mới (≤20s) ⇒ trung bình ~33 giây
    // dù luồng đã thật sự chạy từ giây ~13.
    //
    // Cách xử: máy nào VỪA có thay đổi trong ~60 giây gần đây thì bảo nó hỏi lại
    // sau 3 giây; ổn định trở lại thì tự giãn về 20 giây. Chi phí thêm gần như
    // bằng 0 vì chỉ nhanh lên ĐÚNG LÚC có người thao tác (99% thời gian vẫn 20s).
    // Agent tự đọc giá trị này mỗi vòng → KHÔNG cần cập nhật lại VPS.
    // Nhip lay tu MOT NGUON DUY NHAT (lib/live-cadence.ts) — truoc day chep cung o day va chep
    // lai o cho hien chi phi, nen hai noi lech nhau ma khong ai biet (xem giai thich trong file do).
    const NHANH_SEC = POLL_FAST_SEC, CHAM_SEC = POLL_SLOW_SEC, CUA_SO_MS = POLL_FAST_WINDOW_MS;
    let vuaDoi = false;
    for (const d of streamDocs) {
      const x: any = d.data();
      const t = Date.parse(String(x.updatedAt ?? "")) || 0;
      // Chỉ tính luồng CỦA MÁY NÀY (kể cả luồng vừa được dời SANG đây).
      if (String(x.machineId) !== machineId && String(x.moveTargetId ?? "") !== machineId) continue;
      if (t && nowMs - t <= CUA_SO_MS) { vuaDoi = true; break; }
    }
    if (!vuaDoi) {
      // Video vừa được thêm/sao chép sang máy này cũng cần agent bắt tay ngay.
      vuaDoi = assets.some((a: any) => {
        const t = Date.parse(String(a.createdAt ?? "")) || 0;
        return t && nowMs - t <= CUA_SO_MS;
      });
    }
    const pollSeconds = vuaDoi ? NHANH_SEC : CHAM_SEC;

    return NextResponse.json({ ok: true, machineId, assets, streams, pollSeconds, leaseGraceSec: LEASE_GRACE_SEC(), thumbPushSec });
  } catch (error: any) {
    console.error("POST /api/live/agent failed", error);
    return NextResponse.json({ error: error?.message ?? "Lỗi máy chủ." }, { status: 500 });
  }
}
