// RISE LIVE L3 — Đợt 1 · GET danh sách kênh đã kết nối + kênh Rise (để nối) + POST nối kênh.
// Sau cờ RISE_LIVE_L3. Người vận hành Live (canOperateLive). PHẠM VI theo cây quản lý: Admin/BLĐ thấy
// hết; trưởng nhóm thấy kênh của nhóm; cá nhân chỉ thấy kênh MÌNH kết nối. Chỉ đọc/nối metadata, không token.
import { NextResponse } from "next/server";
import { requireSession, isUnauthorized } from "@/lib/session";
import { firestore } from "@/lib/firestore";
import { RISE_LIVE_L3_FLAG } from "@/lib/live-youtube-oauth";
import { mapConnection, getConnectionRefreshToken } from "@/lib/live-youtube-store";
import { canOperateLive } from "@/lib/live-permissions";
import { getVisibleUserEmails } from "@/lib/access";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ON = () => process.env[RISE_LIVE_L3_FLAG] === "1";

export async function GET() {
  try {
    if (!ON()) return NextResponse.json({ enabled: false });
    const user = await requireSession();
    const canConnect = canOperateLive(user) && !user.viewingAs;   // mở cho người vận hành Live (không chỉ Admin)
    const configured = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
    const [connSnap, chSnap] = await Promise.all([
      firestore.collection("liveYoutubeConnections").limit(500).get().catch(() => null),
      firestore.collection("channels").limit(1000).get().catch(() => null),
    ]);
    // PHẠM VI (như phân quyền Rise Work): Admin/BLĐ thấy hết (visible=null); trưởng nhóm thấy kênh của
    // người trong nhóm; cá nhân chỉ thấy kênh MÌNH kết nối. Lọc theo connectedBy ∈ phạm vi quản lý.
    const visible = await getVisibleUserEmails(user);
    const inScope = (by: any) => !visible || visible.has(String(by ?? "").toLowerCase());
    const connections = (connSnap?.docs ?? []).map((doc) => {
      const x = doc.data() as any;
      return {
        id: doc.id,
        channelTitle: x.channelTitle ?? doc.id,
        thumbnail: x.thumbnail ?? null,
        connectionState: x.connectionState ?? "CONNECTED",
        connectedAt: x.connectedAt ?? null,
        connectedBy: x.connectedBy ?? null,
        riseChannelId: x.riseChannelId ?? null,
        hasControlScope: x.hasControlScope === true,
        youtubeState: x.youtubeState ?? null,
        lastSyncAt: x.lastSyncAt ?? null,
        lastError: x.lastError ?? null,
      };
    }).filter((c) => inScope(c.connectedBy)).sort((a, b) => String(a.channelTitle).localeCompare(String(b.channelTitle), "vi"));
    const riseChannels = (chSnap?.docs ?? [])
      .map((d) => ({ id: d.id, ...(d.data() as any) }))
      .filter((x) => x.status !== "archived")   // kênh ĐÃ XOÁ không được đưa ra để nối kết nối YouTube
      .map((x) => ({ id: x.id, name: x.name ?? x.channelName ?? x.id }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "vi"));
    return NextResponse.json({ enabled: true, canConnect, configured, connections, riseChannels });
  } catch (e: any) {
    if (isUnauthorized(e)) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
    return NextResponse.json({ error: e?.message ?? "Lỗi máy chủ." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    if (!ON()) return NextResponse.json({ error: "Tính năng chưa bật." }, { status: 403 });
    const user = await requireSession();
    if (user.viewingAs) return NextResponse.json({ error: "Đang xem thử vai trò." }, { status: 403 });
    if (!canOperateLive(user)) return NextResponse.json({ error: "Bạn chưa được cấp quyền vận hành Live." }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    if (body.action === "map") {
      if (!body.connectionId) return NextResponse.json({ error: "Thiếu kênh kết nối." }, { status: 400 });
      await mapConnection(String(body.connectionId), body.riseChannelId ? String(body.riseChannelId) : null);
      return NextResponse.json({ ok: true });
    }
    // HỦY KẾT NỐI kênh YouTube: thu hồi quyền ở Google (best-effort) + xóa kết nối khỏi Rise Work.
    // KHÔNG ảnh hưởng luồng đang phát (luồng đẩy bằng Khoá luồng RTMP, độc lập với kết nối OAuth này).
    if (body.action === "disconnect") {
      const id = String(body.connectionId ?? "");
      if (!id) return NextResponse.json({ error: "Thiếu kênh kết nối." }, { status: 400 });
      const snap = await firestore.collection("liveYoutubeConnections").doc(id).get();
      if (!snap.exists) return NextResponse.json({ error: "Kết nối không tồn tại." }, { status: 404 });
      const conn = snap.data() as any;
      // Phạm vi: chỉ hủy kết nối trong phạm vi quản lý (Admin/BLĐ = toàn bộ).
      const visible = await getVisibleUserEmails(user);   // null = Admin/BLĐ (toàn bộ) → không chặn
      if (visible && !visible.has(String(conn.connectedBy ?? "").toLowerCase()))
        return NextResponse.json({ error: "Kênh này ngoài phạm vi của bạn." }, { status: 403 });
      try {
        const rt = await getConnectionRefreshToken(id);
        if (rt) await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(rt), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }).catch(() => {});
      } catch { /* thu hồi ở Google lỗi cũng vẫn xóa kết nối phía Rise */ }
      await firestore.collection("liveYoutubeConnections").doc(id).delete();
      await logAudit(firestore, { action: "live_yt_disconnect", entityType: "liveYoutubeConnection", entityId: id, performedBy: user.email, detail: `Hủy kết nối kênh YouTube "${conn.channelTitle ?? id}".` });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Hành động không hợp lệ." }, { status: 400 });
  } catch (e: any) {
    if (isUnauthorized(e)) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
    return NextResponse.json({ error: e?.message ?? "Lỗi máy chủ." }, { status: 500 });
  }
}
