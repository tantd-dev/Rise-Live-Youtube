import type { SessionUser } from "@/lib/session";
import { firestore } from "@/lib/firestore";

export const permissionOptions = [
  "overview",
  "channels",
  "reports",
  "evaluations",
  "people",
  "expertLedger",
  "compensation",
  "musicProduction",
  "career",
  "admin",
  "cmsInventory",
  "riseLive",
] as const;

export type Permission = (typeof permissionOptions)[number];
export type DataScope = "self" | "team" | "unit" | "company";

export function isHrLeadership(role: string, unit = "") {
  return role === "hr" || (role === "head" && unit === "Hành chính – Nhân sự");
}

// Trưởng phòng Kế toán (baseRole "head", unit "Kế toán") vẫn phải giữ
// phạm vi xem dữ liệu tài chính TOÀN CÔNG TY như nhân viên Kế toán thường —
// vì bản chất công việc kế toán/đối soát không thể chỉ giới hạn trong 1
// "team" như các Trưởng phòng nội dung khác. Không xử lý riêng thì đổi
// baseRole sang "head" sẽ VÔ TÌNH làm mất quyền xem toàn công ty.
export function isAccountingLeadership(role: string, unit = "") {
  return role === "head" && unit === "Kế toán";
}

export function defaultAccess(role: string, unit = ""): { permissions: Permission[]; dataScope: DataScope } {
  const a = defaultAccessBase(role, unit);
  // ĐƠN VỊ SẢN XUẤT NHẠC: mọi vị trí (kể cả nhân viên/phó nhóm) làm việc ở module "Sản xuất nhạc",
  // KHÔNG vận hành kênh CMS. → BỎ 'channels' (menu Kênh + KPI kênh/doanh thu ở Tổng quan tự ẩn),
  // THÊM 'musicProduction' (trước đây thiếu với nhân viên SX nhạc). Giữ 'reports' cho báo cáo đơn vị/cá nhân.
  if (unit === "Sản xuất nhạc" && !["admin", "hr", "accounting"].includes(role)) {
    const perms = a.permissions.filter((p) => p !== "channels");
    if (!perms.includes("musicProduction")) perms.push("musicProduction");
    return { permissions: perms, dataScope: a.dataScope };
  }
  return a;
}

function defaultAccessBase(role: string, unit = ""): { permissions: Permission[]; dataScope: DataScope } {
  // ĐỐI TÁC NGOÀI (MC-6): người ngoài công ty — KHÔNG có quyền nội bộ nào (chặn mọi module),
  // chỉ vào Kho nhạc (menu musicLibrary mở cho mọi phiên; quyền xem/nghe/tải trong kho do canDoMusic
  // theo cấp quyền partner_scope quyết định). dataScope self để không lọt dữ liệu người khác.
  if (role === "partner") return { permissions: [], dataScope: "self" };
  if (role === "admin") return { permissions: [...permissionOptions], dataScope: "company" };
  if (isHrLeadership(role, unit)) return { permissions: ["overview", "evaluations", "people", "compensation", "career"], dataScope: "company" };
  if (isAccountingLeadership(role, unit)) return { permissions: ["overview", "reports", "evaluations", "people", "expertLedger", "compensation", "career"], dataScope: "company" };
  if (role === "accounting") return { permissions: ["overview", "reports", "expertLedger", "compensation", "musicProduction", "career"], dataScope: "company" };
  if (role === "head") return { permissions: ["overview", "channels", "reports", "evaluations", "people", "expertLedger", "compensation", ...(unit === "Sản xuất nhạc" ? ["musicProduction" as Permission] : []), "career"], dataScope: "team" };
  if (role === "lead") return { permissions: ["overview", "channels", "reports", "evaluations", "people", "expertLedger", "compensation", ...(unit === "Sản xuất nhạc" ? ["musicProduction" as Permission] : []), "career"], dataScope: "team" };
  if (role === "deputy") return { permissions: ["overview", "channels", "reports", "evaluations", "people", "expertLedger", "compensation", "career"], dataScope: "team" };
  if (role === "expert") return { permissions: ["overview", "channels", "reports", "evaluations", "expertLedger", "compensation", ...(unit === "Sản xuất nhạc" ? ["musicProduction" as Permission] : []), "career"], dataScope: "self" };
  if (role === "solo") return { permissions: ["overview", "channels", "reports", "evaluations", "compensation", "career"], dataScope: "self" };
  return { permissions: ["overview", "channels", "reports", "evaluations", "compensation", "career"], dataScope: "self" };
}

