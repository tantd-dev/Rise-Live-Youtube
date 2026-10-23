import { NextResponse } from "next/server";
import { firestore } from "@/lib/firestore";
import { createSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// ĐĂNG NHẬP THỬ — chỉ để chạy thử bản khôi phục. Tự chặn nếu không phải Firestore giả lập,
// để không thể vô tình dùng trên dữ liệu thật.
export async function GET(req: Request) {
  if (process.env.ALLOW_DEV_LOGIN !== "1" || !process.env.FIRESTORE_EMULATOR_HOST) {
    return NextResponse.json({ error: "Đăng nhập thử đang tắt (cần ALLOW_DEV_LOGIN=1 và FIRESTORE_EMULATOR_HOST)." }, { status: 404 });
  }
  const email = process.env.DEV_LOGIN_EMAIL || "dev@local.test";
  await firestore.collection("users").doc(email).set(
    {
      email, fullName: "Dev Admin", role: "admin", unit: "Vận hành", jobTitle: "Quản trị thử nghiệm",
      managerEmail: "", status: "active", phone: "", birthDate: "", joinDate: "", currentAddress: "",
    },
    { merge: true },
  );
  await createSession({ email } as any);
  return NextResponse.redirect(new URL("/", req.url));
}
