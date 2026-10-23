// KIỂM TRA KHOÁ LUỒNG (stream key) TRƯỚC KHI LƯU.
//
// Vì sao cần: 28/08/2026 một luồng "chớp tắt" liên tục, hệ thống báo "nghi lỗi
// mạng/VPS" và tự thử lại mỗi 5 phút. Thực tế nhân viên dán NHẦM LINK VIDEO vào
// ô khoá luồng. YouTube từ chối ngay → ffmpeg chết → khởi động lại → chết…
//
// Hậu quả nặng hơn vẻ ngoài: luồng hỏng vì sai khoá thì chuyển sang máy nào
// cũng hỏng. Người vận hành tưởng lỗi máy nên chuyển máy tay; máy đích không
// lên sóng kịp hạn nên hệ thống HOÀN NGUYÊN về máy cũ (đúng thiết kế) — nhìn
// như "chuyển máy xong nó lại tự kéo về VPS cũ".
//
// Chặn ngay từ ô nhập là rẻ nhất: người nhập biết sai NGAY, thay vì cả hệ thống
// đoán mò rồi báo nhầm nguyên nhân.

export type KetQuaKhoa = { ok: true } | { ok: false; loi: string };

/** Khoá luồng YouTube: chữ/số và dấu gạch, thường 16–40 ký tự, KHÔNG phải đường dẫn. */
export function kiemKhoaLuong(khoaRaw: unknown): KetQuaKhoa {
  const khoa = String(khoaRaw ?? "").trim();
  if (!khoa) return { ok: false, loi: "Chưa nhập khoá luồng." };

  const thap = khoa.toLowerCase();
  if (thap.startsWith("http://") || thap.startsWith("https://") || thap.includes("://"))
    return { ok: false, loi: "Đây là ĐƯỜNG DẪN, không phải khoá luồng. Khoá luồng lấy trong YouTube Studio › Phát trực tiếp › Khoá luồng (dạng xxxx-xxxx-xxxx-xxxx-xxxx)." };

  for (const mien of ["youtube.com", "youtu.be", "drive.google", "rtmp://", "facebook.com"])
    if (thap.includes(mien))
      return { ok: false, loi: "Ô này chỉ nhận KHOÁ luồng, không nhận đường dẫn tới video hay kênh. Lấy khoá trong YouTube Studio › Phát trực tiếp › Khoá luồng." };

  if (/\s/.test(khoa))
    return { ok: false, loi: "Khoá luồng không được chứa dấu cách — bạn kiểm tra lại xem có dán thừa gì không." };

  if (khoa.includes("/"))
    return { ok: false, loi: "Khoá luồng không chứa dấu gạch chéo. Bạn dán nhầm đường dẫn rồi." };

  if (khoa.length < 10)
    return { ok: false, loi: "Khoá luồng quá ngắn — khoá thật thường dài 16–30 ký tự." };

  if (khoa.length > 120)
    return { ok: false, loi: "Khoá luồng quá dài — bạn kiểm tra lại xem có dán nhầm cả đoạn văn bản không." };

  // Chỉ chấp nhận ký tự khoá thường gặp; ký tự lạ gần như chắc chắn là dán nhầm.
  if (!/^[A-Za-z0-9_-]+$/.test(khoa))
    return { ok: false, loi: "Khoá luồng chỉ gồm chữ, số và dấu gạch. Bạn kiểm tra lại đoạn vừa dán." };

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHE KHOÁ LUỒNG TRONG CÂU LỖI (phát hiện 2026-08-29 khi soi sự cố VPS 03)
//
// Vấn đề: worker lấy dòng lỗi cuối của ffmpeg làm "lý do dừng". Dòng đó thường
// chứa NGUYÊN đường dẫn đẩy, tức là KÈM LUÔN KHOÁ LUỒNG:
//     rtmp://a.rtmp.youtube.com/live2/fq39-9azw-72bg-c0m5-arf5: Input/output error
// Máy chủ có che khoá ở ô "khoá luồng" (maskKey) nhưng KHÔNG che ở câu lý do —
// nên khoá vẫn hiện nguyên trên màn Live cho mọi người trong phạm vi xem được,
// và với luồng ưu tiên thì câu đó còn được GỬI EMAIL ra ngoài.
//
// Khoá luồng = mật khẩu phát sóng: ai cầm được là đẩy được lên kênh đó.
// Vì vậy che ở CẢ HAI đầu — lúc ghi (khỏi lọt vào dữ liệu) và lúc đọc (che nốt
// dữ liệu cũ đã lỡ lưu).
// ─────────────────────────────────────────────────────────────────────────────

/** Che mọi khoá luồng lẫn trong câu chữ. Giữ lại phần mô tả lỗi để còn đọc hiểu được. */
export function cheKhoaTrongCau(text: unknown): string {
  const s = String(text ?? "");
  if (!s) return s;
  return s
    // rtmp://…/live2/<khoá> → giữ đường dẫn, che khoá
    .replace(/(rtmps?:\/\/[^\s/]+\/[^\s/]+\/)([A-Za-z0-9_-]{8,})/gi, "$1••••")
    // khoá đứng lẻ dạng xxxx-xxxx-xxxx-xxxx-xxxx (YouTube) nằm trơ trong câu
    .replace(/\b[a-z0-9]{4}(-[a-z0-9]{4}){3,}\b/gi, "••••");
}
