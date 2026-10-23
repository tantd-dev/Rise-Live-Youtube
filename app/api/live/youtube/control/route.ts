// RISE LIVE L3 — Đợt 2 · ĐIỀU KHIỂN (GHI lên YouTube). Lệnh đầu tiên: KẾT THÚC buổi phát.
// NHIỀU LỚP KIỂM AN TOÀN: sau cờ · chỉ Admin · chặn xem-thử · kênh phải KẾT NỐI + đã NỐI kênh
// Rise + có QUYỀN điều khiển · buổi phát phải thuộc kênh đó + ĐANG live (không kết thúc nhầm) ·
// idempotent (đã complete = coi như xong) · GHI AUDIT. Lỗi ở đây KHÔNG chạm FFmpeg/worker.
import { NextResponse } from "next/server";
import { firestore } from "@/lib/firestore";
import { requireSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";
import { extractYouTubeVideoId } from "@/lib/youtube-check";
import { RISE_LIVE_L3_FLAG } from "@/lib/live-youtube-oauth";
import { getConnectionRefreshToken } from "@/lib/live-youtube-store";
import { accessTokenFromRefresh, getBroadcastLifecycle, completeBroadcast, setBroadcastAutoStop, goLiveBroadcast, ReauthNeeded } from "@/lib/live-youtube-sync";
import { canOperateLive } from "@/lib/live-permissions";
import { getVisibleUserEmails } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ON = () => process.env[RISE_LIVE_L3_FLAG] === "1";

export async function POST(req: Request) {
  try {
    if (!ON()) return NextResponse.json({ error: "Tính năng chưa bật." }, { status: 403 });
    const user = await requireSession();
    if (user.viewingAs) return NextResponse.json({ error: "Đang xem thử vai trò — thoát về vai trò thật." }, { status: 403 });
    if (!canOperateLive(user)) return NextResponse.json({ error: "Bạn chưa được cấp quyền vận hành Live để điều khiển." }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    if (!["complete", "set_autostop", "go_live"].includes(String(body.action))) return NextResponse.json({ error: "Hành động không hợp lệ." }, { status: 400 });
    const streamId = String(body.streamId ?? "");
    if (!streamId) return NextResponse.json({ error: "Thiếu luồng." }, { status: 400 });

    // 1) Luồng + kênh Rise của nó
    const sDoc = await firestore.collection("liveStreams").doc(streamId).get();
    if (!sDoc.exists) return NextResponse.json({ error: "Không thấy luồng." }, { status: 404 });
    const s: any = sDoc.data();
    const channelId = String(s.channelId ?? "");
    if (!channelId) return NextResponse.json({ error: "Luồng chưa gắn kênh Rise → không biết kênh YouTube nào để điều khiển." }, { status: 400 });

    // 2) Kết nối YouTube đã NỐI với kênh Rise đó + có QUYỀN điều khiển
    const cSnap = await firestore.collection("liveYoutubeConnections").where("riseChannelId", "==", channelId).limit(1).get().catch(() => null);
    const cDoc = cSnap?.docs?.[0];
    if (!cDoc) return NextResponse.json({ error: "Kênh của luồng chưa kết nối YouTube (hoặc chưa nối với kênh Rise)." }, { status: 400 });
    const c: any = cDoc.data();
    // PHẠM VI: chỉ người kết nối kênh (hoặc trưởng nhóm/Admin quản người đó) mới được điều khiển —
    // KHÔNG để người này kết thúc buổi live của kênh do người/nhóm khác kết nối.
    const visible = await getVisibleUserEmails(user);
    if (visible && !visible.has(String(c.connectedBy ?? "").toLowerCase())) {
      return NextResponse.json({ error: `Kênh "${c.channelTitle}" ngoài phạm vi quản lý của bạn — không điều khiển được.` }, { status: 403 });
    }
    if (!c.hasControlScope) return NextResponse.json({ error: `Kênh "${c.channelTitle}" chưa cấp quyền điều khiển. Vào Kết nối kênh → "🎛 Bật điều khiển".` }, { status: 400 });

    // 3) Buổi phát = video ID trong link live của luồng
    const broadcastId = extractYouTubeVideoId(String(s.watchUrl ?? ""));
    if (!broadcastId) return NextResponse.json({ error: "Không lấy được mã buổi phát từ link live của luồng." }, { status: 400 });

    // 4) Access token
    const refresh = await getConnectionRefreshToken(cDoc.id);
    if (!refresh) return NextResponse.json({ error: "Kết nối cần đăng nhập lại (thiếu token)." }, { status: 400 });
    let access: string;
    try { access = await accessTokenFromRefresh(refresh); }
    catch (e: any) { return NextResponse.json({ error: e instanceof ReauthNeeded ? "Kết nối đã bị thu hồi — kết nối lại." : (e?.message ?? "Lỗi token.") }, { status: 400 }); }

    // ── HÀNH ĐỘNG: TẮT/BẬT auto-stop (bảo vệ Pub) — đọc-rồi-ghi, không đụng buổi phát đang chạy.
    if (body.action === "set_autostop") {
      const enable = body.enable === true;
      try {
        const res = await setBroadcastAutoStop(access, broadcastId, enable);
        // GHI trạng thái auto-stop lên luồng để giao diện hiện đúng (nút → "đã bảo vệ", bỏ nhắc chuyển máy).
        await firestore.collection("liveStreams").doc(streamId).set({ youtubeAutoStop: res.enableAutoStop, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
        await logAudit(firestore, { action: "live_yt_autostop", entityType: "liveStream", entityId: streamId, performedBy: user.email, detail: `Đặt auto-stop=${res.enableAutoStop} buổi phát (${broadcastId}) kênh "${c.channelTitle}"` });
        return NextResponse.json({ ok: true, enableAutoStop: res.enableAutoStop });
      } catch (e: any) {
        return NextResponse.json({ error: e?.message ?? "Lỗi đổi auto-stop." }, { status: 400 });
      }
    }

    // ── HÀNH ĐỘNG: LÊN SÓNG (transition → live). Kiểm trạng thái trước để báo lỗi rõ.
    if (body.action === "go_live") {
      const life0 = await getBroadcastLifecycle(access, broadcastId);
      if (life0 === "live") return NextResponse.json({ ok: true, already: true, lifeCycleStatus: "live" });
      if (life0 === "complete" || life0 === "revoked") return NextResponse.json({ error: `Buổi phát đã ${life0} — không lên sóng lại được (cần tạo buổi mới).` }, { status: 400 });
      try {
        const res = await goLiveBroadcast(access, broadcastId);
        await logAudit(firestore, { action: "live_yt_golive", entityType: "liveStream", entityId: streamId, performedBy: user.email, detail: `Lên sóng buổi phát (${broadcastId}) kênh "${c.channelTitle}"` });
        return NextResponse.json({ ok: true, lifeCycleStatus: res.lifeCycleStatus });
      } catch (e: any) {
        return NextResponse.json({ error: e?.message ?? "Lỗi lên sóng." }, { status: 400 });
      }
    }

    // 5) AN TOÀN: chỉ kết thúc khi buổi phát đang live/liveStarting (không kết thúc nhầm cái đã xong/khác)
    const life = await getBroadcastLifecycle(access, broadcastId);
    if (life == null) return NextResponse.json({ error: "Không đọc được buổi phát trên kênh này (mã không thuộc kênh?)." }, { status: 400 });
    if (life === "complete" || life === "revoked") {
      await logAudit(firestore, { action: "live_yt_complete_noop", entityType: "liveStream", entityId: streamId, performedBy: user.email, detail: `buổi phát đã ở trạng thái ${life}` });
      return NextResponse.json({ ok: true, already: true, lifeCycleStatus: life });
    }
    if (!["live", "liveStarting"].includes(String(life))) {
      return NextResponse.json({ error: `Buổi phát đang "${life}" — chỉ kết thúc được khi đang phát.` }, { status: 400 });
    }

    // 6) KẾT THÚC + audit
    const res = await completeBroadcast(access, broadcastId);
    await logAudit(firestore, { action: "live_yt_complete", entityType: "liveStream", entityId: streamId, performedBy: user.email, detail: `Kết thúc buổi phát YouTube (${broadcastId}) kênh "${c.channelTitle}"` });
    const nowISO = new Date().toISOString();
    // 6a) DỪNG LUÔN MÁY PHÁT (VPS): buổi phát đã đóng trên YouTube thì để VPS chạy cũng KHÔNG đẩy
    //     lên được nữa → tự dừng cho khỏi phí (giống nút "Dừng"). Hẹn giờ → chuyển tay để không tự bật lại.
    await firestore.collection("liveStreams").doc(streamId).set({
      desiredState: "stopped", status: "stopped", health: "idle", liveSince: null,
      ...(String(s.control) === "schedule" ? { control: "manual" } : {}),
      updatedAt: nowISO, updatedBy: user.email,
    }, { merge: true });
    // 6b) KHÔNG ghi đè trạng thái YouTube của KẾT NỐI ở đây: 1 kết nối theo dõi trạng thái theo
    //     KÊNH (chung), nếu đặt "none" thì luồng KHÁC đang live cùng kênh sẽ bị báo nhầm "Chưa live".
    //     Để lần đồng bộ (sync) tự xác nhận trạng thái kênh từ YouTube (đúng cho cả nhiều luồng/kênh).
    return NextResponse.json({ ok: true, lifeCycleStatus: res.lifeCycleStatus });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Lỗi máy chủ." }, { status: 500 });
  }
}
