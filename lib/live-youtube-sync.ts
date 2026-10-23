// RISE LIVE L3 — Đợt 1 · ĐỒNG BỘ ĐỌC (mức kênh). Đổi refresh token -> access token rồi hỏi
// YouTube kênh có đang live không. CHỈ ĐỌC, không điều khiển. Lỗi ở đây KHÔNG chạm FFmpeg.
import type { YoutubeState } from "@/lib/live-youtube-catalog";

const nowISO = () => new Date().toISOString();

export class ReauthNeeded extends Error {}

// Đổi refresh token lấy access token mới (access token sống ~1 giờ, không lưu — dùng xong bỏ).
export async function accessTokenFromRefresh(refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Chưa cấu hình OAuth client trên máy chủ.");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
  });
  if (!r.ok) {
    const j: any = await r.json().catch(() => ({}));
    // Token bị thu hồi / hết hiệu lực -> cần kết nối lại
    if (j?.error === "invalid_grant") throw new ReauthNeeded("Kết nối đã bị thu hồi — cần kết nối lại.");
    throw new Error(`Làm mới token lỗi (${r.status}).`);
  }
  const j: any = await r.json();
  if (!j?.access_token) throw new Error("Không nhận được access token.");
  return String(j.access_token);
}

// ── ĐỢT 2 — ĐIỀU KHIỂN (ghi) ──────────────────────────────────────────────────
// Kiểm trạng thái vòng đời 1 buổi phát (an toàn TRƯỚC khi kết thúc): live/liveStarting/
// complete/testing/... Trả null nếu không đọc được / không tồn tại.
export async function getBroadcastLifecycle(accessToken: string, broadcastId: string): Promise<string | null> {
  const r = await fetch(
    `https://www.googleapis.com/youtube/v3/liveBroadcasts?part=status&id=${encodeURIComponent(broadcastId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!r.ok) return null;
  const j: any = await r.json();
  return j?.items?.[0]?.status?.lifeCycleStatus ?? null;
}

// KẾT THÚC 1 buổi phát (transition → complete). Idempotent: nếu đã complete/redundant thì coi
// như xong. CHỈ gọi khi đã xác minh đúng buổi phát + đang live (xem control route).
export async function completeBroadcast(accessToken: string, broadcastId: string): Promise<{ lifeCycleStatus?: string | null }> {
  const r = await fetch(
    `https://www.googleapis.com/youtube/v3/liveBroadcasts/transition?broadcastStatus=complete&id=${encodeURIComponent(broadcastId)}&part=id,status`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!r.ok) {
    const j: any = await r.json().catch(() => ({}));
    const reason = j?.error?.errors?.[0]?.reason || j?.error?.message || "";
    if (/redundantTransition|invalidTransition/i.test(String(reason))) return { lifeCycleStatus: "complete" };  // đã kết thúc rồi
    throw new Error(`Kết thúc buổi phát lỗi (${r.status}${reason ? ": " + reason : ""}).`);
  }
  const j: any = await r.json();
  return { lifeCycleStatus: j?.status?.lifeCycleStatus ?? null };
}

// LÊN SÓNG 1 buổi phát (transition → live). Idempotent: đã live → coi như xong. Buổi phát phải đang
// nhận tín hiệu (stream active) + ở trạng thái testing/ready; chưa có tín hiệu → YouTube trả lỗi (báo rõ).
export async function goLiveBroadcast(accessToken: string, broadcastId: string): Promise<{ lifeCycleStatus?: string | null }> {
  const r = await fetch(
    `https://www.googleapis.com/youtube/v3/liveBroadcasts/transition?broadcastStatus=live&id=${encodeURIComponent(broadcastId)}&part=id,status`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!r.ok) {
    const j: any = await r.json().catch(() => ({}));
    const reason = j?.error?.errors?.[0]?.reason || j?.error?.message || "";
    if (/redundantTransition/i.test(String(reason))) return { lifeCycleStatus: "live" };  // đã live rồi
    throw new Error(`Lên sóng lỗi (${r.status}${reason ? ": " + reason : ""}).`);
  }
  const j: any = await r.json();
  return { lifeCycleStatus: j?.status?.lifeCycleStatus ?? null };
}

