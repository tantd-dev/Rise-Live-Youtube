// RISE LIVE L3 — Đợt 1 · KHỞI TẠO kết nối kênh YouTube (OAuth). GET -> chuyển hướng sang màn
// đồng ý của Google. Sau cờ RISE_LIVE_L3 (mặc định TẮT). Chặn xem-thử. Giai đoạn thử: CHỈ Admin
// kết nối (sau mở theo quyền live.youtube.connection.create). KHÔNG đụng gì đang chạy.
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { appOrigin } from "@/lib/app-url";
import { buildConsentUrl, l3RedirectUri, L3_SCOPES_READONLY, L3_SCOPES_CONTROL, RISE_LIVE_L3_FLAG } from "@/lib/live-youtube-oauth";
import { saveOAuthState } from "@/lib/live-youtube-store";
import { canOperateLive } from "@/lib/live-permissions";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ON = () => process.env[RISE_LIVE_L3_FLAG] === "1";

export async function GET(req: Request) {
  try {
    if (!ON()) return NextResponse.json({ error: "Tính năng chưa bật." }, { status: 403 });
    const user = await requireSession();
    if (user.viewingAs) return NextResponse.json({ error: "Đang xem thử vai trò — thoát về vai trò thật." }, { status: 403 });
    if (!canOperateLive(user)) return NextResponse.json({ error: "Bạn chưa được cấp quyền vận hành Live để kết nối kênh." }, { status: 403 });
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    if (!clientId) return NextResponse.json({ error: "Máy chủ chưa cấu hình GOOGLE_OAUTH_CLIENT_ID." }, { status: 500 });
    const origin = appOrigin() || new URL(req.url).origin;
    // mode=control → xin THÊM quyền điều khiển (Đợt 2). Mặc định chỉ đọc (Đợt 1). Incremental
    // authorization (include_granted_scopes) nên quyền cũ vẫn giữ.
    const wantControl = new URL(req.url).searchParams.get("mode") === "control";
    const scopes = wantControl ? [...L3_SCOPES_READONLY, ...L3_SCOPES_CONTROL] : [...L3_SCOPES_READONLY];
    const state = crypto.randomBytes(24).toString("base64url");
    await saveOAuthState(state, String(user.email).toLowerCase(), scopes);
    const url = buildConsentUrl({ clientId, redirectUri: l3RedirectUri(origin), scopes, state, selectAccount: true });
    return NextResponse.redirect(url);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Lỗi máy chủ." }, { status: 500 });
  }
}
