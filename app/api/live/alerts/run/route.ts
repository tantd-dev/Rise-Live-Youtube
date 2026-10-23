// RISE LIVE — CẢNH BÁO EMAIL (endpoint CHẠY NỀN, Cloud Scheduler gọi ~mỗi 3-5 phút). Tính cảnh
// báo hiện tại (cùng logic bảng Tổng quan) → gửi EMAIL cho Admin/BLĐ, có CHỐNG SPAM (mỗi loại
// cảnh báo chỉ gửi lại sau 30 phút). Bảo vệ bằng CÙNG secret REPORT_REMINDER_SECRET.
// Lịch (đặt 1 lần):
//   gcloud scheduler jobs create http rise-live-alerts \
//     --schedule="*/5 * * * *" --uri="https://<DIA-CHI-MAY-CHU-CUA-BAN>/api/live/alerts/run" \
//     --http-method=POST --headers="x-cron-secret=<REPORT_REMINDER_SECRET>" --location=asia-southeast1
import { NextResponse } from "next/server";
import { firestore } from "@/lib/firestore";
import { computeLiveAlerts, nhipLuong, emailWorthyAlerts, machineOnline, streamFresh } from "@/lib/live-alerts";
import { xacMinhMayChet } from "@/lib/live-machine-probe";
import { nenTuDon } from "@/lib/live-copy-cleanup";
import { isWithinSchedule } from "@/lib/live-catalog";
import { extractYouTubeVideoId } from "@/lib/youtube-check";
import { notifyOutcome } from "@/lib/notify";
import { getConnectionRefreshToken } from "@/lib/live-youtube-store";
import { accessTokenFromRefresh, fetchChannelLiveState, ReauthNeeded } from "@/lib/live-youtube-sync";

// GIỚI HẠN ĐỌC — phải LỚN HƠN HẲN số bản ghi thật, và phải BÁO khi chạm trần.
// Vì sao (rà soát 29/08/2026): trần cũ 1.000 video. Ở 500 luồng ước ~735 video —
// dưới trần nhưng chỉ dư 1,36 lần; tăng tỉ lệ luồng ưu tiên là vượt. Vượt thì
// Firestore CẮT ÂM THẦM, không báo gì: máy quét thấy thiếu bản dự phòng → cảnh
// báo giả hàng loạt, và tệ hơn là TỪ CHỐI cứu luồng thật sự có dự phòng.
const TRAN_DOC = { assets: 8000, streams: 8000, machines: 500 };
function canhBaoChamTran(ten: string, so: number, tran: number) {
  if (so >= tran) console.error(`[RISE LIVE] CHAM TRAN DOC ${ten}: ${so}/${tran} — danh sach CO THE bi cat, ket qua khong day du. Nang TRAN_DOC.`);
}

export const dynamic = "force-dynamic";

// Email PHỤC HỒI (tin vui) — khi VPS mất kết nối rồi ONLINE lại. Khung XANH, phân biệt với email cảnh báo đỏ.
async function sendRecoveryEmail(to: string[], bodyHtml: string) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim() || "Rise Work <no-reply@<TEN-MIEN-CUA-BAN>>";
  if (!apiKey || to.length === 0) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to, subject: "✅ Live Rise: VPS đã kết nối lại",
      html: `<div style="font-family:Arial,sans-serif;color:#152237;max-width:600px;margin:auto">
        <h2 style="color:#0b7a3b">Live Rise — đã phục hồi</h2>
        <ul style="padding-left:18px">${bodyHtml}</ul>
        <p style="margin-top:16px"><a href="https://<DIA-CHI-MAY-CHU-CUA-BAN>" style="background:#0b1c35;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Mở Live Rise</a></p>
        <hr style="border:0;border-top:1px solid #e4eaf1;margin:24px 0"/><small>Email tự động — Copyright © Rise Group 2026</small>
      </div>`,
    }),
  }).catch(() => undefined);
}
const COOLDOWN_MS = 30 * 60 * 1000;   // mặc định: mỗi cảnh báo chỉ gửi lại sau 30 phút
// Sự cố CẦN NGƯỜI XỬ (không tự phục hồi: dừng-hẳn / chớp-tắt-đã-ngắt / Live Pub sập) → báo THƯA hẳn,
// gần như 1 lần/sự cố (tránh spam như ca gửi 5 mail/2h cho 1 luồng). Loại tự-phục-hồi giữ nhịp thường.
const cooldownFor = (kind: string): number =>
  (kind === "stream_needs_human" || kind === "stream_restart_halted") ? 6 * 60 * 60 * 1000
  : (kind === "stream_error") ? 2 * 60 * 60 * 1000
  : COOLDOWN_MS;
const NOTICE_COL = "liveAlertNotices"; // lưu lần gửi gần nhất theo fingerprint (chống spam)

async function recipients(): Promise<string[]> {
  const env = (process.env.RISE_LIVE_ALERT_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.length) return env;
  // Mặc định: các Admin (role admin).
  const snap = await firestore.collection("users").where("role", "==", "admin").limit(50).get().catch(() => null);
  return (snap?.docs ?? []).map((d) => String((d.data() as any).email ?? "")).filter(Boolean);
}

