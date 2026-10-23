// RISE LIVE R1.1 — NỀN DỮ LIỆU (danh mục + công thức + lệnh FFmpeg đã kiểm chứng).
// THUẦN CỘNG THÊM — KHÔNG đọc/ghi Firestore, KHÔNG nối route/màn hình nào. Đây là lớp NỀN:
// định nghĩa mô hình ID ổn định cho Máy / Video / Luồng live + preset chất lượng + công thức
// tính công suất an toàn, để các bước R1.2+ (route, worker agent, giao diện) tham chiếu.
//
// Bám các quyết định đã CHỐT (buổi dựng hạ tầng Live Rise 2026-08-13/14, đo thật trên VPS netcup):
//  - Ổn định > số lượng: mỗi máy chạy ~60% băng thông đo được (chừa dự phòng), KHÔNG nhồi 100%.
//  - Copy-codec (không encode lại lúc live) → CPU cực nhẹ; TRẦN THẬT là băng thông.
//  - Chuẩn hoá 1 lần (source 4K/60fps/20Mbps → 1080p hoặc 4K, bitrate mục tiêu) rồi live copy-codec.
//  - "Nhãn 4K giá rẻ": YouTube gắn nhãn theo ĐỘ PHÂN GIẢI, không theo bitrate → gửi 4K @ ~6 Mbps
//    vẫn hiện "2160p 4K" mà nhẹ như 1080p (điều kiện: khoá YouTube cấu hình 4K, khung hình khớp).
//  - Kiến trúc 2 tầng: dàn 24/7 (nhiều máy) + máy live-nhả riêng (bật/tắt, tải→live→xoá).
//
// Quy tắc ID: tiền tố hằng định, KHÔNG dùng tên/tiếng Việt làm khóa — "livepreset:", "livemachine:".

// ─────────────────────────────────────────────────────────────────────────────
// 1) PRESET CHẤT LƯỢNG — nhịp chọn "chất lượng ↔ số luồng/máy" cho từng kênh.
// ─────────────────────────────────────────────────────────────────────────────
export type YtResolutionTier = "1080p" | "1440p" | "2160p"; // nhãn YouTube hiển thị (theo độ phân giải)

export interface LiveQualityPreset {
  id: string;                 // "livepreset:*"
  label: string;              // hiện cho người dùng
  width: number;              // độ phân giải khung hình
  height: number;
  fps: 30 | 60;
  videoBitrateKbps: number;   // bitrate video mục tiêu (với keepOriginal = ước tính cho tính sức chứa)
  audioBitrateKbps: number;
  ytTier: YtResolutionTier;   // nhãn YouTube (2160p = có "4K")
  note: string;               // giải thích ngắn (đánh đổi)
  keepOriginal?: boolean;     // true = KHÔNG nén hình (copy nguyên gốc) + chỉ chuẩn audio AAC
}

// Các preset đã kiểm chứng tối nay. videoBitrate ở mức đã test THẬT lên YouTube "Xuất sắc".
export const LIVE_QUALITY_PRESETS: LiveQualityPreset[] = [
  { id: "livepreset:1080p-6m", label: "1080p Chuẩn", width: 1920, height: 1080, fps: 30, videoBitrateKbps: 6000, audioBitrateKbps: 256, ytTier: "1080p", note: "Mức cân bằng — chạy được nhiều luồng nhất." },
  { id: "livepreset:1080p-4m", label: "1080p Nhẹ", width: 1920, height: 1080, fps: 30, videoBitrateKbps: 4500, audioBitrateKbps: 256, ytTier: "1080p", note: "Tốn ít băng thông hơn — hợp hình tĩnh, nhạc nền." },
  { id: "livepreset:4k-badge-6m", label: "4K (nhãn) Nhẹ", width: 3840, height: 2160, fps: 30, videoBitrateKbps: 6000, audioBitrateKbps: 256, ytTier: "2160p", note: "Hiện nhãn 4K nhưng dữ liệu nhẹ như 1080p — hợp hình tĩnh, nhạc nền." },
  { id: "livepreset:4k-badge-10m", label: "4K (nhãn) Cao", width: 3840, height: 2160, fps: 30, videoBitrateKbps: 10000, audioBitrateKbps: 256, ytTier: "2160p", note: "Hiện nhãn 4K, hình tốt, chuyển động ổn — tốn băng thông hơn." },
  { id: "livepreset:4k-true-20m", label: "4K Thật", width: 3840, height: 2160, fps: 30, videoBitrateKbps: 20000, audioBitrateKbps: 256, ytTier: "2160p", note: "4K đúng mức YouTube khuyến nghị — tốn băng thông, chạy ít luồng." },
  { id: "livepreset:original", label: "Giữ nguyên gốc", width: 3840, height: 2160, fps: 30, videoBitrateKbps: 22000, audioBitrateKbps: 256, ytTier: "2160p", keepOriginal: true, note: "Giữ y hình gốc, không xử lý lại — đẹp nhất, tốn băng thông nhất. Chỉ dùng khi máy còn dư nhiều." },
];

