// RISE LIVE L3 — Đợt 1 · NỀN KIẾN TRÚC (thuần cộng thêm, CHƯA nối route/Firestore/API).
// Chốt theo R0 hiệu đính 16/08/2026 (Doc "R0 — Rise Live L3 YouTube"). Đây CHỈ là danh mục
// + kiểu dữ liệu + hàm THUẦN (không I/O, không gọi YouTube, không đọc/ghi Firestore, không
// đụng OAuth/secret, không chạm engine FFmpeg/Worker/Data Plane). Mục đích: khoá thuật ngữ +
// bất biến kiến trúc để các bước sau (OAuth thật, command queue, sync) bám theo — không tự
// suy diễn khác. Rủi ro thật (OAuth flow, Secret Manager, Cloud Tasks, gọi API) làm ở bước sau
// SAU khi Chủ Rise chốt mục F của R0. Nguyên tắc dự án: ID ổn định, không dùng email làm khoá.

// ── MÔ HÌNH TRẠNG THÁI 4 TRỤC (R0 mục 3) — KHÔNG gộp lifecycle với health ─────────────
// desiredState: người vận hành MUỐN gì.
export type LiveDesiredState = "RUNNING" | "STOPPED";
// lifecycleState: luồng đang ở BƯỚC nào.
export type LiveLifecycleState =
  | "DRAFT" | "PREFLIGHT" | "SOURCE_PREPARING" | "READY"
  | "SCHEDULED" | "STARTING" | "LIVE" | "ENDING"
  | "COMPLETED" | "CANCELLED" | "BLOCKED";
// healthState: luồng có hoạt động TỐT không.
export type LiveHealthState = "UNKNOWN" | "HEALTHY" | "DEGRADED" | "RECOVERING" | "FAILED";

// youtubeState: BẰNG CHỨNG chuẩn hoá từ YouTube (liveBroadcasts/liveStreams/videos). Chỉ là
// hình dạng dữ liệu — chưa có nguồn thật (Đợt 1 sau mới đổ vào qua OAuth). "stale" = dữ liệu cũ
// (API im/quota) → KHÔNG được coi là bằng chứng "đang live".
export type YoutubeState = {
  broadcastStatus?: string | null;   // testing | live | complete | revoked | created | ready …
  lifeCycleStatus?: string | null;
  streamStatus?: string | null;      // active | inactive | error | ready …
  streamHealth?: string | null;      // good | ok | bad | noData …
  isPublic?: boolean | null;
  watchUrl?: string | null;
  actualStartTime?: string | null;
  actualEndTime?: string | null;
  liveCount?: number | null;          // số buổi phát ĐANG live cùng lúc trên kênh (có thể >1)
  broadcasts?: { videoId: string; title?: string | null; watchUrl?: string | null }[];
  lastSyncAt?: string | null;
  stale?: boolean;                    // true = chưa xác minh được phía YouTube lúc này
};

export const LIVE_LIFECYCLE_LABEL: Record<LiveLifecycleState, string> = {
  DRAFT: "Nháp", PREFLIGHT: "Kiểm tra trước", SOURCE_PREPARING: "Chuẩn bị nguồn", READY: "Sẵn sàng",
  SCHEDULED: "Đã đặt lịch", STARTING: "Đang lên sóng", LIVE: "Đang phát", ENDING: "Đang kết thúc",
  COMPLETED: "Đã kết thúc", CANCELLED: "Đã huỷ", BLOCKED: "Bị chặn",
};
export const LIVE_HEALTH_LABEL: Record<LiveHealthState, string> = {
  UNKNOWN: "Chưa rõ", HEALTHY: "Tốt", DEGRADED: "Yếu/chập chờn", RECOVERING: "Đang phục hồi", FAILED: "Hỏng",
};

// ── controlMode (R0 mục 4) — AI là chủ điều khiển lên/xuống sóng ──────────────────────
export type LiveControlMode = "YOUTUBE_AUTO" | "RISE_MANAGED" | "MANUAL_STUDIO";
export const LIVE_CONTROL_MODES: { id: LiveControlMode; label: string; desc: string }[] = [
  { id: "YOUTUBE_AUTO",  label: "YouTube tự động",  desc: "YouTube Auto Start/Stop là chủ điều khiển; Rise chỉ quan sát + đối soát, KHÔNG gọi transition." },
  { id: "RISE_MANAGED",  label: "Rise điều khiển",  desc: "Rise gọi API transition; cấu hình YouTube phải tương thích (tắt Auto Start/Stop xung khắc)." },
  { id: "MANUAL_STUDIO", label: "Thủ công (Studio)", desc: "Người dùng thao tác trên Studio; Rise chỉ quan sát + reconcile." },
];

// ── Trạng thái kết nối OAuth của 1 kênh (R0 mục 6) ────────────────────────────────────
export type YoutubeConnectionState =
  | "CONNECTED" | "DEGRADED" | "EXPIRED" | "REVOKED" | "REAUTH_REQUIRED";
export const YOUTUBE_CONNECTION_LABEL: Record<YoutubeConnectionState, string> = {
  CONNECTED: "Đã kết nối", DEGRADED: "Kết nối trục trặc", EXPIRED: "Hết hạn",
  REVOKED: "Bị thu hồi", REAUTH_REQUIRED: "Cần kết nối lại",
};