export function hasPermission(user: SessionUser, permission: Permission) {
  return user.role === "admin" || (user.role === "accounting" && permission === "compensation") || (isAccountingLeadership(user.role, user.unit) && permission === "compensation") || user.permissions.includes(permission);
}

export function canAccessRecord(
  user: SessionUser,
  record: { unit?: string; ownerEmail?: string; assignedEmails?: string[] },
  visibleEmails?: Set<string>,
) {
  if (user.role === "admin" || user.dataScope === "company") return true;
  if (user.dataScope === "unit") return record.unit === user.unit;
  if (user.dataScope === "team") {
    const emails = visibleEmails ?? new Set([user.email]);
    return emails.has(record.ownerEmail ?? "") || record.assignedEmails?.some((email) => emails.has(email)) === true;
  }
  return record.ownerEmail === user.email || record.assignedEmails?.includes(user.email) === true;
}

// R2.1 Pha B — Phó nhóm: phạm vi quản lý = ĐÚNG những người được gán trong bổ nhiệm (Decision Log
// D-01, tài liệu 05 mục 9). Đọc từ professionalAssignments (đã gán ở R2.1 Pha A qua /admin-deputy-scope).
// Chưa gán ai → chỉ thấy bản thân. CHỈ đọc, không ghi.
async function getDeputyManagedEmails(email: string): Promise<string[]> {
  const snap = await firestore.collection("professionalAssignments").where("personEmailRef", "==", email).limit(5).get();
  const doc = snap.docs.find((d) => d.data()?.activeAppointment?.appointmentTypeId === "appointment:deputy-team-lead");
  const managed = doc?.data()?.activeAppointment?.managedPersonEmails;
  return Array.isArray(managed) ? managed.map(String) : [];
}

// R2.1 — Chuyên gia: những người được giao HỖ TRỢ/thẩm định (view-only). Đọc từ professionalAssignments.
async function getExpertSupportEmails(email: string): Promise<string[]> {
  const snap = await firestore.collection("professionalAssignments").where("personEmailRef", "==", email).limit(5).get();
  const doc = snap.docs.find((d) => d.data()?.positionId === "position:expert");
  const support = doc?.data()?.supportPersonEmails;
  return Array.isArray(support) ? support.map(String) : [];
}

// Phạm vi được phép GIAO VIỆC cho (khác với phạm vi XEM dữ liệu). Chỉ BLĐ (role admin) mới giao
// toàn công ty. HR/Kế toán có company-scope để XEM dữ liệu của họ, nhưng KHÔNG giao việc toàn công
// ty — giới hạn về ĐƠN VỊ của họ. Quản lý/nhân viên dùng phạm vi quản lý thường (getVisibleUserEmails).
// Trả null = không giới hạn (toàn công ty). Dùng cho ô chọn người nhận việc (VD ở Họp).
export async function getAssignableEmails(user: SessionUser): Promise<Set<string> | null> {
  if (user.role === "admin") return null;
  // HCNS (đầu mối vận hành) — được giao việc/tag cho MỌI vị trí TOÀN CÔNG TY
  // (VD: ghi biên bản họp & giao việc sau họp). Mở quyền theo yêu cầu Chủ Rise 2026-08-25.
  if (isHrLeadership(user.role, user.unit)) return null;
  if (user.dataScope === "company") {
    // Kế toán (không phải BLĐ/HCNS) → chỉ trong đơn vị của họ.
    const snapshot = await firestore.collection("users").limit(500).get();
    const emails = snapshot.docs.map((d) => ({ email: d.id, unit: (d.data() as any).unit })).filter((p) => p.unit === user.unit).map((p) => p.email);
    return new Set([user.email, ...emails]);
  }
  return await getVisibleUserEmails(user);
}

