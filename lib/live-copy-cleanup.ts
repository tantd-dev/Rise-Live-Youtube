// NHAN DIEN "XAC" CUA CAC LAN COPY VIDEO THAT BAI (Rise Live) — dung chung cho script don tay
// va cho co che tu don theo lich.
//
// Boi canh (su co VPS 03, 29/08/2026): may nguon mat mang chieu VAO -> nguoi dung bam
// "Chuyen (tu copy)" -> may dich tao ban ghi video roi bao loi ket noi. Ban ghi do nam lai
// MAI va vi trang thai "error" nen ban len canh bao NGHIEM TRONG, che mat canh bao that.
//
// CHI nhan dien dung loai nay: la BAN SAO dang cho copy (co copyFromUrl) + trang thai error
// + ly do la loi KET NOI. Video hong THAT (loi tai/nen tu Drive) KHONG bi dinh.

/** Cau loi cho thay khong voi toi duoc may nguon (khac han "file hong"). */
export function laLoiKetNoi(text: unknown): boolean {
  const s = String(text ?? "").toLowerCase();
  return /no route to host|timed out|timeout|connection refused|network is unreachable|errno 113|errno 111|errno 110/.test(s);
}

/** Ban ghi nay co phai xac cua mot lan copy that bai vi khong toi duoc may nguon khong. */
export function laXacCopyHong(a: any): boolean {
  return String(a?.status) === "error" && !!a?.copyFromUrl && laLoiKetNoi(a?.error);
}

/**
 * Đổi câu lỗi copy thành lời khuyên NGƯỜI VẬN HÀNH LÀM ĐƯỢC.
 *
 * Câu gốc do worker sinh ra là: "…Kiem tra 2 VPS thong nhau (cong 8099) hoac dung 'Tai video len' tay."
 * Đúng về kỹ thuật nhưng người vận hành không làm gì được với nó — họ không vào được VPS, không
 * biết cổng 8099 là gì. Chủ Rise Group chốt 29/08/2026: khi máy nguồn không với tới được thì
 * gợi ý THẲNG cách duy nhất họ tự làm được — tải lại video lên máy khác.
 *
 * Viết ở MÁY CHỦ (không sửa worker) để có tác dụng NGAY, khỏi phải cập nhật lại cả 5 VPS.
 * Nhận diện theo DẤU HIỆU lỗi kết nối chứ không theo đúng chữ, nên worker có đổi câu vẫn khớp.
 */
export function loiCopyDeHieu(text: unknown): string {
  const s = String(text ?? "");
  if (!s) return s;
  if (!/copy/i.test(s) || !laLoiKetNoi(s)) return s;
  return "Không sao chép được video vì KHÔNG kết nối tới được máy nguồn (máy nguồn đang mất mạng). "
    + "Cách xử: dùng \"Thêm video\" dán lại link Google Drive vào máy đích, hoặc \"Tải video lên\" từ máy tính. "
    + "Chờ máy nguồn hồi rồi sao chép lại cũng được.";
}

/** Xác copy hỏng ĐÃ CŨ (quá `phut` phút) thì dọn tự động cho khỏi che mất cảnh báo thật. */
export function nenTuDon(a: any, nowMs: number, phut = 30): boolean {
  if (!laXacCopyHong(a)) return false;
  const t = Date.parse(String(a?.updatedAt ?? a?.createdAt ?? ""));
  if (!Number.isFinite(t)) return false;              // không rõ thời điểm → KHÔNG tự xoá
  return nowMs - t > phut * 60 * 1000;
}