// ── Loại lệnh điều khiển (R0 mục 10) — đi qua hàng đợi bền vững (Cloud Tasks/Pub-Sub) ──
export type LiveCommandType =
  | "CREATE_BROADCAST" | "CREATE_STREAM" | "BIND_STREAM"
  | "START_WORKER" | "TRANSITION_TESTING" | "TRANSITION_LIVE"
  | "STOP_WORKER" | "COMPLETE_BROADCAST"
  | "MOVE_STREAM" | "REPLACE_DESTINATION" | "RECONNECT_OAUTH";
// Lệnh "điều khiển" (thay đổi trạng thái luồng) — bất biến: 1 luồng tại 1 thời điểm CHỈ 1 lệnh
// điều khiển hiệu lực. (RECONNECT_OAUTH tác động theo kết nối, không tính theo luồng.)
const CONTROL_COMMANDS = new Set<LiveCommandType>([
  "CREATE_BROADCAST", "CREATE_STREAM", "BIND_STREAM", "START_WORKER",
  "TRANSITION_TESTING", "TRANSITION_LIVE", "STOP_WORKER", "COMPLETE_BROADCAST",
  "MOVE_STREAM", "REPLACE_DESTINATION",
]);
export function isControlCommand(t: LiveCommandType): boolean { return CONTROL_COMMANDS.has(t); }

// ── Quyền live.youtube.* (R0 mục 9) — CHỈ danh mục id, CHƯA nối vào enforcement live.* ─
export const LIVE_YOUTUBE_PERMISSIONS = [
  "live.youtube.connection.view", "live.youtube.status.view", "live.youtube.mapping.view",
  "live.youtube.connection.create", "live.youtube.reconnect", "live.youtube.disconnect", "live.youtube.assign",
  "live.youtube.broadcast.create", "live.youtube.broadcast.edit", "live.youtube.broadcast.bind",
  "live.youtube.broadcast.transition", "live.youtube.broadcast.complete", "live.youtube.broadcast.bulk_create",
  "live.youtube.destination.manage", "live.youtube.secret.replace",
  "live.youtube.sync.run", "live.youtube.mapping.manage",
  "live.youtube.incident.view", "live.youtube.incident.manage", "live.youtube.stream.emergency_stop",
  "live.youtube.controlmode.change",
] as const;
export type LiveYoutubePermission = typeof LIVE_YOUTUBE_PERMISSIONS[number];

// ── HÀM THUẦN 1: hiển thị sức khoẻ từ TỔ HỢP 4 trục (R0: "không đồng nhất đang phát với khỏe") ─
// Trả nhãn + verifiedOnYoutube (đã xác minh phía YouTube chưa) + tone. KHÔNG I/O.
export function resolveDisplayHealth(a: {
  desiredState: LiveDesiredState; lifecycleState: LiveLifecycleState;
  healthState: LiveHealthState; youtube?: YoutubeState | null;
}): { label: string; verifiedOnYoutube: boolean; tone: "ok" | "warn" | "bad" | "idle" } {
  const yt = a.youtube ?? null;
  const ytLiveFresh = !!yt && yt.broadcastStatus === "live" && yt.stale !== true;
  if (a.lifecycleState === "LIVE") {
    if (a.healthState === "DEGRADED") return { label: "Đang phát nhưng tín hiệu yếu", verifiedOnYoutube: ytLiveFresh, tone: "warn" };
    if (a.healthState === "FAILED") return { label: "Đang phát nhưng lỗi", verifiedOnYoutube: false, tone: "bad" };
    if (a.healthState === "HEALTHY" && ytLiveFresh) return { label: "Đang phát tốt", verifiedOnYoutube: true, tone: "ok" };
    // L1/L2 ổn nhưng chưa/không xác minh được phía YouTube (API im, quota, stale)
    return { label: "Đang đẩy dữ liệu — chưa xác minh phía YouTube", verifiedOnYoutube: false, tone: "warn" };
  }
  if (a.healthState === "FAILED") return { label: "Hỏng", verifiedOnYoutube: false, tone: "bad" };
  if (a.healthState === "RECOVERING") return { label: "Đang phục hồi", verifiedOnYoutube: false, tone: "warn" };
  if (a.lifecycleState === "STARTING") return { label: "Đang lên sóng…", verifiedOnYoutube: false, tone: "warn" };
  return { label: LIVE_LIFECYCLE_LABEL[a.lifecycleState] ?? "Chưa rõ", verifiedOnYoutube: false, tone: "idle" };
}

// ── HÀM THUẦN 2: preflight phát hiện XUNG ĐỘT controlMode với cấu hình YouTube (R0 mục 4) ─
// Trả lý do xung đột (chuỗi) hoặc null nếu tương thích. KHÔNG để YouTube Auto Start/Stop và
// Rise API tranh quyền.
export function controlModeConflict(
  mode: LiveControlMode,
  ytConfig: { enableAutoStart?: boolean | null; enableAutoStop?: boolean | null },
): string | null {
  const autoStart = ytConfig.enableAutoStart === true;
  const autoStop = ytConfig.enableAutoStop === true;
  if (mode === "RISE_MANAGED" && (autoStart || autoStop))
    return "controlMode = Rise điều khiển nhưng YouTube Auto Start/Stop đang BẬT → sẽ tranh quyền. Tắt Auto Start/Stop trên YouTube.";
  if (mode === "YOUTUBE_AUTO" && !autoStart)
    return "controlMode = YouTube tự động nhưng Auto Start đang TẮT → luồng sẽ không tự lên sóng. Bật Auto Start hoặc đổi sang Rise điều khiển.";
  return null;
}