async function sendAlertEmail(to: string[], alerts: { level: string; text: string }[]) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim() || "Rise Work <no-reply@<TEN-MIEN-CUA-BAN>>";
  if (!apiKey || to.length === 0) return;
  const crit = alerts.filter((a) => a.level === "critical");
  const rows = alerts.map((a) => `<li style="margin:6px 0"><b style="color:${a.level === "critical" ? "#c0392b" : "#c98617"}">${a.level === "critical" ? "NGHIÊM TRỌNG" : "Cảnh báo"}</b> — ${a.text}</li>`).join("");
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to,
      subject: `🔴 Live Rise: ${crit.length ? crit.length + " sự cố nghiêm trọng" : alerts.length + " cảnh báo"}`,
      html: `<div style="font-family:Arial,sans-serif;color:#152237;max-width:600px;margin:auto">
        <h2 style="color:#0b1c35">Cảnh báo Live Rise</h2>
        <p>Hệ thống phát hiện ${alerts.length} vấn đề đang cần chú ý:</p>
        <ul style="padding-left:18px">${rows}</ul>
        <p style="margin-top:16px"><a href="https://<DIA-CHI-MAY-CHU-CUA-BAN>" style="background:#0b1c35;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Mở Live Rise để xử lý</a></p>
        <hr style="border:0;border-top:1px solid #e4eaf1;margin:24px 0"/>
        <small>Email tự động — Copyright © Rise Group 2026</small>
      </div>`,
    }),
  }).catch(() => undefined);
}

