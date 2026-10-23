// RISE LIVE L3 — Đợt 1 · OAuth (phần THUẦN, không I/O). Dựng link đăng nhập Google +
// hằng số scope + đường callback. KHÔNG đọc secret, KHÔNG gọi mạng, KHÔNG Firestore —
// route thật (initiate/callback) sẽ dùng các hàm này ở bước sau, sau cờ RISE_LIVE_L3.
// Chốt theo R0 hiệu đính: access_type=offline, incremental, PKCE (tuỳ chọn), gắn channelId
// đã xác minh (channels.list) chứ không tin frontend. KHÔNG có CMS -> không onBehalfOfContentOwner.

export const RISE_LIVE_L3_FLAG = "RISE_LIVE_L3"; // mặc định TẮT

// ── Scope ─────────────────────────────────────────────────────────────────────
// Đợt 1 (CHỈ ĐỌC): đủ để channels.list(mine) + liveBroadcasts/liveStreams.list.
export const L3_SCOPES_READONLY = ["https://www.googleapis.com/auth/youtube.readonly"] as const;
// Đợt 2 (ĐIỀU KHIỂN): quản lý YouTube — đủ để liveBroadcasts.insert/bind/transition/complete.
// (youtube = "Quản lý tài khoản YouTube"; đủ cho điều khiển live, không cần force-ssl rộng hơn.)
export const L3_SCOPES_CONTROL = ["https://www.googleapis.com/auth/youtube"] as const;

// Đường callback CỐ ĐỊNH (đã đăng ký trong OAuth Client "Rise Work Server", URIs 3).
export function l3RedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/live/youtube/callback`;
}

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

// ── Dựng link đồng ý của Google (THUẦN) ───────────────────────────────────────
// prompt=consent + access_type=offline => luôn nhận refresh token (app đang In production
// nên refresh token KHÔNG hết hạn 7 ngày). include_granted_scopes=true => incremental auth.
// codeChallenge (S256) tuỳ chọn — client web có secret vẫn dùng được để tăng an toàn.
export function buildConsentUrl(p: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge?: string;
  loginHint?: string;
  selectAccount?: boolean;
}): string {
  // selectAccount=true => prompt "select_account consent": LUÔN hiện màn CHỌN tài khoản Google (tránh
  // vô tình dùng nhầm Gmail đang đăng nhập sẵn trên trình duyệt) rồi mới tới màn đồng ý.
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: p.scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: p.selectAccount ? "select_account consent" : "consent",
    state: p.state,
  });
  if (p.codeChallenge) { q.set("code_challenge", p.codeChallenge); q.set("code_challenge_method", "S256"); }
  if (p.loginHint) q.set("login_hint", p.loginHint);
  return `${GOOGLE_AUTH_ENDPOINT}?${q.toString()}`;
}

// ── Kiểm scope thực tế được cấp (THUẦN) ───────────────────────────────────────
// Google trả chuỗi scope cách nhau bởi khoảng trắng. Đừng giả định đã cấp đủ.
export function grantedScopesInclude(granted: string | string[] | undefined, needed: readonly string[]): boolean {
  const set = new Set((Array.isArray(granted) ? granted : String(granted ?? "").split(/\s+/)).filter(Boolean));
  return needed.every((s) => set.has(s));
}

// ── Bảo toàn refresh token cũ (THUẦN) ─────────────────────────────────────────
// Lần kết nối lại đôi khi Google KHÔNG trả refresh_token mới -> phải GIỮ token cũ, không ghi đè null.
export function pickRefreshToken(newToken: string | null | undefined, existing: string | null | undefined): string | null {
  return (newToken && newToken.trim()) ? newToken : (existing ?? null);
}