export function resolveLivePreset(id: string): LiveQualityPreset | null {
  return LIVE_QUALITY_PRESETS.find((p) => p.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) MÁY LIVE (VPS) — đăng ký máy + vai trò.
// ─────────────────────────────────────────────────────────────────────────────
export type LiveMachineRole = "stream-247" | "live-pub" | "shared"; // Live 24/7 · Live Pub · Dùng chung

export interface LiveMachine {
  id: string;                 // "livemachine:*"
  name: string;               // "VPS TEST RISE LIVE"
  ip: string;
  role: LiveMachineRole;
  vcpu: number;
  ramGb: number;
  diskGb: number;
  uploadMbps: number;         // băng thông đẩy ĐO ĐƯỢC (không đoán)
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) VIDEO (asset) — nguồn + bản đã chuẩn hoá.
// ─────────────────────────────────────────────────────────────────────────────
export type LiveAssetStatus = "pending" | "downloading" | "normalizing" | "ready" | "error";

export interface LiveAsset {
  id: string;
  name: string;
  sourceUrl: string;          // link Google Drive (chia sẻ "ai có link")
  presetId: string;           // preset chuẩn hoá
  status: LiveAssetStatus;
  normalizedPath?: string;    // đường dẫn file đã nén trên máy
  durationSec?: number;
  sizeMb?: number;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) LUỒNG LIVE — 1 video đẩy lên 1 kênh, trên 1 máy.
// ─────────────────────────────────────────────────────────────────────────────
export type LiveStreamMode = "stream-247" | "live-pub";
export type LiveStreamStatus = "queued" | "starting" | "live" | "stopping" | "stopped" | "error";
export type LiveHealth = "excellent" | "good" | "poor" | "nodata" | "unknown";

export interface LiveStream {
  id: string;
  name: string;
  assetId: string;
  machineId: string;
  presetId: string;
  mode: LiveStreamMode;
  rtmpBase: string;           // vd rtmp://a.rtmp.youtube.com/live2
  // KHÔNG lưu stream key thô ở nơi lộ; ở R1.1 chỉ định nghĩa hình dạng, R1.x sẽ mã hoá/che.
  status: LiveStreamStatus;
  health: LiveHealth;
  startedAt?: string;
  lastHeartbeatAt?: string;
  restarts?: number;          // số lần tự khởi động lại (theo dõi ổn định)
}

export const YOUTUBE_RTMP_BASE = "rtmp://a.rtmp.youtube.com/live2";

// ── LỊCH PHÁT (hẹn giờ) — cho live-pub theo khung giờ ────────────────────────
export type ScheduleRepeat = "none" | "daily";
export interface LiveSchedule {
  start: string;          // "YYYY-MM-DDTHH:mm" (giờ VN) — không tz thì hiểu là +07:00
  durationMin: number;    // thời lượng 1 lần (phút). 0 = MỞ (Live 24/7: chạy liên tục từ giờ bắt đầu)
  repeat: ScheduleRepeat; // 1 lần hay lặp hằng ngày (chỉ áp dụng Live Pub)
}
const VN_OFFSET = "+07:00";
const DAY_MS = 86400000;
// Chuẩn hoá thời điểm bắt đầu → mili giây tuyệt đối (thiếu tz thì gán giờ VN).
function startMs(start: string): number {
  const s = String(start ?? "");
  const withTz = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + VN_OFFSET;
  const t = Date.parse(withTz);
  return Number.isFinite(t) ? t : NaN;
}
// Bây giờ có nằm TRONG khung giờ lịch không? (thuần, truyền nowMs để test được)
export function isWithinSchedule(sch: LiveSchedule | null | undefined, nowMs: number): boolean {
  if (!sch || !sch.start) return false;
  const st = startMs(sch.start); if (!Number.isFinite(st)) return false;
  if (nowMs < st) return false;                       // chưa tới giờ bắt đầu
  if (!(sch.durationMin > 0)) return true;            // Live 24/7 hẹn giờ: MỞ — phát liên tục từ giờ bắt đầu
  const durMs = sch.durationMin * 60000;
  if (sch.repeat === "daily") return ((nowMs - st) % DAY_MS) < durMs; // Live Pub cùng giờ mỗi ngày
  return nowMs < st + durMs;                          // Live Pub 1 lần
}
// Mốc BẮT ĐẦU của KHUNG GIỜ đang chạy (để "Live từ" ổn định suốt khung, kể cả khi tự kết nối lại;
// sang khung mới/ngày mới mới đổi). null nếu hiện KHÔNG trong khung. 24/7 mở & Pub 1 lần → mốc gốc.
export function currentScheduleStartMs(sch: LiveSchedule | null | undefined, nowMs: number): number | null {
  if (!isWithinSchedule(sch, nowMs)) return null;
  const st = startMs(sch!.start); if (!Number.isFinite(st)) return null;
  if (sch!.durationMin > 0 && sch!.repeat === "daily") { const k = Math.floor((nowMs - st) / DAY_MS); return st + k * DAY_MS; }
  return st;
}
// Lần phát KẾ TIẾP (ms) để hiển thị "sắp phát lúc…"; null nếu đã qua (none) .
export function nextScheduleStartMs(sch: LiveSchedule | null | undefined, nowMs: number): number | null {
  if (!sch || !sch.start) return null;
  const st = startMs(sch.start); if (!Number.isFinite(st)) return null;
  if (nowMs < st) return st;                          // sắp phát
  if (sch.durationMin > 0 && sch.repeat === "daily") { const k = Math.ceil((nowMs - st) / DAY_MS); return st + k * DAY_MS; }
  return null; // đã bắt đầu (24/7 mở, hoặc Live Pub 1 lần đã qua)
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) CÔNG THỨC CÔNG SUẤT AN TOÀN (thuần, đã kiểm chứng bằng đo thật).
// ─────────────────────────────────────────────────────────────────────────────
export const RTMP_OVERHEAD = 1.05;     // hao phí đóng gói RTMP/TCP ~5%
export const DEFAULT_SAFETY_FACTOR = 0.7; // dùng ~70% băng thông (chừa 30% dự phòng) — khớp mức đã chốt

// Băng thông 1 luồng cần (Mbps), gồm cả hao phí.
export function streamBandwidthMbps(preset: LiveQualityPreset): number {
  const raw = (preset.videoBitrateKbps + preset.audioBitrateKbps) / 1000; // Mbps
  return Math.round(raw * RTMP_OVERHEAD * 100) / 100;
}

// Số luồng AN TOÀN trên 1 máy = uploadMbps × safety ÷ bandwidth/luồng (làm tròn xuống).
export function safeStreamsPerMachine(uploadMbps: number, preset: LiveQualityPreset, safety = DEFAULT_SAFETY_FACTOR): number {
  const per = streamBandwidthMbps(preset);
  if (per <= 0 || uploadMbps <= 0) return 0;
  return Math.max(0, Math.floor((uploadMbps * safety) / per));
}

// Số máy cần cho tổng luồng, + dự phòng N+redundancy (để 1 máy chết vẫn đủ).
export function machinesNeeded(totalStreams: number, perMachine: number, redundancy = 1): number {
  if (perMachine <= 0) return 0;
  return Math.ceil(totalStreams / perMachine) + redundancy;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) LỆNH FFMPEG (đã kiểm chứng THẬT lên YouTube "Xuất sắc"). Trả mảng tham số (argv).
// ─────────────────────────────────────────────────────────────────────────────
// Chuẩn hoá 1 lần: source → bản stream (độ phân giải + bitrate theo preset), keyframe 2s để
// copy-codec mượt. minrate ép không tụt bitrate (đoạn động đủ bit). 30fps giảm nửa tải.
export function normalizeFfmpegArgs(inputPath: string, outputPath: string, preset: LiveQualityPreset): string[] {
  // GIỮ NGUYÊN HÌNH: copy video (không nén) + chỉ chuẩn audio AAC.
  if (preset.keepOriginal) {
    return ["-y", "-i", inputPath, "-c:v", "copy", "-c:a", "aac", "-b:a", `${preset.audioBitrateKbps}k`,
      "-ar", "44100", "-movflags", "+faststart", outputPath];
  }
  const gop = String(preset.fps * 2); // keyframe mỗi 2 giây
  return [
    "-y", "-i", inputPath,
    "-vf", `scale=${preset.width}:${preset.height}`,
    "-r", String(preset.fps),
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-b:v", `${preset.videoBitrateKbps}k`,
    "-minrate", `${Math.round(preset.videoBitrateKbps * 0.83)}k`,
    "-maxrate", `${Math.round(preset.videoBitrateKbps * 1.17)}k`,
    "-bufsize", `${preset.videoBitrateKbps * 2}k`,
    "-g", gop, "-keyint_min", gop, "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", `${preset.audioBitrateKbps}k`, "-ar", "44100",
    "-movflags", "+faststart", outputPath,
  ];
}

// Đẩy live: copy-codec (không encode lại), lặp vô tận, -nostdin để chạy nền không bị treo.
export function streamFfmpegArgs(inputPath: string, rtmpBase: string, streamKey: string): string[] {
  return [
    "-nostdin", "-re", "-stream_loop", "-1", "-i", inputPath,
    "-c", "copy", "-f", "flv", `${rtmpBase}/${streamKey}`,
  ];
}
