// RISE LIVE L3 — Đợt 1 · ĐỒNG BỘ trạng thái kênh (POST). Với mỗi kết nối: đọc refresh token
// (Secret Manager) -> access token -> hỏi YouTube đang live không -> lưu youtubeState. Sau cờ,
// chỉ Admin, chặn xem-thử. CHỈ ĐỌC phía YouTube; không điều khiển, không chạm luồng đang chạy.
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { RISE_LIVE_L3_FLAG } from "@/lib/live-youtube-oauth";
import { listConnections, getConnectionRefreshToken, patchConnection } from "@/lib/live-youtube-store";
import { accessTokenFromRefresh, fetchChannelLiveState, ReauthNeeded } from "@/lib/live-youtube-sync";
import { canOperateLive } from "@/lib/live-permissions";
import { getVisibleUserEmails } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ON = () => process.env[RISE_LIVE_L3_FLAG] === "1";

export async function POST() {
  try {
    if (!ON()) return NextResponse.json({ error: "Tính năng chưa bật." }, { status: 403 });
    const user = await requireSession();
    if (user.viewingAs) return NextResponse.json({ error: "Đang xem thử vai trò." }, { status: 403 });
    if (!canOperateLive(user)) return NextResponse.json({ error: "Bạn chưa được cấp quyền vận hành Live để đồng bộ." }, { status: 403 });

    // PHẠM VI: chỉ đồng bộ kênh trong tầm quản lý (Admin/BLĐ = tất cả; trưởng nhóm = kênh của nhóm;
    // cá nhân = kênh mình kết nối). Tránh người này đồng bộ kênh của người/nhóm khác.
    const visible = await getVisibleUserEmails(user);
    const all = await listConnections();
    const conns = visible ? all.filter((c) => visible.has(String(c.connectedBy ?? "").toLowerCase())) : all;
    let ok = 0, fail = 0;
    for (const c of conns) {
      try {
        const refresh = await getConnectionRefreshToken(c.id);
        if (!refresh) { await patchConnection(c.id, { connectionState: "REAUTH_REQUIRED", lastError: "Thiếu refresh token.", lastSyncAt: new Date().toISOString() }); fail++; continue; }
        const access = await accessTokenFromRefresh(refresh);
        const youtubeState = await fetchChannelLiveState(access);
        await patchConnection(c.id, { youtubeState, connectionState: "CONNECTED", lastError: null, lastSyncAt: youtubeState.lastSyncAt ?? new Date().toISOString() });
        ok++;
      } catch (e: any) {
        const reauth = e instanceof ReauthNeeded;
        await patchConnection(c.id, { connectionState: reauth ? "REAUTH_REQUIRED" : "DEGRADED", lastError: e?.message ?? "Lỗi.", lastSyncAt: new Date().toISOString() });
        fail++;
      }
    }
    return NextResponse.json({ ok: true, synced: ok, failed: fail });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Lỗi máy chủ." }, { status: 500 });
  }
}