export async function getVisibleUserEmails(user: SessionUser) {
  if (user.role === "admin" || user.dataScope === "company") return null;

  // R2.1 — Chuyên gia hỗ trợ: thấy thêm người được giao hỗ trợ (view-only). Sau flag
  // RISE_WORK_ENFORCE_EXPERT_SCOPE (mặc định TẮT — đây là MỞ RỘNG quyền xem nên bật cẩn thận, có thí điểm).
  if (user.role === "expert" && process.env.RISE_WORK_ENFORCE_EXPERT_SCOPE === "1") {
    const support = await getExpertSupportEmails(user.email);
    return new Set([user.email, ...support]);
  }

  if (user.dataScope === "self") return new Set([user.email]);

  // R2.1 Pha B — enforce phạm vi Phó nhóm. Sau flag RISE_WORK_ENFORCE_DEPUTY_SCOPE để TẮT ĐƯỢC NGAY
  // (bỏ biến môi trường = quay lại hành vi cũ tức thì). Chỉ ảnh hưởng role="deputy" — không đụng vai trò khác.
  if (user.role === "deputy" && process.env.RISE_WORK_ENFORCE_DEPUTY_SCOPE === "1") {
    const managed = await getDeputyManagedEmails(user.email);
    return new Set([user.email, ...managed]);
  }
  const snapshot = await firestore.collection("users").limit(500).get();
  // KHÔNG lọc theo trạng thái tài khoản — Lead/Trưởng phòng phải xem được
  // báo cáo của MỌI nhân sự trong đúng đơn vị/đội mình phụ trách, bất kể
  // trạng thái làm việc/tài khoản hiện tại (đã xác nhận rõ với người
  // dùng: dữ liệu lịch sử không nên biến mất khỏi tầm nhìn của Lead chỉ
  // vì tài khoản đó không còn hoạt động).
  const people = snapshot.docs.map((doc) => ({ email: doc.id, ...(doc.data() as any) }));
  if (user.dataScope === "unit") {
    return new Set([user.email, ...people.filter((person) => person.unit === user.unit).map((person) => person.email)]);
  }
  const visible = new Set([user.email]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const person of people) {
      if (person.managerEmail && visible.has(person.managerEmail) && !visible.has(person.email)) {
        visible.add(person.email);
        changed = true;
      }
    }
  }
  // Dữ liệu cũ có thể chưa gắn managerEmail. Trưởng nhóm và Trưởng phòng
  // vẫn phải nhìn thấy nhân sự trong đúng đơn vị mình phụ trách, nhưng
  // tuyệt đối không mở rộng sang đơn vị khác.
  if (user.role === "lead" || user.role === "head") {
    for (const person of people) {
      if (person.unit === user.unit) visible.add(person.email);
    }
  }
  return visible;
}

/**
 * AI LÀ NGƯỜI NHẬN khi một nhân sự cần báo lên "quản lý của mình".
 *
 * Vì sao có (rà soát 02/09/2026): nhiều chỗ đang viết `if (managerEmail) { gửi thông báo }` —
 * hồ sơ nào BỎ TRỐNG ô "Quản lý trực tiếp" thì thông báo lặng lẽ KHÔNG GỬI ĐI ĐÂU CẢ. Nhân sự
 * bấm gửi, màn hình báo thành công, nhưng không một ai nhận được.
 * Đo thật ngày 02/09/2026: 39/53 người đang làm việc KHÔNG có "Quản lý trực tiếp" — tức phần lớn
 * công ty rơi vào lỗ này.
 *
 * Nay: có quản lý trực tiếp thì gửi đúng người đó; KHÔNG có thì lùi về Trưởng nhóm/Trưởng phòng
 * CÙNG ĐƠN VỊ (trừ chính người gửi). Vẫn không có ai thì trả về mảng rỗng để nơi gọi tự quyết —
 * nhưng nơi gọi PHẢI xử lý, không được im lặng.
 */
