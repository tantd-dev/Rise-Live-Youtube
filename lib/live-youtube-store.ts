// RISE LIVE L3 — Đợt 1 · LƯU KẾT NỐI KÊNH (Firestore) + trạng thái OAuth tạm thời.
// Firestore CHỈ lưu metadata + secretRef; refresh token thật nằm ở Secret Manager (lib/secret-store).
// Collection MỚI: youtubeConnections (1 kênh = 1 doc theo channelId) · youtubeOauthStates (chống CSRF).
import { firestore } from "@/lib/firestore";
import { putSecretValue, getSecretValue, ytRefreshSecretId } from "@/lib/secret-store";
import type { YoutubeConnectionState, YoutubeState } from "@/lib/live-youtube-catalog";

// Kho RIÊNG của L3 (KHÔNG dùng "youtubeConnections" — đó là kho của tính năng OAuth CŨ đã gỡ
// V55.55, còn dữ liệu rác title-less; dùng lại sẽ lẫn). States dùng kho riêng luôn cho sạch.
const CONN = "liveYoutubeConnections";
const STATES = "liveYoutubeOauthStates";
const nowISO = () => new Date().toISOString();

export type OAuthStateRecord = { state: string; requestedBy: string; scopes: string[]; createdAt: string };

// Lưu "state" ngẫu nhiên (một lần) để callback đối chiếu — chống CSRF, gắn với người khởi tạo.
export async function saveOAuthState(state: string, requestedBy: string, scopes: string[]): Promise<void> {
  await firestore.collection(STATES).doc(state).set({ state, requestedBy, scopes, createdAt: nowISO() });
}
// Đọc + XOÁ (dùng một lần). Hết hạn 15 phút -> coi như không hợp lệ.
export async function consumeOAuthState(state: string): Promise<OAuthStateRecord | null> {
  const ref = firestore.collection(STATES).doc(state);
  const snap = await ref.get().catch(() => null);
  if (!snap || !snap.exists) return null;
  const d = snap.data() as any;
  await ref.delete().catch(() => {});
  if (d?.createdAt && Date.now() - Date.parse(d.createdAt) > 15 * 60_000) return null;
  return d as OAuthStateRecord;
}

// Tạo/cập nhật kết nối 1 kênh. Refresh token -> Secret Manager (chỉ lưu secretRef vào Firestore).
// GIỮ token cũ nếu lần này Google không trả refresh token mới (không ghi đè mất token).
export async function upsertConnection(p: {
  youtubeChannelId: string; channelTitle: string; thumbnail?: string | null; customUrl?: string | null;
  account?: string | null; scopesGranted: string[]; hasControlScope?: boolean; refreshToken: string | null; connectedBy: string;
}): Promise<{ id: string }> {
  const id = p.youtubeChannelId; // id ổn định = channelId đã xác minh (không dùng email/tên)
  const ref = firestore.collection(CONN).doc(id);
  const existing = await ref.get().catch(() => null);
  const prev = existing?.exists ? (existing.data() as any) : null;
  let refreshRef: string | null = prev?.refreshTokenSecretRef ?? null;
  if (p.refreshToken && p.refreshToken.trim()) {
    refreshRef = await putSecretValue(ytRefreshSecretId(id), p.refreshToken);
  }
  const connectionState: YoutubeConnectionState = refreshRef ? "CONNECTED" : "REAUTH_REQUIRED";
  await ref.set({
    youtubeChannelId: p.youtubeChannelId, channelTitle: p.channelTitle, thumbnail: p.thumbnail ?? null,
    customUrl: p.customUrl ?? prev?.customUrl ?? null,
    account: p.account ?? null, scopesGranted: p.scopesGranted, refreshTokenSecretRef: refreshRef,
    hasControlScope: p.hasControlScope || prev?.hasControlScope || false,   // giữ quyền điều khiển đã cấp
    connectionState, connectedBy: p.connectedBy,
    connectedAt: prev?.connectedAt ?? nowISO(), updatedAt: nowISO(), lastError: null, revokedAt: null,
  }, { merge: true });
  return { id };
}

// TỰ KHỚP kênh YouTube (đã kết nối) với kênh Rise SẴN CÓ (đa số đã thêm để báo cáo).
// Khớp theo link kênh Rise đang lưu: dạng .../channel/UCxxxx (khớp channelId) hoặc .../@tên
// (khớp customUrl/@handle). Trả về id kênh Rise nếu tìm thấy, null nếu không.
function handleOf(s?: string | null): string | null {
  if (!s) return null; return String(s).trim().replace(/^@/, "").toLowerCase() || null;
}
export async function findRiseChannelForYoutube(youtubeChannelId: string, customUrl?: string | null): Promise<string | null> {
  const handle = handleOf(customUrl);
  const snap = await firestore.collection("channels").limit(2000).get().catch(() => null);
  for (const d of (snap?.docs ?? [])) {
    const url = String((d.data() as any).url ?? "");
    const chMatch = url.match(/\/channel\/(UC[\w-]+)/i);
    if (chMatch && chMatch[1] === youtubeChannelId) return d.id;
    const hMatch = url.match(/\/@([\w.\-]+)/);
    if (handle && hMatch && hMatch[1].toLowerCase() === handle) return d.id;
  }
  return null;
}

// Danh sách kết nối (chỉ đọc metadata; KHÔNG chứa token).
export async function listConnections(): Promise<any[]> {
  const snap = await firestore.collection(CONN).limit(500).get().catch(() => null);
  return (snap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) }));
}

// Đọc refresh token của 1 kết nối (từ Secret Manager). Dùng cho đồng bộ đọc.
export async function getConnectionRefreshToken(id: string): Promise<string | null> {
  return getSecretValue(ytRefreshSecretId(id));
}

// Kênh Rise đang nối với 1 kết nối (null nếu chưa nối) — để KHÔNG ghi đè mapping tay khi reconnect.
export async function connectionRiseChannelId(id: string): Promise<string | null> {
  const d = await firestore.collection(CONN).doc(id).get().catch(() => null);
  return d?.exists ? ((d.data() as any).riseChannelId ?? null) : null;
}

// Nối 1 kết nối YouTube với 1 kênh Rise (1 lần). Luồng thuộc kênh Rise đó tự biết kênh YouTube.
export async function mapConnection(id: string, riseChannelId: string | null): Promise<void> {
  await firestore.collection(CONN).doc(id).set({ riseChannelId: riseChannelId || null, updatedAt: nowISO() }, { merge: true });
}

// Cập nhật kết quả đồng bộ (youtubeState + trạng thái kết nối + lỗi).
export async function patchConnection(
  id: string,
  patch: { youtubeState?: YoutubeState; connectionState?: YoutubeConnectionState; lastSyncAt?: string; lastError?: string | null },
): Promise<void> {
  await firestore.collection(CONN).doc(id).set({ ...patch, updatedAt: nowISO() }, { merge: true });
}
