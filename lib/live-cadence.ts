// RISE LIVE — NHỊP CHẠY CỦA HỆ, GOM VỀ MỘT CHỖ (30/08/2026).
//
// VÌ SAO CÓ FILE NÀY. Chủ Rise Group hỏi: "chỗ chi phí đang ghi các nhịp đọc có đúng thực tế vận
// hành không?" — Đo thì SAI:
//   · khối chi phí ghi "đẩy ảnh mỗi 45 giây"   → thực tế 300 giây (giãn từ bản worker r2.31)
//   · khối chi phí ghi "màn hình mỗi 12 giây"  → thực tế 20 giây, và 120 giây khi kênh đẩy chạy
// Gốc lỗi: mấy con số đó bị CHÉP CỨNG vào chỗ hiển thị. Hệ đổi nhịp mà chỗ hiển thị không đổi
// theo, nên nó lệch dần và không ai biết — con số thổi phồng chi phí suốt nhiều tuần.
//
// TỪ NAY: mọi nơi cần biết nhịp đều đọc từ đây. Ai chỉnh nhịp thì con số hiển thị tự đúng theo.
// Đây đúng bài học đã ghi trong ngày: gom số dùng nhiều nơi về MỘT nguồn, đừng chép.

/** Máy phát hỏi máy chủ mỗi bấy nhiêu giây khi mọi thứ ổn định. */
export const POLL_SLOW_SEC = 20;
/** Máy nào VỪA có thay đổi trong ~60 giây gần đây thì hỏi lại nhanh hơn (bấm Bật/Dừng thấy ngay). */
export const POLL_FAST_SEC = 3;
/** Cửa sổ coi là "vừa có thay đổi" (mili-giây). */
export const POLL_FAST_WINDOW_MS = 60_000;

/** Màn Live Rise tự làm mới mỗi bấy nhiêu mili-giây — khi KHÔNG có kênh đẩy, hoặc đang có việc chạy. */
export const DASH_REFRESH_MS = 20_000;
/** Khi kênh đẩy đang chạy và không có việc gì đang chạy → giãn ra, vì kênh đẩy đã báo mọi thay đổi. */
export const DASH_IDLE_MS = 120_000;

/** Hai cơ chế tiết kiệm — khối chi phí phải biết để không thổi phồng con số. */
export const writeOnChangeOn = (): boolean => process.env.RISE_LIVE_WRITE_ON_CHANGE === "1";
export const readConsolidateOn = (): boolean => process.env.RISE_LIVE_READ_CONSOLIDATE === "1";
/** Ghi-khi-đổi: luồng ổn định thì chỉ "điểm danh" lại sau bấy nhiêu giây, không ghi mỗi nhịp. */
export const WRITE_ON_CHANGE_REFRESH_SEC = 120;
