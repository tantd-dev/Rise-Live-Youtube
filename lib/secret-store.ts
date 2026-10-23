// LỚP LƯU BÍ MẬT — Google Secret Manager qua REST (KHÔNG thêm dependency; dùng token của
// service account Cloud Run lấy từ metadata server). Dùng cho Rise Live L3: lưu refresh token
// OAuth YouTube. Nguyên tắc: Firestore CHỈ lưu secretRef (tên secret), giá trị thật nằm ở
// Secret Manager. KHÔNG log giá trị bí mật. CHỈ chạy server-side (Cloud Run).
//
// Yêu cầu vận hành (Chủ Rise cấp 1 lần):
//  - Bật Secret Manager API trong project.
//  - Service account runtime của Cloud Run có quyền secretmanager (admin hoặc
//    secretVersionManager + secretAccessor).

import { getGoogleAccessToken } from "@/lib/firestore";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "rise-work-503603";
const SM = "https://secretmanager.googleapis.com/v1";

async function smFetch(path: string, init: RequestInit): Promise<Response> {
  const token = await getGoogleAccessToken();
  return fetch(`${SM}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

// Tạo secret nếu chưa có (bỏ qua nếu đã tồn tại — 409).
async function ensureSecret(secretId: string): Promise<void> {
  const r = await smFetch(`projects/${PROJECT}/secrets?secretId=${encodeURIComponent(secretId)}`, {
    method: "POST",
    body: JSON.stringify({ replication: { automatic: {} } }),
  });
  if (r.ok || r.status === 409) return;
  throw new Error(`secret-store: tao secret loi (${r.status})`);
}

// GHI 1 giá trị bí mật (tạo phiên bản mới). Trả về secretRef để lưu vào Firestore.
export async function putSecretValue(secretId: string, value: string): Promise<string> {
  await ensureSecret(secretId);
  const data = Buffer.from(value, "utf8").toString("base64");
  const r = await smFetch(`projects/${PROJECT}/secrets/${encodeURIComponent(secretId)}:addVersion`, {
    method: "POST",
    body: JSON.stringify({ payload: { data } }),
  });
  if (!r.ok) throw new Error(`secret-store: ghi phien ban loi (${r.status})`);
  return secretRef(secretId);
}

// ĐỌC giá trị bí mật mới nhất (null nếu chưa có / đã xoá).
export async function getSecretValue(secretId: string): Promise<string | null> {
  const r = await smFetch(`projects/${PROJECT}/secrets/${encodeURIComponent(secretId)}/versions/latest:access`, {
    method: "GET",
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`secret-store: doc secret loi (${r.status})`);
  const j: any = await r.json();
  const data = j?.payload?.data;
  return data ? Buffer.from(String(data), "base64").toString("utf8") : null;
}

// Xoá hẳn 1 secret (khi thu hồi kết nối). Bỏ qua nếu không tồn tại.
export async function deleteSecret(secretId: string): Promise<void> {
  const r = await smFetch(`projects/${PROJECT}/secrets/${encodeURIComponent(secretId)}`, { method: "DELETE" });
  if (r.ok || r.status === 404) return;
  throw new Error(`secret-store: xoa secret loi (${r.status})`);
}

// secretRef ổn định lưu trong Firestore (KHÔNG chứa giá trị bí mật).
export function secretRef(secretId: string): string {
  return `sm://projects/${PROJECT}/secrets/${secretId}`;
}

// Tên secret cho refresh token của 1 kết nối kênh YouTube.
export function ytRefreshSecretId(connectionId: string): string {
  return `rise-live-yt-refresh-${connectionId}`;
}
