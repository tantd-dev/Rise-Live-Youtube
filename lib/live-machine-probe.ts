// RISE LIVE — XÁC MINH MÁY CÓ THẬT SỰ CHẾT KHÔNG (30/08/2026).
//
// VÌ SAO CẦN. Trước đây hệ kết luận "máy mất kết nối" chỉ từ MỘT dấu hiệu: máy không gửi tin về
// trong 60 giây. Nhưng worker im 60 giây KHÔNG có nghĩa máy chết — đo thật ca VPS 05 ngày 30/08:
//   18:14:04  máy gọi về, máy chủ trả lời 0,6 giây, mã 200
//   ( im 72 giây — một lượt gửi của worker không tới nơi, worker chờ hết 30 giây rồi ngủ 20 giây )
//   18:15:04  cron quét → nhịp tim 60 giây tuổi → BÁO ĐỘNG "28 luồng đang tắt"
//   18:15:16  máy gọi lại bình thường
// Máy sống nguyên, cả 28 luồng phát liên tục không gián đoạn một giây nào.
//
// Hai cái giá của việc kết luận vội:
//   1. Người nhận hoảng → vào chuyển luồng tay → CẮT SÓNG THẬT để chữa sự cố KHÔNG CÓ THẬT.
//   2. Cơ chế tự cứu cũng dùng đúng ngưỡng 60 giây → tự dời luồng ưu tiên vì một hơi mạng.
//      (Lần đó thoát chỉ vì VPS 05 tình cờ không có luồng ưu tiên nào.)
//
// CÁCH XÁC MINH: gọi thẳng vào cổng phục vụ của worker (8099 — vốn đã mở sẵn cho việc chép video
// giữa các VPS). Chỉ cần BẮT TAY TCP thành công là đủ chứng minh máy còn sống và worker còn nghe.
// Đo thử từ ngoài: VPS 05 và VPS 03 đều bắt tay trong ~0,2 giây.
//
// ⚠ KHÔNG đụng `machineOnline()`. Hàm đó được dùng ở 9 chỗ khác (đèn Online, chặn tạo luồng, chặn
//   chuyển máy, chọn máy nguồn chép video…). Đổi nghĩa của nó sẽ kéo theo hàng loạt hậu quả — ví dụ
//   máy hiện "Online" trong khi số liệu luồng đã đóng băng, hoặc cho tạo luồng trên máy không nhận
//   được lệnh. Đây là một câu hỏi RIÊNG và HẸP: "đã xác minh là chết chưa?", chỉ dùng ở đúng hai chỗ
//   quyết định BÁO ĐỘNG và CỨU LUỒNG.
import net from "node:net";

export const PROBE_PORT = () => Number(process.env.RISE_LIVE_UPLOAD_PORT) || 8099;
export const PROBE_TIMEOUT_MS = () => Math.max(1000, Number(process.env.RL_PROBE_TIMEOUT_MS) || 3000);

/** Bắt tay TCP tới máy. true = máy còn sống và đang nghe. Mọi lỗi/quá hạn đều trả false. */
export function goDuocMay(ip: string, port = PROBE_PORT(), timeoutMs = PROBE_TIMEOUT_MS()): Promise<boolean> {
  return new Promise((resolve) => {
    if (!ip) return resolve(false);
    const s = new net.Socket();
    let xong = false;
    const chot = (ok: boolean) => { if (xong) return; xong = true; try { s.destroy(); } catch { /* */ } resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once("connect", () => chot(true));
    s.once("timeout", () => chot(false));
    s.once("error", () => chot(false));
    try { s.connect(port, ip); } catch { chot(false); }
  });
}

export interface KetQuaXacMinh {
  /** Máy ĐÃ XÁC MINH là chết (gọi vào không ai trả lời). */
  chet: Set<string>;
  /** Máy im nhưng gọi vào VẪN trả lời — sống, chỉ là không gọi ra được. */
  songNhungKhongGoiVe: Set<string>;
  /** Có tin được kết quả này không. false = không kiểm chứng được, phải quay về cách cũ. */
  tinDuoc: boolean;
  lyDo: string;
}

/**
 * Xác minh các máy đang bị NGHI là chết.
 *
 * @param nghiNgo  máy im quá ngưỡng (đang bị nghi)
 * @param doiChung máy VẪN đang báo về bình thường — dùng làm MỐC ĐỐI CHỨNG
 *
 * MỐC ĐỐI CHỨNG là lớp chặn quan trọng nhất: nếu chính máy đang khoẻ cũng không gọi vào được thì
 * vấn đề nằm ở ĐƯỜNG RA của hệ thống (Cloud Run không ra được internet, tường lửa đổi…), chứ không
 * phải máy kia chết. Không có lớp này thì một sự cố mạng phía mình sẽ bị đọc thành "cả đàn máy chết"
 * → tự cứu hàng loạt vô cớ, tệ hơn hiện tại rất nhiều.
 */
export async function xacMinhMayChet(
  nghiNgo: { id: string; ip?: string }[],
  doiChung: { id: string; ip?: string }[],
): Promise<KetQuaXacMinh> {
  const rong: KetQuaXacMinh = { chet: new Set(), songNhungKhongGoiVe: new Set(), tinDuoc: true, lyDo: "không có máy nào bị nghi" };
  if (!nghiNgo.length) return rong;

  // Máy nghi ngờ mà KHÔNG có IP thì không xác minh được → giữ nguyên cách cũ cho riêng nó.
  const coIp = nghiNgo.filter((m) => String(m.ip ?? "").trim());
  if (!coIp.length) return { ...rong, tinDuoc: false, lyDo: "máy bị nghi chưa khai địa chỉ IP — không xác minh được" };

  // Đối chứng: thử tối đa 2 máy đang khoẻ.
  const mocDoiChung = doiChung.filter((m) => String(m.ip ?? "").trim()).slice(0, 2);
  const [kqNghi, kqDoiChung] = await Promise.all([
    Promise.all(coIp.map(async (m) => ({ id: m.id, song: await goDuocMay(String(m.ip)) }))),
    Promise.all(mocDoiChung.map(async (m) => goDuocMay(String(m.ip)))),
  ]);

  // Có máy đối chứng mà KHÔNG máy nào trả lời → đường ra của hệ thống có vấn đề, KHÔNG tin phép thử.
  if (mocDoiChung.length > 0 && !kqDoiChung.some(Boolean)) {
    return { chet: new Set(), songNhungKhongGoiVe: new Set(), tinDuoc: false, lyDo: "máy đối chứng cũng không gọi vào được — nghi đường ra của hệ thống hỏng, không kết luận" };
  }
  // Không có máy đối chứng nào (mọi máy đều đang bị nghi) mà cũng không máy nào trả lời → cùng lý do.
  if (mocDoiChung.length === 0 && !kqNghi.some((k) => k.song) && coIp.length >= 2) {
    return { chet: new Set(), songNhungKhongGoiVe: new Set(), tinDuoc: false, lyDo: "mọi máy đều không gọi vào được — nghi lỗi phía hệ thống, không kết luận" };
  }

  return {
    chet: new Set(kqNghi.filter((k) => !k.song).map((k) => k.id)),
    songNhungKhongGoiVe: new Set(kqNghi.filter((k) => k.song).map((k) => k.id)),
    tinDuoc: true,
    lyDo: `đã gọi vào ${kqNghi.length} máy bị nghi`,
  };
}
