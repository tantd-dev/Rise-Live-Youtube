// RISE LIVE — CHỖ CẤT "ảnh thật đang phát" (D-RL-06, khóa 2026-08-29).
//
// Ảnh vốn là FILE — chỗ của nó là KHO FILE, không phải cơ sở dữ liệu. Cách cũ nhét chuỗi base64
// vài chục KB thẳng vào một bản ghi/luồng và ghi đè mỗi ~45 giây: ở 162 luồng là ~3,6 lượt ghi/giây
// toàn bản ghi NẶNG; lên 300–500 luồng thì đây là khoản đắt và chậm nhất của cả hệ.
//
// Tách ra file riêng vì file route của Next.js KHÔNG được export thêm gì ngoài GET/POST…
export const THUMB_GCS_ON = () => process.env.RISE_LIVE_THUMB_GCS === "1";
export const thumbObjectKey = (streamId: string) => `live-thumbs/${streamId}.jpg`;

/**
 * NHỊP ĐẨY ẢNH lên máy chủ (giây) — MỘT nguồn duy nhất cho cả worker, route phục vụ ảnh và giao diện.
 *
 * Vì sao gom về đây (bài học 29/08/2026): dòng chú thích trên giao diện ghi "cập nhật ~45s" nên tôi
 * tin luôn và đặt trình duyệt tải lại ảnh mỗi 45 giây. Thực tế nhịp ĐẨY đã được giãn thành 300 giây
 * từ trước — 45 giây chỉ là nhịp CHỤP để dò màn đen. Hậu quả: tải thừa gấp ~6 lần (mở màn Live 123
 * luồng thì cứ 45 giây lại tải lại 123 tấm ảnh y hệt).
 * Gõ cứng con số ở nhiều nơi thì kiểu gì cũng lệch nhau. Nay chỉ có một chỗ.
 */
export const thumbPushSec = () => Math.max(60, Number(process.env.RISE_LIVE_THUMB_PUSH_SEC) || 300);

/**
 * Trình duyệt nên giữ lại ảnh bao lâu, và mốc đổi địa chỉ ảnh (giây).
 * Lấy MỘT NỬA nhịp đẩy: đảm bảo thấy ảnh mới trong vòng nửa nhịp, mà vẫn cắt phần lớn lượt tải thừa.
 */
export const thumbCacheSec = () => Math.max(30, Math.floor(thumbPushSec() / 2));
