import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { firestore } from "@/lib/firestore";
import { defaultAccess } from "@/lib/access";

export type SessionUser = {
  email: string;
  fullName: string;
  role: string;
  unit: string;
  jobTitle: string;
  managerEmail: string;
  avatarDataUrl?: string;
  permissions: string[];
  dataScope: "self" | "team" | "unit" | "company";
  profileComplete?: boolean;
  profileCompletion?: number;
  // "Xem thử vai trò" (view-as) — CHỈ đổi role/unit/quyền HIỂN THỊ cho
  // phiên trình duyệt hiện tại, KHÔNG đụng gì đến hồ sơ thật trên
  // Firestore. realRole luôn giữ đúng vai trò thật để: (1) biết ai được
  // phép bật/tắt view-as, (2) Admin không bao giờ tự khóa mình dù xem thử
  // ở vai trò thấp nhất — chỉ cần xóa cookie xem thử là quay lại ngay.
  viewingAs?: boolean;
  realRole?: string;
  viewAsLabel?: string;
  positionId?: string;
  // Khu vực nhạy cảm (Tài chính / Lương–thưởng) do Admin cấp riêng từng người.
  // undefined = chưa cấu hình → giữ quyền theo vai trò như cũ (fallback).
  sensitiveAreas?: string[];
};

const COOKIE_NAME = "rise_work_session";
const VIEW_AS_COOKIE_NAME = "rise_work_view_as";
const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

function sessionId(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function userFromEmail(email: string): Promise<SessionUser | null> {
  const snapshot = await firestore.collection("users").doc(email).get();
  if (!snapshot.exists || snapshot.data()?.status !== "active") return null;
  const data = snapshot.data()!;
  const role = data.role ?? "employee";
  const unit = data.unit ?? "";
  const access = defaultAccess(role, unit);
  const profileFields = [data.fullName, data.phone, data.birthDate, data.joinDate, data.currentAddress];
  const profileCompletion = Math.round(profileFields.filter((value) => String(value ?? "").trim()).length / profileFields.length * 100);
  // extraPermissions: quyền được Admin cấp riêng cho từng người, ngoài quyền
  // mặc định theo vai trò — dùng cho các module chỉ mở cho người được chỉ
  // định (vd Kho kênh CMS), không đổi quyền mặc định của vai trò họ đang có.
  const extraPermissions = Array.isArray(data.extraPermissions) ? data.extraPermissions : [];
  const permissions = Array.from(new Set([...access.permissions, ...extraPermissions]));
  return {
    email,
    fullName: data.fullName ?? email,
    role,
    unit,
    jobTitle: data.jobTitle ?? role,
    managerEmail: data.managerEmail ?? "",
    avatarDataUrl: data.avatarDataUrl ?? "",
    permissions,
    dataScope: access.dataScope,
    profileComplete: profileCompletion === 100,
    profileCompletion,
    realRole: role,
    positionId: data.positionId ?? "",
    // Giữ nguyên undefined nếu chưa cấu hình (để gate dùng fallback theo vai trò).
    sensitiveAreas: Array.isArray(data.sensitiveAreas) ? data.sensitiveAreas : undefined,
  };
}

export async function createSession(user: SessionUser) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  await firestore.collection("sessions").doc(sessionId(token)).set({
    email: user.email,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_MS).toISOString(),
  });
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: Math.floor(SESSION_MS / 1000),
    path: "/",
  });
}

export async function clearSession() {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (token) {
    await firestore.collection("sessions").doc(sessionId(token)).delete().catch(() => undefined);
  }
  store.delete(COOKIE_NAME);
  store.delete(VIEW_AS_COOKIE_NAME);
}

// Bật "Xem thử vai trò" — chỉ Admin được gọi (kiểm tra ở API route).
// Lưu vào cookie riêng, KHÔNG đụng gì tới field role thật trên Firestore.
export async function setViewAs(input: { positionId: string; label: string; role: string; unit: string }) {
  const store = await cookies();
  store.set(VIEW_AS_COOKIE_NAME, JSON.stringify(input), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 4, // 4 giờ — tự hết hạn, không cần nhớ tắt
    path: "/",
  });
}

export async function clearViewAs() {
  const store = await cookies();
  store.delete(VIEW_AS_COOKIE_NAME);
}

export async function getSession(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;
  const reference = firestore.collection("sessions").doc(sessionId(token));
  const snapshot = await reference.get();
  if (!snapshot.exists) return null;
  const session = snapshot.data()!;
  if (!session.email || Date.parse(session.expiresAt ?? "") <= Date.now()) {
    await reference.delete().catch(() => undefined);
    return null;
  }
  const user = await userFromEmail(String(session.email));
  if (!user) {
    await reference.delete().catch(() => undefined);
    return null;
  }
  // Chỉ Admin THẬT mới được áp dụng "xem thử" — nếu cookie xem thử còn sót
  // lại trên máy của người không phải Admin (vd Admin đổi tài khoản khác
  // trên cùng trình duyệt), bỏ qua hoàn toàn, không áp dụng.
  if (user.realRole === "admin") {
    const viewAsRaw = (await cookies()).get(VIEW_AS_COOKIE_NAME)?.value;
    if (viewAsRaw) {
      try {
        const viewAs = JSON.parse(viewAsRaw);
        const access = defaultAccess(viewAs.role, viewAs.unit);
        return {
          ...user,
          role: viewAs.role,
          unit: viewAs.unit,
          jobTitle: viewAs.label,
          permissions: access.permissions,
          dataScope: access.dataScope,
          // BẢO MẬT: bỏ danh sách khu nhạy cảm (finance/payroll/cms) của Admin THẬT
          // khi xem thử — nếu giữ, canSensitive vẫn cho Admin thấy hết khu lương/CMS
          // dù đang "đóng vai" nhân viên thường → sai mục đích xem thử. Để undefined
          // để canSensitive tính lại đúng theo VAI TRÒ giả định.
          sensitiveAreas: undefined,
          viewingAs: true,
          viewAsLabel: viewAs.label,
          positionId: viewAs.positionId,
        };
      } catch {
        // cookie hỏng — bỏ qua, dùng session thật
      }
    }
  }
  return user;
}

export async function requireSession(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
}

// Nhận diện lỗi "chưa đăng nhập" (phiên hết hạn) để route trả 401 thay vì 500. Trước đây các
// endpoint bị POLLING (tab để mở khi phiên hết hạn) ném UNAUTHORIZED → catch chung trả 500 →
// rác log 500 hàng loạt (trông như sự cố). Dùng helper này trong catch để trả đúng 401.
export function isUnauthorized(e: any): boolean {
  return /unauthor/i.test(String(e?.message ?? e ?? ""));
}
