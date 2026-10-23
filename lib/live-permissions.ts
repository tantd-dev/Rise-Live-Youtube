// RISE LIVE R1 — Đợt 2 · LỚP QUYỀN THEO HÀNH ĐỘNG (thuần cộng thêm, CHƯA nối route).
// Triết lý: "Quyền rộng trong phạm vi — chỉ siết tại điểm rủi ro thật". Nhân sự làm việc
// hằng ngày nhanh, ít bước; chỉ kiểm soát mạnh ở hành động có thể gây gián đoạn.
//
// Giai đoạn chuyển tiếp: ÁNH XẠ TẠM từ quyền hiện có (riseLive / admin) sang bộ live.* +
// gói quyền — KHÔNG phá canOperateLive đang chạy. Khi bật, backend đọc lớp này; ai chưa có
// bản ghi quyền mới thì suy từ quyền cũ (không ai mất quyền giữa chừng).
import type { SessionUser } from "./session";

// ── 30 quyền chi tiết live.* (theo đề bài R1) ────────────────────────────────
export type LivePermission =
  // Xem
  | "live.dashboard.view" | "live.stream.view" | "live.media.view" | "live.incident.view"
  | "live.worker.view" | "live.metrics.view" | "live.logs.view" | "live.audit.view"
  // Vận hành luồng
  | "live.stream.create" | "live.stream.edit" | "live.stream.start" | "live.stream.stop"
  | "live.stream.restart" | "live.schedule.manage" | "live.schedule.propose" | "live.schedule.approve"
  // Video
  | "live.media.upload" | "live.media.use" | "live.media.delete"
  // Kỹ thuật
  | "live.worker.manage" | "live.stream.move" | "live.transcode.manage" | "live.alert.configure"
  | "live.destination.manage" | "live.incident.manage" | "live.stream.emergency_stop" | "live.stream.bulk_create"
  // Quản trị
  | "live.permission.manage" | "live.settings.manage" | "live.secret.replace";

// ── 6 phạm vi (theo đề bài) ──────────────────────────────────────────────────
export type LiveScope =
  | "self" | "assigned_channels" | "unit" | "descendant_units" | "company" | "explicit_channels";

// ── 5 GÓI QUYỀN (giao diện quản trị chỉ gán gói; backend map xuống live.* chi tiết) ──
const PKG1_VIEW: LivePermission[] = [
  "live.dashboard.view", "live.stream.view", "live.media.view", "live.incident.view", "live.metrics.view",
];
// "Vận hành kênh" = TOÀN QUYỀN với luồng/video TRONG PHẠM VI mình (tạo/lên sóng/DỪNG/khởi động lại/
// sửa/XOÁ + upload/dùng/xoá video + lập lịch). Phạm vi "của ai" do lớp ownsEntity chặn riêng.
const PKG2_OPERATE: LivePermission[] = [
  ...PKG1_VIEW,
  "live.media.upload", "live.media.use", "live.media.delete",
  "live.stream.create", "live.stream.edit", "live.stream.start", "live.stream.stop", "live.stream.restart",
  "live.schedule.manage", "live.schedule.propose",
];
// "Quản lý phạm vi" = Vận hành + điều hành đơn vị (duyệt lịch, tạo hàng loạt, quản sự cố/điểm đến).
const PKG3_SCOPE: LivePermission[] = [
  ...PKG2_OPERATE,
  "live.schedule.approve", "live.stream.bulk_create", "live.incident.manage", "live.destination.manage",
];
const PKG4_TECH: LivePermission[] = [
  ...PKG3_SCOPE,
  "live.worker.view", "live.worker.manage", "live.stream.move", "live.transcode.manage",
  "live.alert.configure", "live.logs.view", "live.stream.emergency_stop",
];
const PKG5_ADMIN: LivePermission[] = [
  ...PKG4_TECH,
  "live.permission.manage", "live.settings.manage", "live.secret.replace", "live.audit.view",
];

export type LivePackageId = "view" | "operate" | "scope" | "tech" | "admin";
// Gói "view" (chỉ xem) BỎ khỏi danh sách gán tay: với đội hiện tại ai vào Live Rise đều vận hành,
// không ai chỉ để xem. Quyền xem VẪN là nền của mọi gói dưới (PKG2_OPERATE gồm PKG1_VIEW) nên
// không mất gì; giữ id "view" trong type + PKG_MAP cho tương thích bản ghi cũ.
export const LIVE_PACKAGES: { id: LivePackageId; label: string; desc: string; perms: LivePermission[] }[] = [
  { id: "operate", label: "Vận hành kênh",      desc: "Upload/dùng video, tạo/sửa/start luồng, lập lịch — nhanh, không xin duyệt.", perms: PKG2_OPERATE },
  { id: "scope",   label: "Quản lý phạm vi",    desc: "Điều hành đơn vị: stop/restart, duyệt lịch, tạo hàng loạt, đóng sự cố.", perms: PKG3_SCOPE },
  { id: "tech",    label: "Kỹ thuật Live Rise", desc: "Worker/máy, chuẩn hoá, chuyển luồng, dừng khẩn, log kỹ thuật. (gói/nhiệm vụ, KHÔNG role cứng)", perms: PKG4_TECH },
  { id: "admin",   label: "Quản trị hệ thống",  desc: "Gói quyền, cấu hình, secret, audit.", perms: PKG5_ADMIN },
];

