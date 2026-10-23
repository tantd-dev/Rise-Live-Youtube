// RISE LIVE — BẢNG NGƯỠNG CẢNH BÁO, GOM VỀ MỘT CHỖ (quyết định D-RL-05, khóa 2026-08-29).
//
// TRƯỚC ĐÂY: mọi con số ngưỡng nằm rải rác giữa mã trong `lib/live-alerts.ts` (60000, 1.5, 0.85,
// 0.95, 0.70, 15GB, 20GB…). Muốn chỉnh một ngưỡng phải đi dò trong 200 dòng, và không ai nhìn được
// TOÀN CẢNH "hệ đang kêu ở mức nào". Đây là chỗ duy nhất chứa các con số đó.
//
// ⚠ BƯỚC NÀY KHÔNG ĐỔI HÀNH VI: mọi giá trị mặc định = ĐÚNG con số đang chạy trước khi gom.
//   Chỉ đổi CẤU TRÚC. Muốn chỉnh ngưỡng thì đổi ở đây (hoặc đặt biến môi trường), không sửa rải rác.
//
// CÁCH CHỈNH KHÔNG CẦN DEPLOY: mỗi ngưỡng đọc được từ biến môi trường tương ứng. Đặt sai kiểu
// (không phải số) → tự dùng lại mặc định, KHÔNG im lặng nhận giá trị rác.

/** Đọc số từ biến môi trường; không hợp lệ → dùng mặc định (không đoán bừa). */
function num(envName: string, macDinh: number): number {
  const raw = process.env[envName];
  if (raw == null || raw === "") return macDinh;
  const v = Number(raw);
  return Number.isFinite(v) ? v : macDinh;
}

