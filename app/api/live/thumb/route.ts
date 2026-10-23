// PHỤC VỤ "ảnh thật đang phát" (screenshot) của 1 luồng — client lấy TỪ SERVER (hoạt động với
// MỌI VPS). Kiểm quyền: đăng nhập + Admin/BLĐ hoặc luồng do người TRONG PHẠM VI mình tạo.
//
// D-RL-06 — ĐO ĐƯỢC 29/08/2026, ba khoản lãng phí ở đây:
//  1. Ảnh nằm trong cơ sở dữ liệu → mỗi lần xem là đọc một bản ghi NẶNG. Nay đọc từ kho file.
//  2. `Cache-Control: no-store` → trình duyệt KHÔNG BAO GIỜ dùng lại ảnh, mở màn Live có 125 luồng
//     là 125 lượt tải ảnh MỖI LẦN làm mới. Nay cho phép giữ 40 giây (ảnh chỉ mới ~45 giây/lần).
//  3. Mỗi lượt xem ảnh tốn 2 lượt đọc cơ sở dữ liệu (bản ghi luồng để kiểm quyền + bản ghi ảnh).
//     Nay nhớ tạm quyền theo luồng trong bộ nhớ 60 giây → gần như hết khoản đọc kiểm quyền.
// Kiểm quyền KHÔNG bị nới lỏng: vẫn phải đăng nhập, vẫn chặn người ngoài phạm vi — chỉ là không
// hỏi lại cơ sở dữ liệu mỗi tấm ảnh.
import { firestore, getAttachmentBucket } from "@/lib/firestore";
import { requireSession } from "@/lib/session";
import { getVisibleUserEmails } from "@/lib/access";
import { THUMB_GCS_ON, thumbObjectKey, thumbCacheSec } from "@/lib/live-thumb-store";

export const dynamic = "force-dynamic";

/** Nhớ tạm "luồng này của ai" theo tiến trình. Chủ luồng gần như không đổi nên 60 giây là an toàn. */
const OWNER_TTL_MS = 60_000;
const ownerCache = new Map<string, { by: string; at: number }>();

async function ownerOf(streamId: string): Promise<string | null> {
  const hit = ownerCache.get(streamId);
  if (hit && Date.now() - hit.at < OWNER_TTL_MS) return hit.by;
  const sDoc = await firestore.collection("liveStreams").doc(streamId).get();
  if (!sDoc.exists) return null;
  const by = String((sDoc.data() as any)?.createdBy ?? "").toLowerCase();
  ownerCache.set(streamId, { by, at: Date.now() });
  if (ownerCache.size > 3000) ownerCache.clear();   // chặn phình bộ nhớ ở quy mô lớn
  return by;
}

export async function GET(req: Request) {
  try {
    const user = await requireSession();
    const streamId = new URL(req.url).searchParams.get("streamId") ?? "";
    if (!streamId) return new Response("thiếu streamId", { status: 400 });

    const by = await ownerOf(streamId);
    if (by === null) return new Response("không thấy luồng", { status: 404 });
    // Quyền xem: giống danh sách luồng — Admin/company thấy tất, còn lại chỉ luồng trong phạm vi.
    if (!(user.role === "admin" || user.dataScope === "company")) {
      const vis = await getVisibleUserEmails(user);
      if (vis && !vis.has(by)) return new Response("cấm", { status: 403 });
    }

    // Ảnh chỉ mới ~45 giây/lần → cho trình duyệt giữ 40 giây. "private" = chỉ máy người xem giữ,
    // KHÔNG để lớp đệm dùng chung nào cầm ảnh (ảnh có phân quyền).
    // Giu lai bang NUA nhip day anh that (khong go cung 40 giay — anh thuc te chi doi moi 5 phut).
    const headers = { "Content-Type": "image/jpeg", "Cache-Control": `private, max-age=${thumbCacheSec()}` };

    const t = await firestore.collection("liveThumbs").doc(streamId).get();
    const d: any = t.data() ?? {};

    if (THUMB_GCS_ON() && d.store === "gcs") {
      const bucket = getAttachmentBucket();
      if (!bucket) return new Response("chưa bật kho lưu trữ", { status: 503 });
      const [buf] = await bucket.file(thumbObjectKey(streamId)).download().catch(() => [null] as any);
      if (!buf) return new Response("chưa có ảnh", { status: 404 });
      return new Response(new Uint8Array(buf), { headers });
    }

    // Ảnh cũ còn nằm trong bản ghi (trước khi bật kho file, hoặc lần ghi kho file bị lỗi).
    const b64 = String(d.b64 ?? "");
    if (!b64) return new Response("chưa có ảnh", { status: 404 });
    return new Response(new Uint8Array(Buffer.from(b64, "base64")), { headers });
  } catch {
    return new Response("lỗi", { status: 500 });
  }
}
