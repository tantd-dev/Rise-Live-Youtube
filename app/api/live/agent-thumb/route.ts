// NHẬN "ảnh thật đang phát" (screenshot) từ AGENT trên VPS → lưu server để CLIENT lấy được
// với MỌI VPS (thay cách cũ phục vụ qua 1 domain HTTPS chỉ trỏ 1 máy). Auth = worker token.
//
// D-RL-06 (khóa 2026-08-29) — CHUYỂN ẢNH SANG KHO FILE, KHÔNG NHÉT VÀO CƠ SỞ DỮ LIỆU NỮA.
// Vì sao: cách cũ nhét ảnh (chuỗi base64 vài chục KB, trần 950KB) thẳng vào MỘT bản ghi/luồng, ghi
// đè mỗi ~45 giây. Ở 162 luồng là ~3,6 lượt ghi/giây toàn bản ghi NẶNG; lên 300–500 luồng thì đây là
// khoản đắt nhất và chậm nhất của cả hệ. Ảnh vốn là FILE — chỗ của nó là kho file, không phải cơ sở
// dữ liệu. Nay chỉ còn lưu một bản ghi TÍ HON làm con trỏ (ai, máy nào, lúc nào).
//
// KHÔNG PHẢI ĐỘNG VÀO 5 VPS: worker vẫn gửi y như cũ, chỉ máy chủ đổi chỗ cất. (Worker không tự
// cập nhật được nên mọi thay đổi cần chạm VPS đều đắt — tránh được thì tránh.)
//
// Sau cờ RISE_LIVE_THUMB_GCS (mặc định TẮT → giữ nguyên cách cũ). Ghi kho file lỗi → TỰ QUAY VỀ
// cách cũ để không mất ảnh (không im lặng bỏ qua).
import { NextResponse } from "next/server";
import { firestore, getAttachmentBucket } from "@/lib/firestore";
import { verifyWorkerToken } from "@/lib/live-worker-auth";
import { THUMB_GCS_ON, thumbObjectKey } from "@/lib/live-thumb-store";

export async function POST(req: Request) {
  try {
    if (!process.env.RISE_LIVE_WORKER_TOKEN) return NextResponse.json({ error: "worker chưa cấu hình" }, { status: 503 });
    const body = await req.json().catch(() => ({}));
    const streamId = String(body.streamId ?? "");
    // Vé chung (cũ) hoặc vé riêng của đúng máy — tương thích ngược.
    if (!verifyWorkerToken(String(body.machineId ?? ""), req.headers.get("x-rise-live-token") ?? "")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const b64 = String(body.jpgB64 ?? "");
    if (!streamId || !b64) return NextResponse.json({ error: "thiếu streamId/ảnh" }, { status: 400 });
    if (b64.length > 950000) return NextResponse.json({ error: "ảnh quá lớn" }, { status: 413 });   // < giới hạn doc Firestore 1MB

    const machineId = String(body.machineId ?? "");
    const now = new Date().toISOString();
    const ref = firestore.collection("liveThumbs").doc(streamId);

    if (THUMB_GCS_ON()) {
      const bucket = getAttachmentBucket();
      if (bucket) {
        try {
          await bucket.file(thumbObjectKey(streamId)).save(Buffer.from(b64, "base64"), {
            contentType: "image/jpeg",
            resumable: false,
            metadata: { cacheControl: "private, max-age=40" },
          });
          // Bản ghi chỉ còn CON TRỎ — nhẹ vài trăm byte thay vì vài chục KB.
          // set() (không merge) để XOÁ HẲN chuỗi ảnh cũ còn sót trong bản ghi.
          await ref.set({ streamId, machineId, store: "gcs", updatedAt: now });
          return NextResponse.json({ ok: true, store: "gcs" });
        } catch {
          // Kho file lỗi → rơi xuống cách cũ bên dưới. KHÔNG bỏ ảnh im lặng.
        }
      }
    }

    await ref.set({ streamId, machineId, b64, store: "doc", updatedAt: now });
    return NextResponse.json({ ok: true, store: "doc" });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "lỗi" }, { status: 500 });
  }
}
