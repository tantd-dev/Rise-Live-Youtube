// RISE LIVE L3 — Đợt 1 · CALLBACK OAuth. Google chuyển hướng về đây kèm code+state:
// đối chiếu state (một lần, đúng người) -> đổi code lấy token -> lấy YouTube Channel ID THẬT
// (channels.list mine, không tin frontend) -> lưu kết nối (refresh token vào Secret Manager).
// Sau cờ RISE_LIVE_L3. KHÔNG log token/secret. Kết thúc: chuyển người dùng về app kèm thông báo.
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { appOrigin } from "@/lib/app-url";
import { l3RedirectUri, L3_SCOPES_READONLY, L3_SCOPES_CONTROL, RISE_LIVE_L3_FLAG, grantedScopesInclude } from "@/lib/live-youtube-oauth";
import { consumeOAuthState, upsertConnection, findRiseChannelForYoutube, mapConnection, connectionRiseChannelId } from "@/lib/live-youtube-store";
import { canOperateLive } from "@/lib/live-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ON = () => process.env[RISE_LIVE_L3_FLAG] === "1";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = appOrigin() || url.origin;
  const back = (msg: string, ok: boolean) =>
    NextResponse.redirect(`${origin}/?live_yt=${ok ? "ok" : "err"}&m=${encodeURIComponent(msg)}`);
  try {
    if (!ON()) return back("Tính năng chưa bật.", false);
    const user = await requireSession();
    if (user.viewingAs) return back("Đang xem thử vai trò.", false);
    if (!canOperateLive(user)) return back("Bạn chưa được cấp quyền vận hành Live.", false);
    const err = url.searchParams.get("error");
    if (err) return back(`Google từ chối cấp quyền (${err}).`, false);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return back("Thiếu thông tin trả về từ Google.", false);

    const st = await consumeOAuthState(state);
    if (!st) return back("Phiên kết nối hết hạn hoặc không hợp lệ — thử lại.", false);
    if (st.requestedBy !== String(user.email).toLowerCase()) return back("Phiên kết nối không khớp người dùng.", false);

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) return back("Máy chủ chưa cấu hình OAuth client.", false);

    // Đổi code lấy token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: l3RedirectUri(origin),
      }),
    });
    if (!tokenRes.ok) return back("Đổi mã lấy token thất bại.", false);
    const tok: any = await tokenRes.json();
    if (!grantedScopesInclude(tok.scope, L3_SCOPES_READONLY)) return back("Bạn chưa cấp đủ quyền đọc YouTube.", false);

    // Lấy Channel ID THẬT của tài khoản vừa đăng nhập (không tin frontend)
    const chRes = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!chRes.ok) return back("Không đọc được kênh của tài khoản này.", false);
    const ch: any = await chRes.json();
    const item = ch?.items?.[0];
    if (!item?.id) return back("Tài khoản Google này không quản lý kênh YouTube nào.", false);

    const hasControlScope = grantedScopesInclude(tok.scope, L3_SCOPES_CONTROL);
    await upsertConnection({
      youtubeChannelId: String(item.id),
      channelTitle: item.snippet?.title ?? String(item.id),
      thumbnail: item.snippet?.thumbnails?.default?.url ?? null,
      customUrl: item.snippet?.customUrl ?? null,
      account: null,
      scopesGranted: String(tok.scope ?? "").split(/\s+/).filter(Boolean),
      hasControlScope,
      refreshToken: tok.refresh_token ?? null,
      connectedBy: String(user.email).toLowerCase(),
    });
    // TỰ KHỚP với kênh Rise sẵn có (nếu tìm được) — khỏi nối tay. CHỈ tự khớp khi CHƯA nối
    // (không ghi đè mapping admin đã sửa tay khi kết nối lại).
    let matchedNote = "";
    try {
      const already = await connectionRiseChannelId(String(item.id));
      if (!already) {
        const matched = await findRiseChannelForYoutube(String(item.id), item.snippet?.customUrl ?? null);
        if (matched) { await mapConnection(String(item.id), matched); matchedNote = " (đã tự nối với kênh Rise)"; }
      }
    } catch { /* không sao — nối tay được */ }
    return back(`Đã kết nối kênh: ${item.snippet?.title ?? item.id}${matchedNote}`, true);
  } catch (e: any) {
    return back(e?.message ?? "Lỗi máy chủ.", false);
  }
}
