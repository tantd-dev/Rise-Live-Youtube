// KIỂM LINK GOOGLE DRIVE TRƯỚC KHI NHẬN (Rise Live — thêm video từ Drive).
//
// VÌ SAO (Chủ Rise Group 29/08/2026): dán nhầm link THƯ MỤC vào ô "Link Google Drive" thì app
// vẫn NHẬN, tạo bản ghi, đẩy sang VPS, rồi tới tận lúc worker tải mới báo hỏng bằng một câu kỹ
// thuật: "Khong doc duoc file id Google Drive". Người dán không hiểu mình sai ở đâu, và mất vài
// phút mới biết.
//
// Chặn ngay từ Ô NHẬP là rẻ nhất — cùng bài học với ô "khoá luồng" (dán nhầm link video vào đó
// thì luồng chuyển sang máy nào cũng hỏng).
//
// CHỈ nhận link tới MỘT FILE:
//   https://drive.google.com/file/d/<ID>/view...
//   https://drive.google.com/open?id=<ID>   ·   .../uc?id=<ID>
// TỪ CHỐI: link thư mục (/drive/folders/...), link Docs/Sheets/Slides (không phải video), link rỗng.

export type KetQuaLink = { ok: true; fileId: string } | { ok: false; loi: string };

export function kiemLinkDrive(raw: unknown): KetQuaLink {
  const url = String(raw ?? "").trim();
  if (!url) return { ok: false, loi: "Chưa dán link Google Drive." };

  if (!/drive\.google\.com|docs\.google\.com/i.test(url)) {
    return { ok: false, loi: "Đây không phải link Google Drive. Mở video trên Drive → Chia sẻ → Sao chép đường liên kết." };
  }
  if (/\/drive\/(u\/\d+\/)?folders\//i.test(url)) {
    return { ok: false, loi: "Đây là link THƯ MỤC, không phải link video. Mở đúng file video trong thư mục → chuột phải → Chia sẻ → Sao chép đường liên kết." };
  }
  if (/docs\.google\.com\/(document|spreadsheets|presentation)/i.test(url)) {
    return { ok: false, loi: "Đây là link tài liệu (Docs/Sheets/Slides), không phải video. Chọn đúng file video (.mp4)." };
  }

  const m1 = url.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
  const m2 = url.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  const fileId = m1?.[1] || m2?.[1] || "";
  if (!fileId) {
    return { ok: false, loi: "Link Drive không có mã file. Dùng link dạng https://drive.google.com/file/d/…/view (mở file → Chia sẻ → Sao chép đường liên kết)." };
  }
  return { ok: true, fileId };
}