export const LIVE_THRESHOLDS = {
  /** Máy coi là "online" nếu còn báo về trong bấy nhiêu mili-giây. Worker báo ~20s/lần. */
  machineOnlineMs: num("RL_TH_MACHINE_ONLINE_MS", 60_000),

  /**
   * Luồng "còn tươi" — worker còn báo trạng thái gần đây.
   * BÌNH THƯỜNG 60s. Khi bật GHI-KHI-ĐỔI (RISE_LIVE_WRITE_ON_CHANGE=1) thì worker chỉ ghi khi có
   * thay đổi hoặc mỗi ~120s → phải NỚI lên 200s cho khớp, tránh báo "chết oan" luồng đang chạy tốt.
   * Chết THẬT vẫn bắt được: máy chết → cảnh báo MÁY; luồng lỗi → worker báo error NGAY.
   */
  streamFreshMs: () =>
    process.env.RISE_LIVE_WRITE_ON_CHANGE === "1"
      ? num("RL_TH_STREAM_FRESH_WOC_MS", 200_000)
      : num("RL_TH_STREAM_FRESH_MS", 60_000),

  /**
   * ĐỐI CHIẾU KHO VIDEO — ân hạn trước khi kêu "sổ nói có, máy không có file".
   * BẮT BUỘC phải có: worker vừa khởi động lại thì bộ nhớ của nó trống, báo về rỗng, nhìn như mất
   * sạch video. Nó tự nhận lại trong 1–2 nhịp (~40 giây). 5 phút là rộng rãi mà vẫn bắt sớm.
   */
  assetMissingGraceMs: num("RL_TH_ASSET_MISSING_GRACE_MS", 300_000),

  /** CPU quá tải: load trung bình vượt bấy nhiêu LẦN số nhân. Nén video làm load cao tạm thời là bình thường. */
  cpuLoadFactor: num("RL_TH_CPU_LOAD_FACTOR", 1.5),

  /** Ổ đĩa — mức NGUY CẤP (chặn tải/nén video mới để bảo vệ luồng đang chạy). */
  diskCritPct: num("RL_TH_DISK_CRIT_PCT", 0.03),
  diskCritFreeGb: num("RL_TH_DISK_CRIT_GB", 15),
  /** Ổ đĩa — mức NHẮC dọn. */
  diskWarnPct: num("RL_TH_DISK_WARN_PCT", 0.10),
  /** Khi KHÔNG biết dung lượng tổng của ổ thì chỉ so số GB còn trống. */
  diskWarnFreeGbNoTotal: num("RL_TH_DISK_WARN_GB", 20),

  /**
   * Băng thông — "trần đo SAI": đang đẩy nhiều hơn trần đã ghi × hệ số này thì trần chắc chắn sai
   * (không thể đẩy vượt đường truyền thật). Đệm cho nhiễu đo.
   */
  bwCapWrongFactor: num("RL_TH_BW_CAP_WRONG", 1.05),
  /** Băng thông — đang giật rồi. */
  bwFull: num("RL_TH_BW_FULL", 0.95),
  /** Băng thông — sát mép. */
  bwHigh: num("RL_TH_BW_HIGH", 0.85),
  /** Băng thông — NGƯỠNG AN TOÀN (Chủ Rise Group chốt 27/08/2026): từ mốc này máy KHÔNG nhận thêm luồng mới. */
  bwSafe: num("RL_TH_BW_SAFE", 0.70),

  /** Nghẽn cả máy: bao nhiêu luồng CÙNG tụt tốc độ một lúc thì kết luận nghẽn máy (không phải lỗi 1 luồng). */
  saturatedMinSlow: num("RL_TH_SATURATED_MIN_SLOW", 2),

  /** "Chớp tắt": đếm số lần bật lại DỒN trong cửa sổ này. Không dùng tổng cả phiên (tránh gộp nhầm). */
  restartWindowMs: num("RL_TH_RESTART_WINDOW_MS", 15 * 60 * 1000),
  /** Bao nhiêu lần bật lại trong cửa sổ trên thì coi là đang chớp tắt. */
  restartMinCount: num("RL_TH_RESTART_MIN", 3),

  /** Màn đen: máy chủ đếm thêm bấy nhiêu sau khi worker đã xác nhận 60s đen (tổng ~3 phút). */
  blackMinMs: num("RL_TH_BLACK_MIN_MS", 120_000),

  /**
   * TẢI VIDEO CHẬM BẤT THƯỜNG (V71.17) — MB/phút. Dưới mức này thì máy có vấn đề, không phải "mạng
   * hôm nay hơi chậm". Căn cứ đo thật 30/08/2026: máy khoẻ đạt ~1.000–1.200 MB/phút, và đo tốc độ
   * tải thẳng từ Google được 44 MB/GIÂY (≈2.640 MB/phút). VPS 06 khi dùng yt-dlp bản 2022 chỉ đạt
   * 46,7 MB/phút — chậm 56 lần khả năng thật của chính nó mà không ai biết suốt một ngày.
   * 100 MB/phút vẫn còn rất rộng tay so với máy chậm nhất, nên báo là báo thật.
   */
  slowDownloadMbPerMin: num("RL_TH_SLOW_DOWNLOAD_MB_MIN", 100),
  // CỬA SỔ THỜI GIAN cho cảnh báo "tải video chậm" (01/09/2026 — Chủ Rise Group: "video đã lên
  // rồi mà thông báo không mất"). Trước đây luật này soi MỌI video từng tải chậm trên máy, không
  // giới hạn thời gian — nên một lần tải chậm đêm qua sẽ kêu MÃI MÃI dù video đã tải xong và
  // đang dùng bình thường. Nay chỉ xét lần tải trong ~6 giờ gần đây → tự hết khi hết chuyện.
  slowDownloadWindowMs: num("RL_TH_SLOW_DOWNLOAD_WINDOW_H", 6) * 3600_000,
  // Video ĐÃ TẢI XONG thì cảnh báo chỉ nhắc ngắn rồi tự tắt — việc đã xong, không còn gì để xử lý.
  slowDownloadDoneWindowMs: num("RL_TH_SLOW_DOWNLOAD_DONE_MIN", 30) * 60_000,
  /** Video nhỏ hơn mức này thì bỏ qua (thời gian tải quá ngắn, con số MB/phút nhiễu). */
  slowDownloadMinSizeMb: num("RL_TH_SLOW_DOWNLOAD_MIN_MB", 50),

  /**
   * MÁY IM BAO LÂU THÌ COI LÀ NGHIÊM TRỌNG (giây) — dưới mức này chỉ NHẮC, không email/không rung.
   * Vì sao 300 (5 phút): worker báo 20 giây/lần, mà chỉ một lượt gửi bị treo là đã im ~50 giây
   * (chờ 30 giây rồi ngủ 20 giây) — tức chạm ngưỡng 60 giây mà máy KHÔNG hỏng gì. Chớp như vậy
   * từng bị dán nhãn "NGHIÊM TRỌNG", người nhận hoảng rồi vào chuyển luồng — cắt sóng THẬT để chữa
   * một sự cố KHÔNG CÓ THẬT (Chủ Rise Group 30/08/2026). Im tới 5 phút thì mới là chuyện thật.
   * ⚠ KHÔNG liên quan tốc độ cứu: worker tự bật lại luồng tại máy dưới 1 giây, tự chuyển máy có
   *   biến riêng (RISE_LIVE_FAILOVER_OFFLINE_SEC). Đây CHỈ là mức độ to nhỏ của tiếng hô.
   */
  machineQuietSeriousSec: num("RL_TH_MACHINE_QUIET_SERIOUS_SEC", 300),
} as const;