export async function nguoiQuanLyCua(
  firestore: FirebaseFirestore.Firestore,
  nhanSu: { email?: string; managerEmail?: string; unit?: string; role?: string },
): Promise<string[]> {
  const truc = String(nhanSu?.managerEmail ?? "").trim().toLowerCase();
  if (truc) return [truc];
  const donVi = String(nhanSu?.unit ?? "").trim();
  if (!donVi) return [];
  const minh = String(nhanSu?.email ?? "").trim().toLowerCase();
  const snap = await firestore.collection("users")
    .where("status", "==", "active").where("unit", "==", donVi).limit(100).get().catch(() => null);
  const trongDonVi = (snap?.docs ?? [])
    .map((d) => ({ email: String(d.id).toLowerCase(), role: String((d.data() as any).role ?? "") }))
    .filter((p) => ["lead", "head"].includes(p.role) && p.email !== minh)
    .map((p) => p.email);
  if (trongDonVi.length) return trongDonVi;

  // BẬC CUỐI: chính TRƯỞNG NHÓM/TRƯỞNG PHÒNG cũng cần có người nhận khi họ gửi tự đánh giá hay
  // báo cần hỗ trợ — mà trong đơn vị thì họ là cấp cao nhất. Chuyên viên độc lập cũng trực thuộc
  // Ban lãnh đạo. Nên bậc cuối là Ban lãnh đạo.
  // TRỪ tài khoản Đối tác Rise: người ngoài, không nằm trong đường báo cáo nội bộ.
  if (String((nhanSu as any)?.role ?? "") === "partner") return [];
  const bld = await firestore.collection("users")
    .where("status", "==", "active").where("role", "==", "admin").limit(20).get().catch(() => null);
  return (bld?.docs ?? []).map((d) => String(d.id).toLowerCase()).filter((e) => e !== minh);
}

/**
 * AI CẦN ĐƯỢC BÁO KHI CÓ ĐƠN XIN NGHỈ MỚI (03/09/2026).
 *
 * Vì sao có: trước đây gửi đơn xong KHÔNG ai được báo. Đơn chỉ hiện thành con số trên menu
 * "Việc của tôi" — người duyệt không mở app thì không biết có ai đang chờ. Đo thật: trong 2.000
 * thông báo gần nhất chỉ có "kết quả duyệt" và "nhắc nghỉ ngày mai", KHÔNG có loại "đơn mới".
 *
 * Nhắm ĐÚNG người phải xử lý, không rải cho cả Ban lãnh đạo:
 *   · Đơn còn chờ Trưởng nhóm vòng 1 → báo đúng Trưởng nhóm đó.
 *   · Còn lại (gồm người KHÔNG có quản lý trực tiếp — như 2 Trưởng phòng HCNS) → báo HCNS.
 *   · Không có HCNS nào đang hoạt động → lùi về Ban lãnh đạo, để đơn KHÔNG rơi vào hư không.
 *
 * Luôn bỏ chính người gửi ra khỏi danh sách nhận.
 */
export async function nguoiDuyetDonNghi(
  firestore: FirebaseFirestore.Firestore,
  opts: { nguoiGui: string; quanLyVong1?: string | null },
): Promise<string[]> {
  const minh = String(opts.nguoiGui ?? "").trim().toLowerCase();
  const vong1 = String(opts.quanLyVong1 ?? "").trim().toLowerCase();
  if (vong1 && vong1 !== minh) return [vong1];

  const snap = await firestore.collection("users")
    .where("status", "==", "active").limit(500).get().catch(() => null);
  const hcns = (snap?.docs ?? [])
    .map((d) => ({ email: String(d.id).toLowerCase(), ...(d.data() as any) }))
    .filter((p) => isHrLeadership(String(p.role ?? ""), String(p.unit ?? "")))
    .map((p) => p.email)
    .filter((e) => e !== minh);
  if (hcns.length) return hcns;

  const bld = await firestore.collection("users")
    .where("status", "==", "active").where("role", "==", "admin").limit(20).get().catch(() => null);
  return (bld?.docs ?? []).map((d) => String(d.id).toLowerCase()).filter((e) => e !== minh);
}