const PKG_MAP: Record<LivePackageId, LivePermission[]> = {
  view: PKG1_VIEW, operate: PKG2_OPERATE, scope: PKG3_SCOPE, tech: PKG4_TECH, admin: PKG5_ADMIN,
};
/** Gộp nhiều gói → tập quyền chi tiết. */
export function packagesToPermissions(ids: LivePackageId[]): Set<LivePermission> {
  const s = new Set<LivePermission>();
  for (const id of ids) for (const p of (PKG_MAP[id] ?? [])) s.add(p);
  return s;
}

// ── ĐIỂM RỦI RO: hành động cần xác nhận mạnh + ghi lý do + audit (dùng cho UI/backend) ──
export const LIVE_RISKY_ACTIONS: Set<LivePermission> = new Set([
  "live.stream.stop", "live.stream.emergency_stop", "live.stream.move", "live.stream.restart",
  "live.secret.replace", "live.media.delete", "live.worker.manage", "live.permission.manage",
]);
export function isRiskyLiveAction(p: LivePermission): boolean { return LIVE_RISKY_ACTIONS.has(p); }

type LiveUser = Pick<SessionUser, "role" | "permissions" | "dataScope">;
function has(user: LiveUser, p: string): boolean {
  return Array.isArray(user.permissions) && user.permissions.includes(p);
}
function isAdminLike(user: LiveUser): boolean {
  return user.role === "admin" || has(user, "admin");
}

/**
 * Gói quyền MẶC ĐỊNH suy từ quyền hiện tại (ánh xạ tạm — tương thích ngược).
 * admin → tất cả gói; riseLive + quản lý (lead/head/unit) → view+operate+scope;
 * riseLive → view+operate; còn lại → không có (khớp canOperateLive cũ).
 */
export function defaultLivePackages(user: LiveUser): LivePackageId[] {
  if (isAdminLike(user)) return ["view", "operate", "scope", "tech", "admin"];
  if (!has(user, "riseLive")) return [];
  const isManager = user.role === "lead" || user.role === "head" || user.dataScope === "unit" || user.dataScope === "team";
  return isManager ? ["view", "operate", "scope"] : ["view", "operate"];
}

/**
 * Tập quyền live.* THỰC TẾ của người dùng khi CHƯA có bản ghi gói tường minh — MẶC ĐỊNH THEO VAI TRÒ
 * (tự áp dụng, khỏi gán từng người): admin → tất cả; người có riseLive: quản lý (lead/head/phó nhóm)
 * → Vận hành + Quản lý phạm vi; nhân viên → Vận hành (toàn quyền với luồng của mình); còn lại → không có.
 * (Khi bro gán bản ghi livePermissions tường minh cho ai → backend ưu tiên bản đó.)
 */
export function livePermissionsOf(user: LiveUser): Set<LivePermission> {
  if (isAdminLike(user)) return new Set(PKG5_ADMIN);
  if (!has(user, "riseLive")) return new Set();
  const isManager = user.role === "lead" || user.role === "head" || user.role === "deputy" || user.dataScope === "unit" || user.dataScope === "team";
  return new Set(isManager ? PKG3_SCOPE : PKG2_OPERATE);
}

export function canLive(user: LiveUser, perm: LivePermission): boolean {
  return livePermissionsOf(user).has(perm);
}

/** Có được vào module Live Rise không (giữ tương thích canOperateLive cũ: admin hoặc riseLive). */
export function canUseLive(user: LiveUser): boolean {
  return isAdminLike(user) || has(user, "riseLive");
}

/** Phạm vi live suy từ dataScope Rise Work (dùng chung cây quản lý — lọc thật vẫn qua getVisibleUserEmails). */
export function liveScopeOf(user: LiveUser): LiveScope {
  if (isAdminLike(user) || user.dataScope === "company") return "company";
  if (user.dataScope === "unit" || user.dataScope === "team") return "unit";
  return "assigned_channels";
}

/** Có thấy khu KỸ THUẬT không (menu Máy/Chuẩn hoá/Metrics/Log/Cấu hình). */
export function canSeeLiveTech(user: LiveUser): boolean {
  return canLive(user, "live.worker.view") || canLive(user, "live.logs.view");
}

/** VẬN HÀNH Live = Admin/BLĐ HOẶC được cấp quyền "riseLive". Dùng chung cho các route L3 (kết nối/
 *  điều khiển YouTube) — Chủ Rise chốt 2026-08-19 mở L3 cho người vận hành Live (khỏi chỉ Admin). */
export function canOperateLive(user: any): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  const p = Array.isArray(user.permissions) ? user.permissions : [];
  return p.includes("admin") || p.includes("riseLive");
}