// Phai nghi LIEN TIEP du so lan moi tu danh dau -> CHONG BAO OAN mot nhip API truc trac.
// Dung CHUNG cho ca hai phep kiem YouTube (video bi go, va buoi phat cua tung luong het live).
const YT_MISS_TRIGGER = 2;

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.REPORT_REMINDER_SECRET || secret !== process.env.REPORT_REMINDER_SECRET) {
    return NextResponse.json({ error: "Không có quyền gọi endpoint này." }, { status: 401 });
  }
  if (process.env.RISE_WORK_LIVE !== "1") return NextResponse.json({ ok: true, skipped: "flag off" });
  try {
    const nowMs = Date.now();
    const [mSnap, aSnap, sSnap] = await Promise.all([
      firestore.collection("liveMachines").limit(TRAN_DOC.machines).get().catch(() => null),
      firestore.collection("liveAssets").limit(TRAN_DOC.assets).get().catch(() => null),
      firestore.collection("liveStreams").limit(TRAN_DOC.streams).get().catch(() => null),
    ]);
    // Báo NGAY nếu chạm trần: quá trần thì Firestore CẮT ÂM THẦM, mọi kết luận
    // phía sau (thiếu dự phòng / cứu được hay không) đều sai mà không ai biết.
    canhBaoChamTran("liveAssets", aSnap?.size ?? 0, TRAN_DOC.assets);
    canhBaoChamTran("liveStreams", sSnap?.size ?? 0, TRAN_DOC.streams);
    canhBaoChamTran("liveMachines", mSnap?.size ?? 0, TRAN_DOC.machines);
    const machines = (mSnap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) }));
    const assets = (aSnap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) }));
    // Tính scheduleActive (luồng hẹn giờ có đang trong khung giờ không) — để cảnh báo máy-chết KHÔNG bỏ
    // sót luồng hẹn giờ (chúng giữ desiredState="stopped" cả khi đang phát).
    const streams = (sSnap?.docs ?? []).map((d) => { const s: any = { id: d.id, ...(d.data() as any) }; if (s.control === "schedule" && s.schedule) s.scheduleActive = isWithinSchedule(s.schedule, nowMs); return s; });
    // ── TỰ DỌN XÁC COPY HỎNG (Chủ Rise Group yêu cầu 29/08/2026) ──────────────────
    // Máy nguồn mất mạng → người dùng bấm "Chuyển (tự copy)" → máy đích tạo bản ghi video rồi
    // báo lỗi kết nối. Bản ghi đó nằm lại MÃI và bắn cảnh báo, che mất cảnh báo thật (hôm 29/08
    // để lại 16 cái). Nay tự dọn sau 30 phút — đủ lâu để người vận hành kịp nhìn thấy chuyện gì
    // đã xảy ra, đủ sớm để không thành rác.
    // CHỈ dọn đúng loại đó: là bản sao đang chờ copy + lỗi KẾT NỐI. Video hỏng THẬT (lỗi tải/nén
    // từ Drive) KHÔNG bị đụng tới. Và KHÔNG bao giờ xoá video đang được luồng nào dùng.
    {
      const dangDung = new Set<string>();
      streams.forEach((s: any) => (Array.isArray(s.assetIds) ? s.assetIds : (s.assetId ? [s.assetId] : []))
        .forEach((x: any) => dangDung.add(String(x))));
      const xac = assets.filter((a: any) => nenTuDon(a, nowMs) && !dangDung.has(a.id));
      for (const a of xac) {
        await firestore.collection("liveAssets").doc(a.id).delete().catch(() => { /* đã xoá */ });
        const i = assets.findIndex((x: any) => x.id === a.id); if (i >= 0) assets.splice(i, 1);
      }
      if (xac.length) console.info(`[RISE LIVE] tu don ${xac.length} xac copy hong (qua 30 phut).`);
    }

    // XÁC MINH TRƯỚC KHI HÔ (30/08/2026): máy nào im quá ngưỡng thì GỌI THẲNG vào cổng worker để
    // biết nó thật sự chết hay chỉ là không gọi ra được. Dùng máy đang khoẻ làm MỐC ĐỐI CHỨNG — nếu
    // chính máy khoẻ cũng không gọi vào được thì lỗi nằm ở đường ra của hệ thống, không kết luận gì.
    // Chỉ chạy ở cron (mỗi 5 phút, vài mili giây mỗi máy), KHÔNG chạy ở màn Live.
    // BỎ QUA MÁY ĐANG BẢO TRÌ (30/08/2026): nó im là đúng ý người quản trị, gọi vào xác minh chỉ tốn
    // thời gian và vẫn không đổi kết quả (cảnh báo cho máy bảo trì đã tắt ở lib/live-alerts.ts).
    const nghiNgo = machines.filter((m: any) => !machineOnline(m, nowMs) && m.maintenance !== true
      && streams.some((s: any) => s.machineId === m.id && (s.desiredState === "live" || (s.control === "schedule" && s.scheduleActive))));
    const xacMinh = nghiNgo.length
      ? await xacMinhMayChet(nghiNgo.map((m: any) => ({ id: m.id, ip: m.ip })), machines.filter((m: any) => machineOnline(m, nowMs)).map((m: any) => ({ id: m.id, ip: m.ip })))
      : undefined;
    if (xacMinh) console.log("[live-alerts] xac minh may:", xacMinh.lyDo, "chet=", Array.from(xacMinh.chet).length, "song=", Array.from(xacMinh.songNhungKhongGoiVe).length, "tin duoc=", xacMinh.tinDuoc);
    const alerts = computeLiveAlerts(machines, streams, assets, nowMs, xacMinh);
    // EMAIL chỉ cho sự cố "phải xử ngay" (sập luồng/mất tín hiệu) — quota 100 mail/ngày. App vẫn
    // thấy MỌI cảnh báo (qua GET /api/live). Đây là lớp lọc trước khi gửi mail.
    const emailAlerts = emailWorthyAlerts(alerts);

    // Chống spam: chỉ gửi các cảnh báo CHƯA gửi trong 30 phút.
    const toSend: typeof alerts = [];
    for (const al of emailAlerts) {
      const ref = firestore.collection(NOTICE_COL).doc(al.fingerprint.replace(/[^\w:-]/g, "_"));
      const cur = await ref.get().catch(() => null);
      const last = cur?.exists ? Date.parse(String((cur.data() as any).lastSentAt ?? "")) : 0;
      if (!(Number.isFinite(last) && nowMs - last < cooldownFor(al.kind))) {
        toSend.push(al);
        await ref.set({ lastSentAt: new Date(nowMs).toISOString(), level: al.level, text: al.text }, { merge: true });
        // LƯU VẾT (30/08/2026). Cảnh báo cấp MÁY trước đây KHÔNG để lại dấu gì: nó là suy diễn của máy
        // chủ, không phải sự kiện worker báo về — nên nhật ký sự cố (chỉ ghi những gì worker báo) hoàn
        // toàn trống. Chủ Rise Group nhận cảnh báo "28 luồng đang tắt" lúc 01:15, vào kiểm thì không
        // luồng nào sao, nhật ký cũng không có gì → không cách nào truy lại chuyện đã xảy ra.
        if (al.kind === "machine_offline" && !cur?.exists) {
          const mid = al.fingerprint.split(":")[1] ?? "";
          const may = machines.find((x: any) => String(x.id) === mid);
          await firestore.collection("liveIncidentLog").add({
            streamId: "", streamName: "", machineId: mid, machineName: String(may?.name ?? ""), streamOwner: "",
            cause: "Máy ngừng báo cáo", reason: al.text.slice(0, 300),
            startedAt: new Date(nowMs).toISOString(), resolvedAt: null, resolution: "open",
            createdAt: new Date(nowMs).toISOString(),
          }).catch(() => { /* nhật ký lỗi không được chặn cảnh báo */ });
        }
      }
    }
    // EMAIL: CHỈ set nhỏ EMAIL_ALERT_KINDS (giữ quota 100 mail/ngày). KHÔNG mở rộng email.
    if (toSend.length) await sendAlertEmail(await recipients(), toSend);

    // PUSH ĐIỆN THOẠI cho BLĐ/Admin — báo MỌI sự cố NGHIÊM TRỌNG (level critical), ĐỘC LẬP với email
    // (không tốn quota mail). Cooldown RIÊNG theo fingerprint ("push_") → chỉ push khi có sự cố MỚI.
    const critAlerts = alerts.filter((a) => a.level === "critical");
    const adSnap = await firestore.collection("users").where("role", "==", "admin").limit(50).get().catch(() => null);
    const adminEmails = (adSnap?.docs ?? []).map((d) => String((d.data() as any).email ?? "").toLowerCase()).filter(Boolean);
    const pushNew: typeof alerts = [];
    for (const al of critAlerts) {
      if (al.kind === "yt_issue") continue;   // yt_issue đã được nhánh YouTube-check push riêng (owner+BLĐ) — khỏi push trùng
      const ref = firestore.collection(NOTICE_COL).doc(`push_${al.fingerprint}`.replace(/[^\w:-]/g, "_"));
      const cur = await ref.get().catch(() => null);
      const last = cur?.exists ? Date.parse(String((cur.data() as any).lastAt ?? "")) : 0;
      if (!(Number.isFinite(last) && nowMs - last < cooldownFor(al.kind))) { pushNew.push(al); await ref.set({ lastAt: new Date(nowMs).toISOString() }, { merge: true }); }
    }
    // NGƯỜI NHẬN: trước đây CHỈ admin → chủ luồng (Trưởng nhóm/nhân sự cầm kênh)
    // KHÔNG hề nhận thông báo về điện thoại dù chính họ là người phải xử lý
    // (Chủ Rise báo 28/08: "có cảnh báo ra màn hình nhưng không đẩy ra điện thoại").
    // Nay gửi cho admin + ĐÚNG chủ của luồng đang gặp sự cố.
    const chuLuongCuaCanhBao = (al: any): string[] => {
      const sid = String(al.fingerprint ?? "").split(":")[1] ?? "";
      const st = streams.find((x: any) => String(x.id) === sid);
      const e = String(st?.createdBy ?? "").toLowerCase();
      return e ? [e] : [];
    };
    const nguoiNhan = Array.from(new Set([
      ...adminEmails,
      ...pushNew.flatMap((al) => chuLuongCuaCanhBao(al)),
    ].filter(Boolean)));
    if (pushNew.length && nguoiNhan.length) await notifyOutcome(firestore, nguoiNhan, {
      eventType: "live_incident",
      label: `🔴 Rise Live: ${pushNew.length} sự cố NGHIÊM TRỌNG cần xử lý — ${String(pushNew[0].text).slice(0, 90)}${pushNew.length > 1 ? ` (+${pushNew.length - 1} nữa)` : ""}`,
      tone: "red", pushCategory: "urgent",
    }).catch(() => {});

    // ── SỔ NHỊP THEO ĐƠN VỊ (31/08/2026 — Chủ Rise Group duyệt cách rẻ) ──────────────────────
    // Ô "Nhịp Rise Live" trên Tổng quan cần biết cả đội đang thế nào. Nếu để màn Tổng quan tự
    // quét thì mỗi lần mở phải đọc đúng bằng SỐ LUỒNG của đơn vị (VD Âm nhạc 2 đang 87 luồng
    // → 87 lượt đọc mỗi lần mở). Nay cron này — vốn ĐÃ đọc toàn bộ luồng để tính cảnh báo —
    // gộp sẵn thành MỘT doc, màn Tổng quan chỉ đọc 1 lượt.
    // Chi phí thêm: đúng 1 lượt GHI mỗi 5 phút (~288 lượt/ngày) — không đáng kể.
    // Dùng CHUNG hàm nhipLuong với /api/my-work để hai nơi không bao giờ nói hai đằng.
    const nhipDonVi: Record<string, { tong: number; dangPhat: number; coVanDe: number }> = {};
    streams.forEach((s: any) => {
      const dv = String(s.createdByUnit ?? "").trim();
      if (!dv) return;                                    // luồng chưa có nhãn đơn vị → bỏ qua, không đoán
      const o = nhipDonVi[dv] ?? { tong: 0, dangPhat: 0, coVanDe: 0 };
      const n = nhipLuong(s, nowMs);
      o.tong += 1; if (n.dangPhat) o.dangPhat += 1; if (n.coVanDe) o.coVanDe += 1;
      nhipDonVi[dv] = o;
    });
    await firestore.collection("liveUnitSummary").doc("current").set({
      at: new Date(nowMs).toISOString(),
      // Có chạm trần đọc không — nếu có thì số này THIẾU, phải nói ra chứ không im lặng.
      capped: (sSnap?.size ?? 0) >= TRAN_DOC.streams,
      units: nhipDonVi,
    }, { merge: false }).catch(() => {});

    // SỔ tóm tắt sự cố NGHIÊM TRỌNG hiện tại (1 doc) → "Việc cần xử lý" của người quản lý đọc 1 lượt (rẻ).
    await firestore.collection("liveAlertSummary").doc("current").set({
      at: new Date(nowMs).toISOString(), count: critAlerts.length, critical: critAlerts.length,
      items: critAlerts.slice(0, 15).map((a) => ({ kind: a.kind, level: a.level, text: a.text })),
    }, { merge: true }).catch(() => {});

    // ── PHỤC HỒI VPS: máy TỪNG mất kết nối (đã gửi email offline → có notice) mà GIỜ đã ONLINE lại →
    //    gửi email "đã kết nối lại" (khung xanh) + push cho chủ luồng ưu tiên trên máy; rồi XÓA notice để
    //    lần sau mất-kết-nối vẫn báo lại. Trả lời câu hỏi của Chủ Rise Group: có, giờ tự đẩy khi phục hồi.
    let recovered = 0; let recoveryHtml = "";
    for (const m of machines) {
      if (!machineOnline(m, nowMs)) continue;
      const ref = firestore.collection(NOTICE_COL).doc(`machine_offline:${m.id}`.replace(/[^\w:-]/g, "_"));
      const cur = await ref.get().catch(() => null);
      if (!cur?.exists) continue;                 // trước đó KHÔNG hề báo offline → bỏ qua
      await ref.delete().catch(() => {});
      recovered++;
      // ĐẾM GIỐNG HỆT CÂU CẢNH BÁO (30/08/2026): bật tay HOẶC hẹn giờ đang trong khung.
      // Trước đây câu phục hồi chỉ đếm luồng BẬT TAY nên hai email của cùng một máy, cách nhau 5 phút,
      // nói hai con số khác nhau (28 rồi 21) — đọc liền nhau tưởng 7 luồng đã chết trong sự cố, trong
      // khi 7 luồng đó là luồng HẸN GIỜ và chưa bao giờ dừng.
      const onMachine = streams.filter((s: any) => s.machineId === m.id && (s.desiredState === "live" || (s.control === "schedule" && s.scheduleActive)));
      const text = `✅ VPS "${m.name}" đã KẾT NỐI LẠI — ${onMachine.length} luồng đang phát bình thường.`;
      recoveryHtml += `<li style="margin:6px 0"><b style="color:#0b7a3b">ĐÃ PHỤC HỒI</b> — ${text}</li>`;
      // BÁO CHO ĐÚNG NGƯỜI ĐÃ NHẬN BÁO ĐỘNG (30/08/2026). Trước đây báo động "mất kết nối" gửi cho MỌI
      // Admin, nhưng báo "đã phục hồi" chỉ gửi cho chủ luồng ƯU TIÊN. Máy nào không có luồng ưu tiên thì
      // KHÔNG AI được báo là đã xong → người nhận ở lại với một cảnh báo đỏ không có hồi kết (đúng cảnh
      // Chủ Rise Group gặp: VPS 05 có 0 luồng ưu tiên).
      const owners = Array.from(new Set(onMachine.filter((s: any) => s.priority || s.important).map((s: any) => String(s.createdBy ?? "").toLowerCase()).filter(Boolean)));
      const nguoiNhan = Array.from(new Set([...(owners as string[]), ...(await recipients()).map((e) => String(e).toLowerCase())])).filter(Boolean);
      if (nguoiNhan.length) await notifyOutcome(firestore, nguoiNhan, { eventType: "live_incident", label: text, tone: "green", pushCategory: "urgent" }).catch(() => {});
      // ĐÓNG VỤ trong nhật ký: tìm bản ghi "Máy ngừng báo cáo" còn mở của máy này rồi ghi thời điểm hồi.
      {
        const mo = await firestore.collection("liveIncidentLog")
          .where("machineId", "==", m.id).where("resolution", "==", "open").limit(5).get().catch(() => null);
        for (const d of mo?.docs ?? []) {
          const batDau = Date.parse(String((d.data() as any).startedAt ?? "")) || nowMs;
          await d.ref.update({
            resolvedAt: new Date(nowMs).toISOString(), resolution: "recovered",
            reason: String((d.data() as any).reason ?? "") + ` — Đã báo lại sau ${Math.max(1, Math.round((nowMs - batDau) / 1000))} giây. ${onMachine.length} luồng vẫn đang phát.`,
          }).catch(() => {});
        }
      }
    }
    if (recovered) await sendRecoveryEmail(await recipients(), recoveryHtml);

    // ── PUSH ĐIỆN THOẠI: luồng THƯỜNG bị TẠM NGỪNG nghiêm trọng (cầu dao RL-PRC-003) → báo CHỦ LUỒNG
    //    để kiểm tra/thao tác sớm. Luồng ƯU TIÊN (⭐) đã có cơ chế riêng (email + failover) nên BỎ QUA ở đây
    //    (đúng yêu cầu Chủ Rise Group). Giãn 60 phút/luồng để tự-thử-lại lặp KHÔNG dội thông báo.
    let haltedPushed = 0;
    const HALT_PUSH_COOLDOWN = 60 * 60 * 1000;
    for (const al of alerts) {
      // Cả 2 mức RL-PRC-003: ĐÃ DỪNG (lỗi nguồn, cần người) + tạm ngừng tự-thử-lại (lỗi mạng). Luồng ƯU TIÊN
      // (⭐) đã có cơ chế riêng (email + failover) nên BỎ QUA. Giãn 60 phút/luồng chống dội.
      if ((al.kind !== "stream_restart_halted" && al.kind !== "stream_needs_human") || al.priority) continue;
      const sid = al.fingerprint.slice(al.kind.length + 1);   // bỏ tiền tố "kind:"
      const stream: any = streams.find((s: any) => s.id === sid);
      const owner = String(stream?.createdBy ?? "").trim().toLowerCase();
      if (!owner) continue;
      const ref = firestore.collection(NOTICE_COL).doc(`__halted-push-${al.kind}-${sid}`.replace(/[^\w:-]/g, "_"));
      const cur = await ref.get().catch(() => null);
      const last = cur?.exists ? Date.parse(String((cur.data() as any).lastAt ?? "")) : 0;
      if (Number.isFinite(last) && nowMs - last < HALT_PUSH_COOLDOWN) continue;
      await ref.set({ lastAt: new Date(nowMs).toISOString() }, { merge: true });
      await notifyOutcome(firestore, [owner], {
        eventType: "live_incident",
        label: `⚠ ${al.text}`,   // dùng đúng nội dung cảnh báo (đã phân biệt DỪNG hẳn vs tự thử lại)
        tone: "red", pushCategory: "urgent",
      }).catch(() => { /* thông báo lỗi không chặn cron */ });
      haltedPushed++;
    }

    // ── KIỂM YOUTUBE (RL-YTB-006): luồng đang ĐẨY tín hiệu (worker báo live + máy tươi) mà YouTube
    //    KHÔNG còn phát công khai (nghi bị CHẶN/ĐÌNH CHỈ/kết thúc) → TỰ bật cờ ytIssue → app hiện đỏ +
    //    báo chủ luồng. Chỉ chạy khi có RISE_YT_API_KEY; tối đa ~8 phút/lần để tiết kiệm quota.
    let ytChecked = 0, ytFlagged = 0, ytCleared = 0;
    const ytKey = process.env.RISE_YT_API_KEY?.trim();
    if (ytKey) {
      const throttleRef = firestore.collection(NOTICE_COL).doc("__ytcheck");
      const tSnap = await throttleRef.get().catch(() => null);
      const lastAt = tSnap?.exists ? Date.parse(String((tSnap.data() as any).lastAt ?? "")) : 0;
      if (!(Number.isFinite(lastAt) && nowMs - lastAt < 8 * 60 * 1000)) {
        await throttleRef.set({ lastAt: new Date(nowMs).toISOString() }, { merge: true });
        // Chỉ xét luồng đang THẬT SỰ đẩy: máy tươi + worker báo status="live" + có link xem YouTube.
        const pushing = streams
          .filter((s: any) => streamFresh(s, nowMs) && s.status === "live" && s.watchUrl)
          .map((s: any) => ({ s, vid: extractYouTubeVideoId(String(s.watchUrl)) }))
          .filter((x: any) => x.vid);
        ytChecked = pushing.length;
        const liveOnYt = new Set<string>();   // videoId đang phát công khai ("live")
        const foundOnYt = new Set<string>();  // videoId API TÌM THẤY (dù trạng thái gì)
        for (let i = 0; i < pushing.length; i += 50) {
          const ids = pushing.slice(i, i + 50).map((x: any) => x.vid).join(",");
          const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids}&key=${ytKey}`)
            .then((x) => x.json()).catch(() => null);
          for (const item of r?.items ?? []) {
            foundOnYt.add(String(item.id));
            if (item?.snippet?.liveBroadcastContent === "live") liveOnYt.add(String(item.id));
          }
        }
        const ytAdmins = pushing.length ? await recipients() : [];   // BLĐ/Admin cũng nhận (sự cố nghiêm trọng)
        for (const { s, vid } of pushing) {
          const v = String(vid);
          const cur: any = s.ytIssue;
          if (liveOnYt.has(v)) {
            // Đang phát công khai OK → reset đếm; gỡ cờ TỰ ĐỘNG (không gỡ cờ người dùng đánh dấu tay).
            // GHI MỐC "đã từng thấy LÊN SÓNG" (mở khoá cảnh báo) — chỉ khi API đã xác nhận luồng live thật
            // thì việc "hết live" về sau mới đáng tin (chống báo oan lúc video còn "sắp phát/upcoming").
            const patch: any = {}; if ((s.ytMissCount ?? 0) > 0) patch.ytMissCount = 0;
            if (!s.ytSeenLiveAt) patch.ytSeenLiveAt = new Date(nowMs).toISOString();
            if (cur && cur.source === "auto") { patch.ytIssue = null; ytCleared++; }
            if (Object.keys(patch).length) await firestore.collection("liveStreams").doc(s.id).set(patch, { merge: true }).catch(() => {});
          } else if (foundOnYt.has(v)) {
            // TÌM THẤY video nhưng KHÔNG còn "live" → nghi tắt/chặn/đình chỉ. Đếm liên tiếp.
            // CHỈ báo khi ĐÃ TỪNG thấy luồng lên sóng (ytSeenLiveAt) — nếu chưa (mới tạo, YouTube còn
            // "upcoming"/chậm chuyển live) → KHÔNG báo oan, đợi tới khi thật sự live 1 lần.
            const miss = (s.ytMissCount ?? 0) + 1;
            if (!cur && s.ytSeenLiveAt && miss >= YT_MISS_TRIGGER) {
              const atISO = new Date(nowMs).toISOString();
              // LƯU VÀO NHẬT KÝ SỰ CỐ (recentIncidents) để CÒN VẾT + có MỐC GIỜ kể cả sau khi cờ tự gỡ
              // (trước đây cờ ytIssue chỉ hiện lúc ĐANG bị, gỡ xong mất sạch → không thấy trong nhật ký).
              const inc = { kind: "yt_issue", at: atISO, downSec: 0, reason: "YouTube không còn phát công khai (nghi bị chặn/đình chỉ/kết thúc) — máy vẫn đẩy tín hiệu" };
              await firestore.collection("liveStreams").doc(s.id).set({ ytMissCount: miss,
                ytIssue: { type: "not_public_live", note: "YouTube không còn phát công khai (nghi bị chặn/đình chỉ/kết thúc) dù máy vẫn đẩy tín hiệu", source: "auto", by: "system", byName: "Tự động (YouTube API)", at: atISO },
                recentIncidents: [inc, ...(Array.isArray(s.recentIncidents) ? s.recentIncidents : [])].slice(0, 10),
                incidentCount: (Number(s.incidentCount) || 0) + 1,
              }, { merge: true }).catch(() => {});
              ytFlagged++;
              // BÁO owner + BLĐ/Admin (sự cố nghiêm trọng = luồng coi như tắt trên YouTube) → push điện thoại.
              const to = Array.from(new Set([String(s.createdBy ?? "").toLowerCase(), ...ytAdmins.map((e) => String(e).toLowerCase())].filter(Boolean)));
              if (to.length) await notifyOutcome(firestore, to, {
                eventType: "live_yt_issue",
                label: `🔴 Luồng "${s.name}" NGHI bị chặn/đình chỉ trên YouTube (máy vẫn đẩy tín hiệu, coi như đã tắt). Vào YouTube Studio kiểm tra ngay.`,
                tone: "red", pushCategory: "urgent",
              }).catch(() => {});
            } else {
              await firestore.collection("liveStreams").doc(s.id).set({ ytMissCount: miss }, { merge: true }).catch(() => {});
            }
          } else if (s.ytSeenLiveAt) {
            // ── VIDEO ĐÃ BỊ GỠ KHỎI YOUTUBE (30/08/2026 — Chủ Rise Group phát hiện) ──────────────
            //
            // TRƯỚC ĐÂY chỗ này KHÔNG CÓ NHÁNH NÀO: mã chỉ xử "còn video nhưng hết live", còn "YouTube
            // không tìm thấy video" thì bỏ qua với lý do chống báo oan link sai. Nhưng như vậy là gộp
            // hai chuyện rất khác vào một chỗ im lặng:
            //   · link dán sai / video ẩn → đúng là không nên báo
            //   · VIDEO BỊ GỠ vì bản quyền / đình chỉ → chính là sự cố NGHIÊM TRỌNG NHẤT
            // Ca thật: luồng "TEST 03 NEW" bị bản quyền, video bị xoá, luồng tắt trên YouTube — mà
            // màn hình vẫn xanh "Đang phát · Tín hiệu ổn · 2.28 Mbps" suốt nhiều giờ, không ai biết.
            //
            // PHÂN BIỆT HAI CHUYỆN BẰNG `ytSeenLiveAt`: mốc này chỉ được ghi khi YouTube ĐÃ TỪNG xác
            // nhận luồng lên sóng thật. Link dán sai thì không bao giờ có mốc đó → vẫn im như cũ.
            // Có mốc mà nay YouTube không tìm thấy video nữa = video ĐÃ BỊ GỠ → phải báo.
            // Vẫn đếm liên tiếp như nhánh trên để một lần API trục trặc không thành báo động.
            const miss = (s.ytMissCount ?? 0) + 1;
            if (!cur && miss >= YT_MISS_TRIGGER) {
              const atISO = new Date(nowMs).toISOString();
              const inc = { kind: "yt_issue", at: atISO, downSec: 0, reason: "Video ĐÃ BỊ GỠ khỏi YouTube (nghi bản quyền / đình chỉ) — máy vẫn đẩy tín hiệu vào chỗ trống" };
              await firestore.collection("liveStreams").doc(s.id).set({ ytMissCount: miss,
                ytIssue: { type: "video_removed", note: "Video đã bị gỡ khỏi YouTube (nghi bản quyền/đình chỉ) dù máy vẫn đẩy tín hiệu", source: "auto", by: "system", byName: "Tự động (YouTube API)", at: atISO },
                recentIncidents: [inc, ...(Array.isArray(s.recentIncidents) ? s.recentIncidents : [])].slice(0, 10),
                incidentCount: (Number(s.incidentCount) || 0) + 1,
              }, { merge: true }).catch(() => {});
              ytFlagged++;
              const to = Array.from(new Set([String(s.createdBy ?? "").toLowerCase(), ...ytAdmins.map((e) => String(e).toLowerCase())].filter(Boolean)));
              if (to.length) await notifyOutcome(firestore, to, {
                eventType: "live_yt_issue",
                label: `🔴 Luồng "${s.name}": VIDEO ĐÃ BỊ GỠ khỏi YouTube (nghi bản quyền/đình chỉ). Máy vẫn đang đẩy tín hiệu vào chỗ trống — vào YouTube Studio kiểm tra và dừng luồng.`,
                tone: "red", pushCategory: "urgent",
              }).catch(() => {});
            } else {
              await firestore.collection("liveStreams").doc(s.id).set({ ytMissCount: miss }, { merge: true }).catch(() => {});
            }
          }
          // Chưa từng thấy lên sóng mà không tìm thấy video (link dán sai / video ẩn / mới đổi id)
          // → BỎ QUA, không tự đánh dấu (chống báo oan). Chỉ khác: nay có phân biệt với "đã bị gỡ".
        }
      }
    }

    // ── L3 (OAuth) — kiểm CHÍNH XÁC cho kênh đã KẾT NỐI + đã NỐI kênh Rise + CÓ luồng đang chạy.
    //    Rise đang chạy luồng trên kênh nhưng YouTube báo KHÔNG có buổi phát live nào → nghi bị
    //    chặn/đình chỉ → đẩy cảnh báo về điện thoại người phụ trách. Tiết kiệm quota: CHỈ hỏi kênh
    //    có luồng đang chạy, throttle riêng 8 phút. Bọc try/catch để KHÔNG phá luồng cảnh báo cũ.
    let l3Checked = 0, l3Flagged = 0;
    if (process.env.RISE_LIVE_L3 === "1") {
      try {
        const l3Ref = firestore.collection(NOTICE_COL).doc("__l3check");
        const l3Snap = await l3Ref.get().catch(() => null);
        const l3Last = l3Snap?.exists ? Date.parse(String((l3Snap.data() as any).lastAt ?? "")) : 0;
        if (!(Number.isFinite(l3Last) && nowMs - l3Last < 8 * 60 * 1000)) {
          await l3Ref.set({ lastAt: new Date(nowMs).toISOString() }, { merge: true });
          const connSnap = await firestore.collection("liveYoutubeConnections").limit(500).get().catch(() => null);
          const conns = (connSnap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) })).filter((c: any) => c.riseChannelId);
          for (const c of conns) {
            const running = streams.filter((s: any) => s.channelId === c.riseChannelId && streamFresh(s, nowMs) && s.status === "live");
            if (!running.length) continue;  // chỉ hỏi kênh CÓ luồng đang chạy (tiết kiệm quota)
            l3Checked++;
            try {
              const refresh = await getConnectionRefreshToken(c.id);
              if (!refresh) { await firestore.collection("liveYoutubeConnections").doc(c.id).set({ connectionState: "REAUTH_REQUIRED", lastError: "Thiếu refresh token." }, { merge: true }).catch(() => {}); continue; }
              const access = await accessTokenFromRefresh(refresh);
              const ys = await fetchChannelLiveState(access);
              // Ghi mốc LẦN ĐẦU thấy YouTube báo kênh này có buổi phát ACTIVE (kể từ khi kết nối).
              // Đây là "mở khoá giám sát": chỉ khi API đã từng phản ánh đúng trạng thái live của kênh
              // thì việc "none" về sau mới đáng tin là sự cố.
              const sawActive = ys.broadcastStatus !== "none";
              await firestore.collection("liveYoutubeConnections").doc(c.id).set({ youtubeState: ys, connectionState: "CONNECTED", lastError: null, lastSyncAt: ys.lastSyncAt, ...(sawActive && !c.ytActiveSeenAt ? { ytActiveSeenAt: ys.lastSyncAt } : {}) }, { merge: true }).catch(() => {});
              const fp = `__l3-nolive-${c.id}`;
              // CHỐNG BÁO OAN kênh VỪA KẾT NỐI: nếu CHƯA TỪNG thấy buổi phát active nào kể từ khi kết
              // nối (vd kết nối sáng nay trong khi 1 luồng CŨ đang live — luồng đó bắt đầu TRƯỚC lúc kết
              // nối nên chưa khớp API) → KHÔNG báo "nghi bị chặn/đình chỉ". Đợi khi API xác nhận 1 buổi
              // phát active thật (luồng chạy qua Rise) mới bật giám sát cho kênh này.
              if (ys.broadcastStatus === "none" && c.ytActiveSeenAt) {
                const nSnap = await firestore.collection(NOTICE_COL).doc(fp).get().catch(() => null);
                const nLast = nSnap?.exists ? Date.parse(String((nSnap.data() as any).lastAt ?? "")) : 0;
                if (!nLast || nowMs - nLast > COOLDOWN_MS) {
                  const owners = Array.from(new Set(running.map((s: any) => s.createdBy).filter(Boolean)));
                  const l3To = Array.from(new Set([...owners, ...(await recipients())].map((e) => String(e).toLowerCase()).filter(Boolean)));
                  // LƯU VẾT vào các luồng của kênh (để vào nhật ký + có mốc giờ), rồi báo owner + BLĐ.
                  const atISO = new Date(nowMs).toISOString();
                  const inc = { kind: "yt_issue", at: atISO, downSec: 0, reason: `YouTube báo kênh "${c.channelTitle}" KHÔNG có buổi phát live nào (nghi bị chặn/đình chỉ)` };
                  for (const s of running) await firestore.collection("liveStreams").doc(s.id).set({ recentIncidents: [inc, ...(Array.isArray(s.recentIncidents) ? s.recentIncidents : [])].slice(0, 10), incidentCount: (Number(s.incidentCount) || 0) + 1 }, { merge: true }).catch(() => {});
                  if (l3To.length) await notifyOutcome(firestore, l3To, {
                    eventType: "live_yt_issue",
                    label: `🔴 Kênh "${c.channelTitle}" nghi bị chặn/đình chỉ: Rise đang chạy ${running.length} luồng nhưng YouTube báo KHÔNG có buổi phát nào đang live. Vào YouTube Studio kiểm tra ngay.`,
                    tone: "red", pushCategory: "urgent",
                  }).catch(() => {});
                  await firestore.collection(NOTICE_COL).doc(fp).set({ lastAt: new Date(nowMs).toISOString() }, { merge: true });
                  l3Flagged++;
                }
              } else {
                await firestore.collection(NOTICE_COL).doc(fp).delete().catch(() => {}); // live lại → cho phép báo lần sau
              }

              // ── KIỂM TỪNG LUỒNG, KHÔNG CHỈ CẤP KÊNH (30/08/2026 — Chủ Rise Group phát hiện) ─────
              //
              // Phép kiểm ở trên hỏi "kênh này CÓ buổi phát live nào không?". Kênh chỉ chạy một luồng
              // thì đúng. Nhưng kênh chạy NHIỀU luồng thì chỉ cần MỘT cái còn sống là YouTube trả lời
              // "có live" → phép kiểm qua → các luồng CHẾT bị che hoàn toàn.
              // Ca thật: kênh "Thuong luong van" chạy 5 luồng; một luồng bị bản quyền và tắt, bốn
              // luồng kia còn sống → không cảnh báo nào nổ, màn hình vẫn xanh.
              // Trớ trêu: GIAO DIỆN vốn đã biết (nó hiện đúng "Chưa live — buổi khác đang phát"),
              // chỉ có phần CẢNH BÁO là không dùng thông tin đó. Nay dùng.
              //
              // Cách làm: so mã buổi phát của TỪNG luồng với danh sách buổi đang live của kênh —
              // đúng cách giao diện đang làm. Không gọi thêm lần nào tới YouTube: dùng lại `ys` vừa lấy.
              const dangLive = new Set<string>((ys.broadcasts ?? []).map((b: any) => String(b.videoId ?? "")).filter(Boolean));
              if (dangLive.size > 0) {   // kênh "none" đã xử ở trên rồi, đây là lúc kênh CÓ buổi live
                for (const s of running) {
                  const vid = extractYouTubeVideoId(String(s.watchUrl ?? ""));
                  if (!vid || dangLive.has(vid)) continue;            // không đọc được mã, hoặc đang live → bỏ qua
                  if (!s.ytSeenLiveAt || s.ytIssue) continue;         // chưa từng lên sóng, hoặc đã đánh dấu rồi
                  const miss = (s.ytMissCount ?? 0) + 1;
                  if (miss < YT_MISS_TRIGGER) {                        // đếm liên tiếp — chống báo oan một nhịp lỗi
                    await firestore.collection("liveStreams").doc(s.id).set({ ytMissCount: miss }, { merge: true }).catch(() => {});
                    continue;
                  }
                  const atISO = new Date(nowMs).toISOString();
                  const inc = { kind: "yt_issue", at: atISO, downSec: 0, reason: `Buổi phát của luồng này KHÔNG còn live trên kênh "${c.channelTitle}" (kênh vẫn có buổi khác đang phát) — máy vẫn đẩy tín hiệu` };
                  await firestore.collection("liveStreams").doc(s.id).set({ ytMissCount: miss,
                    ytIssue: { type: "stream_not_live", note: `Buổi phát của luồng không còn live trên kênh "${c.channelTitle}" dù máy vẫn đẩy tín hiệu`, source: "auto", by: "system", byName: "Tự động (YouTube OAuth)", at: atISO },
                    recentIncidents: [inc, ...(Array.isArray(s.recentIncidents) ? s.recentIncidents : [])].slice(0, 10),
                    incidentCount: (Number(s.incidentCount) || 0) + 1,
                  }, { merge: true }).catch(() => {});
                  l3Flagged++;
                  const to = Array.from(new Set([String(s.createdBy ?? "").toLowerCase(), ...(await recipients()).map((e) => String(e).toLowerCase())].filter(Boolean)));
                  if (to.length) await notifyOutcome(firestore, to, {
                    eventType: "live_yt_issue",
                    label: `🔴 Luồng "${s.name}" KHÔNG còn live trên YouTube (kênh "${c.channelTitle}" vẫn có buổi khác phát, nên trước đây hệ không phát hiện). Máy vẫn đẩy tín hiệu — vào YouTube Studio kiểm tra.`,
                    tone: "red", pushCategory: "urgent",
                  }).catch(() => {});
                }
              }
            } catch (e: any) {
              const reauth = e instanceof ReauthNeeded;
              await firestore.collection("liveYoutubeConnections").doc(c.id).set({ connectionState: reauth ? "REAUTH_REQUIRED" : "DEGRADED", lastError: e?.message ?? "Lỗi." }, { merge: true }).catch(() => {});
            }
          }
        }
      } catch { /* KHÔNG phá luồng cảnh báo cũ */ }
    }

    return NextResponse.json({ ok: true, alerts: alerts.length, emailWorthy: emailAlerts.length, sent: toSend.length, recovered, haltedPushed, ytChecked, ytFlagged, ytCleared, l3Checked, l3Flagged });
  } catch (error: any) {
    console.error("POST /api/live/alerts/run failed", error);
    return NextResponse.json({ error: error?.message ?? "Lỗi máy chủ." }, { status: 500 });
  }
}
