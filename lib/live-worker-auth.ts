// RISE LIVE — Dự phòng nhiều VPS · ĐỢT 2. Vé xác thực RIÊNG từng máy (thay vì 1 vé CHUNG cho mọi
// worker). Vé riêng = chữ ký HMAC(mã bí mật chung, machineId) → KHÔNG lưu bí mật trong Firestore,
// máy này KHÔNG giả danh machineId khác được (không có mã bí mật thì không tính ra vé máy khác).
//
// AN TOÀN & TƯƠNG THÍCH NGƯỢC: server VẪN chấp nhận vé CHUNG cũ (RISE_LIVE_WORKER_TOKEN) song song
// → worker đang chạy KHÔNG gãy. Khi cài lại từng VPS với vé riêng thì máy đó bảo mật hơn.
import crypto from "node:crypto";

// Vé riêng cho 1 máy (hex 40 ký tự). Trả null nếu chưa cấu hình mã bí mật.
export function machineWorkerToken(machineId: string): string | null {
  const secret = process.env.RISE_LIVE_WORKER_TOKEN;
  if (!secret || !machineId) return null;
  return crypto.createHmac("sha256", secret).update("machine:" + machineId).digest("hex").slice(0, 40);
}

// Chấp nhận nếu: (a) đúng vé CHUNG (cũ) HOẶC (b) đúng vé RIÊNG của đúng machineId đó.
export function verifyWorkerToken(machineId: string, given: string): boolean {
  const shared = process.env.RISE_LIVE_WORKER_TOKEN;
  if (!given || !shared) return false;
  if (safeEq(given, shared)) return true;                 // vé chung — tương thích ngược
  const mt = machineWorkerToken(machineId);
  return !!mt && safeEq(given, mt);                        // vé riêng từng máy
}

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