// ── BƯỚC 2 (bảo vệ Pub): đọc/ghi "auto-stop" của buổi phát ──────────────────────
// enableAutoStop = YouTube TỰ kết thúc buổi phát ~1 phút sau khi mất tín hiệu. Muốn CỨU được luồng
// Pub khi máy sự cố thì phải TẮT auto-stop (để buổi phát treo chờ tín hiệu). Chỉ dùng cho buổi phát
// dạng "sự kiện" (Pub hẹn giờ); buổi "phát ngay/persistent" (24/7) không có auto-stop.
export async function getBroadcastContentDetails(
  accessToken: string, broadcastId: string,
): Promise<{ contentDetails: any; lifeCycleStatus: string | null } | null> {
  const r = await fetch(
    `https://www.googleapis.com/youtube/v3/liveBroadcasts?part=contentDetails,status&id=${encodeURIComponent(broadcastId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!r.ok) return null;
  const j: any = await r.json();
  const item = j?.items?.[0];
  return item ? { contentDetails: item.contentDetails ?? {}, lifeCycleStatus: item.status?.lifeCycleStatus ?? null } : null;
}

// Đặt auto-stop cho 1 buổi phát. LƯU Ý (YouTube docs): liveBroadcasts.update GHI ĐÈ MỌI thuộc tính
// mutable của part được chỉ định → phải ĐỌC contentDetails hiện có, GIỮ NGUYÊN field khác, chỉ đổi
// enableAutoStop (bỏ field chỉ-đọc kẻo bị từ chối). Idempotent: đặt lại đúng giá trị mong muốn.
export async function setBroadcastAutoStop(
  accessToken: string, broadcastId: string, enable: boolean,
): Promise<{ enableAutoStop: boolean }> {
  const cur = await getBroadcastContentDetails(accessToken, broadcastId);
  if (!cur) throw new Error("Không đọc được buổi phát trên kênh này (mã không thuộc kênh?).");
  const cd: any = { ...(cur.contentDetails ?? {}) };
  delete cd.boundStreamId; delete cd.boundStreamLastUpdateTimeMs;   // field CHỈ-ĐỌC
  if (cd.monitorStream) { const ms = { ...cd.monitorStream }; delete ms.embedHtml; cd.monitorStream = ms; }
  cd.enableAutoStop = enable;
  const r = await fetch(
    "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=contentDetails,id",
    { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: broadcastId, contentDetails: cd }) },
  );
  if (!r.ok) {
    const j: any = await r.json().catch(() => ({}));
    const reason = j?.error?.errors?.[0]?.reason || j?.error?.message || "";
    throw new Error(`Đổi auto-stop lỗi (${r.status}${reason ? ": " + reason : ""}).`);
  }
  const j: any = await r.json();
  return { enableAutoStop: Boolean(j?.contentDetails?.enableAutoStop) };
}

// Hỏi YouTube: kênh (của access token này) có buổi phát ĐANG LIVE không.
// broadcastStatus=active => chỉ trả các buổi đang phát. Trống => không live lúc này.
export async function fetchChannelLiveState(accessToken: string): Promise<YoutubeState> {
  // LƯU Ý: liveBroadcasts.list — mine/id/broadcastStatus là bộ lọc LOẠI TRỪ nhau (dùng chung
  // mine + broadcastStatus -> 400). broadcastStatus=active đã trả broadcast của kênh đang đăng
  // nhập; broadcastType=all để gồm cả buổi phát thường lẫn "persistent" (24/7).
  const r = await fetch(
    "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&broadcastStatus=active&broadcastType=all&maxResults=50",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!r.ok) {
    const j: any = await r.json().catch(() => ({}));
    const reason = j?.error?.errors?.[0]?.reason || j?.error?.message || "";
    throw new Error(`Đọc trạng thái live lỗi (${r.status}${reason ? ": " + reason : ""}).`);
  }
  const j: any = await r.json();
  const items = (j?.items ?? []) as any[];
  if (!items.length) return { broadcastStatus: "none", liveCount: 0, broadcasts: [], lastSyncAt: nowISO(), stale: false };
  // 1 kênh có thể có NHIỀU buổi phát live cùng lúc -> giữ đủ danh sách + đếm.
  const broadcasts = items.slice(0, 20).map((it) => ({
    videoId: String(it?.id ?? ""),
    title: it?.snippet?.title ?? null,
    watchUrl: it?.id ? `https://www.youtube.com/watch?v=${it.id}` : null,
  }));
  const first = items[0];
  return {
    broadcastStatus: "live",
    liveCount: items.length,
    broadcasts,
    lifeCycleStatus: first?.status?.lifeCycleStatus ?? null,
    isPublic: first?.status?.privacyStatus === "public",
    watchUrl: broadcasts[0]?.watchUrl ?? null,
    actualStartTime: first?.snippet?.actualStartTime ?? null,
    lastSyncAt: nowISO(),
    stale: false,
  };
}
