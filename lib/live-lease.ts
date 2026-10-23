// RISE LIVE — Dự phòng nhiều VPS · ĐỢT 2. Cấu hình "giấy phép phát" cho cơ chế TỰ DỪNG KHI CÔ LẬP.
//
// Ý tưởng: một luồng đặt TỰ ĐỘNG CHUYỂN (failoverMode=automatic) — nếu máy đang phát bị cô lập
// (mất liên lạc với máy chủ) thì hệ thống có thể đã chuyển luồng sang máy khác. Để KHÔNG phát trùng,
// worker của máy cô lập phải TỰ DỪNG luồng đó sau một khoảng ân hạn (grace). CHỈ áp cho luồng
// automatic — luồng thường KHÔNG tự dừng (giữ phát tối đa, vì không ai chuyển nó đi).
//
// MẶC ĐỊNH TẮT (cờ RISE_LIVE_LEASE). Chưa bật → không luồng nào tự dừng → hành vi y như trước.

export const LEASE_FEATURE_ON = () => process.env.RISE_LIVE_LEASE === "1";

// Ân hạn (giây) worker được phép mất liên lạc trước khi tự dừng luồng automatic. Phải đủ dài để
// không dừng nhầm khi máy chủ vừa deploy/nhịp mạng chớp — nhưng ngắn hơn thời gian hệ thống chuyển
// luồng sang máy mới, để không phát trùng. Cấu hình RISE_LIVE_LEASE_GRACE_SEC; mặc định 60s.
export const LEASE_GRACE_SEC = (): number => {
  const n = Number(process.env.RISE_LIVE_LEASE_GRACE_SEC);
  return Number.isFinite(n) && n >= 20 ? Math.round(n) : 60;
};

// Luồng có bật "tự dừng khi cô lập" hay không. PHẢI KHỚP đúng tập luồng được auto-failover
// (isAutoProtected trong app/api/live/failover/run: automatic HOẶC ưu-tiên/trọng-yếu, TRỪ live-pub) —
// nếu tập tự-dừng HẸP hơn tập tự-chuyển thì luồng ưu-tiên-chưa-đặt-automatic sẽ bị chuyển mà máy cũ
// KHÔNG tự dừng → rủi ro PHÁT TRÙNG. Đồng bộ để "không bao giờ phát trùng" luôn đúng.
export function streamLeaseEnabled(stream: any): boolean {
  if (!LEASE_FEATURE_ON()) return false;
  if (String(stream?.mode) === "live-pub") return false;   // Live Pub không tự-chuyển → không cần tự-dừng
  const imp = String(stream?.importance || (stream?.priority ? "priority" : "normal"));
  const prio = imp === "priority" || imp === "critical";
  return stream?.failoverMode === "automatic" || prio;
}
