// DANH MỤC MÃ SỰ CỐ RISE LIVE — nguồn dùng chung cho tab "Mã lỗi" (giao diện) + tài liệu.
// Mỗi mã RL-XXX khớp với cảnh báo sinh ở lib/live-alerts.ts. Ghi rõ: TRIỆU CHỨNG · HỆ TỰ LÀM GÌ ·
// NGƯỜI CẦN LÀM GÌ · ai chịu chính (auto / human / both). Thuần dữ liệu, không đọc/ghi Firestore.

export type IncidentSeverity = "INFO" | "WARNING" | "CRITICAL" | "EMERGENCY";
export type HandledBy = "auto" | "human" | "both";

export interface IncidentDef {
  code: string;            // mã RL-XXX
  severity: IncidentSeverity;
  title: string;           // tên ngắn
  symptom: string;         // TRIỆU CHỨNG — nhìn thấy gì
  autoAction: string;      // HỆ THỐNG tự làm gì (— nếu không)
  humanAction: string;     // NGƯỜI cần làm gì (— nếu không)
  handledBy: HandledBy;    // ai chịu chính
  group: "Máy" | "Băng thông" | "Luồng" | "YouTube" | "Video/Ổ đĩa";
}

export const INCIDENT_CATALOG: IncidentDef[] = [
  // ── MÁY ──
  {
    code: "RL-NET-003", severity: "EMERGENCY", title: "Máy mất kết nối (VPS chết)", group: "Máy",
    symptom: "Máy ngừng báo tín hiệu (heartbeat) > 60s — mọi luồng trên máy đang tắt. LƯU Ý ca 'HỎNG MỘT CHIỀU' (gặp thật 29/08/2026): máy vẫn hiện Online (nó gọi RA được) nhưng KHÔNG AI GỌI VÀO ĐƯỢC — dấu hiệu: nhiều luồng cùng máy cùng rớt một lúc + chuyển máy báo 'không tới được máy nguồn'.",
    autoAction: "Tự CỨU các luồng ƯU TIÊN sang VPS khác (~15s, không phát trùng). Luồng thường phải xử tay. Ca hỏng-một-chiều: máy vẫn Online nên tự-cứu KHÔNG kích hoạt.",
    humanAction: "Nhiều luồng cùng máy cùng tắt = vấn đề của MÁY: báo quản lý rồi CHỜ, đừng mỗi người tự bấm chuyển máy (chuyển hàng loạt khi máy nguồn không với tới được chỉ sinh thêm cảnh báo lỗi giả). Báo nhà cung cấp kèm bằng chứng, và ĐỪNG reset vội để họ kịp vào xem.",
    handledBy: "both",
  },
  {
    code: "RL-RES-003", severity: "WARNING", title: "CPU quá tải", group: "Máy",
    symptom: "Tải CPU > 1.5× số nhân. (Đã BỎ nén video trên VPS nên CPU cao là BẤT THƯỜNG — không còn do nén.)",
    autoAction: "—",
    humanAction: "Kiểm tra tiến trình lạ / quá nhiều luồng trên máy; phát chỉ là copy (nhẹ) nên CPU cao cần soi kỹ.",
    handledBy: "human",
  },
  // ── BĂNG THÔNG (ca 'bị bóp giờ cao điểm') ──
  {
    code: "RL-NET-005", severity: "WARNING", title: "Nghẽn băng thông CẢ MÁY", group: "Băng thông",
    symptom: "≥2 luồng trên cùng máy CÙNG tụt tốc một lúc → nghẽn băng thông cả máy (kể cả khi bị nhà cung cấp BÓP dưới trần, VD giờ cao điểm).",
    autoAction: "Luồng ƯU TIÊN đang tụt kéo dài → tự chuyển sang VPS còn dư băng thông (thận trọng, cooldown 15').",
    humanAction: "Luồng THƯỜNG: hạ bitrate (nếu 1080p vẫn không đủ) HOẶC bấm 'Chuyển máy' để dời luồng sang VPS còn dư; hoặc giảm bớt luồng trên máy này.",
    handledBy: "both",
  },
  {
    code: "RL-RES-004", severity: "CRITICAL", title: "Băng thông gần đầy / đầy", group: "Băng thông",
    symptom: "txMbps ≥ 85% (vàng) / ≥ 95% (đỏ) so với trần upload đã đặt — luồng sắp/đang giật.",
    autoAction: "Luồng ưu tiên tụt kéo dài → tự chuyển máy.",
    humanAction: "Hạ bitrate hoặc giảm luồng. LƯU Ý: đặt đúng trần thật của máy (bị bóp thì đặt = mức bị bóp) cảnh báo mới chuẩn.",
    handledBy: "both",
  },
  {
    code: "RL-RES-006", severity: "WARNING", title: "Băng thông tối đa đo sai (cảnh báo % không đáng tin)", group: "Băng thông",
    symptom: "Máy đang đẩy NHIỀU HƠN 'băng thông tối đa' đã ghi (VD 1038/132 Mbps) — số tối đa (đo speedtest) sai/quá thấp, nên % 'gần đầy' là ẢO. Đã đẩy được mức đó nghĩa là đường truyền thật ≥ mức đó.",
    autoAction: "Tự BỎ cảnh báo 'gần đầy băng thông' (RL-RES-004) cho máy này khi trần sai (tránh báo động giả). Nghẽn thật vẫn bắt qua RL-NET-005 (đo độ tụt luồng, không phụ thuộc trần).",
    humanAction: "Vào Máy → Sửa → đặt lại 'băng thông tối đa' đúng thực tế của máy (hoặc để hệ thống đo lại lúc rảnh).",
    handledBy: "both",
  },
  {
    code: "RL-RES-007", severity: "WARNING", title: "Luồng ưu tiên chưa có bản dự phòng", group: "Băng thông",
    symptom: "Luồng ƯU TIÊN đang chạy nhưng KHÔNG máy nào khác giữ bản sao video. Hệ chỉ chuyển máy được khi máy đích ĐÃ CÓ SẴN video — nên lúc này luồng đang chạy mà KHÔNG CÒN LƯỚI AN TOÀN. Thường do máy khác hết ổ / hết băng thông, thiếu địa chỉ IP máy nguồn, hoặc bản dự phòng vừa bị xoá.",
    autoAction: "Mỗi phút hệ tự thử tạo lại bản dự phòng (copy thẳng từ máy đang giữ, giữ nguyên chất lượng). Không đủ điều kiện thì KHÔNG tạo được — trước đây im lặng, nay báo ra cảnh báo này.",
    humanAction: "Kiểm ổ trống + băng thông các máy còn lại; dọn bản dự phòng không còn dùng (Kho video) để lấy chỗ; hoặc sao chép tay video sang một máy khác. Nếu để nguyên: máy hiện tại chết là MẤT SÓNG, phải xử tay.",
    handledBy: "both",
  },
  {
    code: "RL-RES-008", severity: "INFO", title: "Máy chạm ngưỡng an toàn 70% — không nhận thêm luồng live", group: "Băng thông",
    symptom: "Băng thông đang dùng của máy đã chạm 70% mức tối đa. Máy VẪN CHẠY TỐT, chưa giật — đây là báo SỚM để còn kịp xử lý, khác với RL-RES-004 (85% sắp đầy / 95% đang giật).",
    autoAction: "Ô chọn máy khi TẠO LUỒNG và khi TẢI VIDEO LÊN sẽ KHOÁ máy này (vẫn hiện trong danh sách kèm lý do, để biết máy tồn tại mà đang đầy). KHÔNG chặn tải bản SAO LƯU dự phòng — bản sao lưu chỉ nằm trên ổ, không phát sóng nên không tốn băng thông. Luồng ưu tiên cần cứu sự cố vẫn được chuyển về đây nếu không còn máy nào khác.",
    humanAction: "Luồng mới hãy chọn máy khác còn trống. Nếu tất cả máy đều chạm ngưỡng: bổ sung VPS, hoặc tải video lên với mức chất lượng nhẹ hơn (1080p Nhẹ ~4,5 Mbps thay cho Giữ nguyên gốc) — nhạc hình tĩnh gần như không thấy khác biệt.",
    handledBy: "both",
  },
  {
    code: "RL-RES-009", severity: "WARNING", title: "Máy đầy — không nhận thêm video mới", group: "Video/Ổ đĩa",
    symptom: "Thêm video hoặc kéo-thả tải lên một máy thì bị từ chối, kèm câu nêu rõ máy đã chạm 70% băng thông hoặc còn quá ít ổ trống.",
    autoAction: "Chặn NGAY tại giao diện trước khi tải (khỏi tải xong file lớn mới báo hỏng) và chặn lại lần nữa ở máy chủ. NGOẠI LỆ: bản SAO LƯU dự phòng VẪN được nhận dù băng thông đã chạm ngưỡng — vì chỉ cất giữ, không phát; nhưng vẫn phải đủ ổ trống.",
    humanAction: "Chọn máy khác còn trống, hoặc xoá bớt video không dùng trên máy đó, hoặc giảm bớt luồng đang phát để hạ băng thông.",
    handledBy: "both",
  },
  {
    code: "RL-RES-010", severity: "WARNING", title: "Luồng hẹn giờ sắp bật mà máy sắp quá tải", group: "Băng thông",
    symptom: "Trước giờ phát của một luồng hẹn giờ, có thông báo: máy sẽ vượt ngưỡng an toàn 70% khi luồng này bật. Với luồng 24/7 kèm thông báo đã tự dời sang máy khác.",
    autoAction: "Hệ thống quét các luồng hẹn giờ SẮP tới giờ (mặc định 10 phút trước, đặt được qua RISE_LIVE_SCHEDULE_LOOKAHEAD_MIN) và cộng thử băng thông. Nếu máy sẽ vượt 70%: luồng 24/7 → TỰ DỜI sang máy còn chỗ đã có sẵn video (luồng đang dừng nên KHÔNG mất sóng); luồng Live Pub → KHÔNG dời, chỉ cảnh báo (Pub rớt là YouTube đóng buổi phát, dời máy vô nghĩa).",
    humanAction: "Nếu nhận cảnh báo mà hệ không dời được (không máy nào đủ chỗ + đã có sẵn video): hạ chất lượng luồng, dời lịch sang khung giờ khác, hoặc dừng bớt luồng đang chạy trên máy đó.",
    handledBy: "both",
  },
  // ── LUỒNG ──
  {
    code: "RL-PRC-001", severity: "CRITICAL", title: "Luồng lỗi / sập", group: "Luồng",
    symptom: "Worker báo luồng LỖI/SẬP (FFmpeg dừng bất thường).",
    autoAction: "Worker TỰ khởi động lại luồng ngay.",
    humanAction: "Nếu lặp lại nhiều lần (xem RL-PRC-003) → kiểm tra video/nguồn.",
    handledBy: "auto",
  },
  {
    code: "RL-PRC-003", severity: "CRITICAL", title: "Chớp tắt liên tục — phân loại lỗi tạm thời vs vĩnh viễn", group: "Luồng",
    symptom: "Luồng bật-tắt liên tục. Hệ phân biệt: lỗi NGUỒN/FILE (vĩnh viễn) vs lỗi MẠNG/VPS (tạm thời).",
    autoAction: "Lỗi NGUỒN/FILE (file hỏng/decode lỗi) → DỪNG NGAY, không tự bật lại (thử vô ích). Lỗi MẠNG/VPS → chớp tắt tới ngưỡng thì tạm ngừng, TỰ THỬ LẠI mỗi 5 phút cho tới khi hết sự cố.",
    humanAction: "Nếu báo 'ĐÃ DỪNG do lỗi nguồn/file': tải lại video (thử nhãn NÉN) hoặc kiểm khoá luồng, rồi Bật lại tay. Nếu 'đang TỰ THỬ LẠI': ĐỪNG ĐỤNG VÀO — hệ tự bật lại mỗi 5 phút, lặp mãi; mạng ổn là luồng tự lên, bấm tay chỉ làm rối. Lưu ý: việc tự thử lại chỉ chạy khi máy còn liên lạc được — máy chết hẳn thì cứu MÁY trước, đừng đi bật từng luồng.",
    handledBy: "both",
  },
  {
    code: "RL-NET-004", severity: "WARNING", title: "Luồng tụt tốc (đẩy chậm hơn thời gian thực)", group: "Luồng",
    symptom: "1 luồng đẩy chậm hơn thời gian thực kéo dài — người xem dễ giật/buffer.",
    autoAction: "Luồng ƯU TIÊN + tụt đủ lâu → tự chuyển sang VPS khác (bàn giao an toàn).",
    humanAction: "Luồng THƯỜNG: hạ bitrate, hoặc bấm 'Chuyển máy' để dời sang VPS còn dư (khi hạ chất lượng vẫn không đủ).",
    handledBy: "both",
  },
  {
    code: "RL-MED-008", severity: "WARNING", title: "Màn đen kéo dài", group: "Luồng",
    symptom: "Đang phát nhưng khung hình đen tuyền > 3 phút.",
    autoAction: "—",
    humanAction: "Kiểm tra video/nguồn. Nếu đen CHỦ Ý (nhạc ngủ…) → bấm '✓ Nền đen chủ ý' ngay ở cảnh báo.",
    handledBy: "human",
  },
  {
    code: "RL-PRC-007", severity: "WARNING", title: "Chưa có tín hiệu", group: "Luồng",
    symptom: "Luồng ở trạng thái live nhưng chưa nhận được tín hiệu.",
    autoAction: "—",
    humanAction: "Kiểm tra nguồn/khoá luồng; chờ vài giây; nếu kéo dài thì tạo lại.",
    handledBy: "human",
  },
  {
    code: "RL-YTB-004", severity: "WARNING", title: "Sức khoẻ luồng KÉM", group: "Luồng",
    symptom: "YouTube/worker báo chất lượng luồng ở mức kém.",
    autoAction: "—",
    humanAction: "Theo dõi; cân nhắc hạ bitrate nếu do băng thông.",
    handledBy: "human",
  },
  // ── YOUTUBE (chuyển máy vô ích → người xử) ──
  {
    code: "RL-YTB-006", severity: "CRITICAL", title: "Nghi bị chặn/đình chỉ trên YouTube", group: "YouTube",
    symptom: "Nghi bị chặn bản quyền/đình chỉ TRÊN YOUTUBE dù máy vẫn đẩy tín hiệu đều.",
    autoAction: "KHÔNG tự chuyển máy (chuyển sang VPS khác cũng không giải quyết được — lỗi phía YouTube).",
    humanAction: "Vào YouTube Studio kiểm tra kênh/bản quyền/đình chỉ và xử theo YouTube.",
    handledBy: "human",
  },
  {
    code: "RL-YTB-007", severity: "CRITICAL", title: "Video đã bị GỠ khỏi YouTube", group: "YouTube",
    symptom: "Video của luồng KHÔNG CÒN TỒN TẠI trên YouTube (nghi bản quyền hoặc đình chỉ) trong khi máy vẫn đẩy tín hiệu đều — màn hình vẫn xanh \"Đang phát · Tín hiệu ổn\". Ca thật 30/08/2026: luồng bị bản quyền, video bị xoá, luồng tắt hẳn mà hệ không phát hiện suốt nhiều giờ.",
    autoAction: "Hỏi YouTube về từng video đang phát. Video ĐÃ TỪNG lên sóng (có mốc xác nhận) mà nay YouTube không tìm thấy nữa → đánh dấu sự cố + báo chủ luồng và Ban lãnh đạo. Video CHƯA từng lên sóng thì bỏ qua — đó là link dán sai, không phải bị gỡ. Phải nghi 2 lần liên tiếp mới báo, chống báo oan khi API trục trặc một nhịp.",
    humanAction: "Vào YouTube Studio kiểm tra bản quyền/đình chỉ. Máy vẫn đang đẩy tín hiệu vào chỗ trống nên DỪNG luồng lại cho đỡ tốn băng thông, rồi tạo buổi phát mới nếu cần.",
    handledBy: "human",
  },
  {
    code: "RL-YTB-008", severity: "CRITICAL", title: "Buổi phát của luồng hết live (kênh vẫn có buổi khác)", group: "YouTube",
    symptom: "Buổi phát của MỘT luồng không còn live, nhưng kênh vẫn có buổi khác đang phát nên phép kiểm cấp kênh không thấy gì. Ca thật 30/08/2026: kênh chạy 5 luồng, một luồng chết mà bốn luồng kia che mất — không cảnh báo nào nổ.",
    autoAction: "Với kênh đã kết nối YouTube: so mã buổi phát của TỪNG luồng với danh sách buổi đang live của kênh (thay vì chỉ hỏi kênh có buổi nào live không). Luồng nào đã từng lên sóng mà nay không còn trong danh sách → báo. Không gọi thêm lần nào tới YouTube, dùng lại dữ liệu vừa lấy.",
    humanAction: "Vào YouTube Studio xem buổi phát đó vì sao kết thúc (bản quyền, tự tắt, hết hạn). Dừng luồng trong app rồi tạo buổi mới nếu cần.",
    handledBy: "human",
  },
  // ── VIDEO / Ổ ĐĨA ──
  {
    code: "RL-RES-002", severity: "CRITICAL", title: "Ổ đĩa gần đầy", group: "Video/Ổ đĩa",
    symptom: "Ổ còn < 15GB / < 3% — nguy cơ ảnh hưởng luồng đang chạy.",
    autoAction: "Đã CHẶN tải/nén video MỚI để bảo vệ luồng đang chạy.",
    humanAction: "Dọn video không dùng ngay để giải phóng ổ.",
    handledBy: "both",
  },
  {
    code: "RL-RES-001", severity: "WARNING", title: "Ổ đĩa còn thấp", group: "Video/Ổ đĩa",
    symptom: "Ổ còn dưới ~10% dung lượng.",
    autoAction: "—",
    humanAction: "Dọn bớt video cũ trước khi đầy.",
    handledBy: "human",
  },
  {
    code: "RL-MED-012", severity: "WARNING", title: "Tải video về khi đang phát", group: "Video/Ổ đĩa",
    symptom: "Máy đang TẢI video (giữ nguyên gốc — chỉ copy, không nén lại) trong khi có luồng phát → CPU tăng NHẸ.",
    autoAction: "Tự chặn tải mới nếu ổ đĩa nguy hiểm (RL-RES-002). (Đã bỏ nén trên VPS — chỉ còn tải + chuẩn audio, rất nhẹ.)",
    humanAction: "Thường không cần làm gì; nếu ổ sắp đầy thì dọn video cũ trước khi tải thêm.",
    handledBy: "both",
  },
  {
    code: "RL-MED-002", severity: "CRITICAL", title: "Video xử lý lỗi", group: "Video/Ổ đĩa",
    symptom: "Video tải/nén bị lỗi, không dùng để phát được.",
    autoAction: "—",
    humanAction: "Kiểm tra file nguồn; tải/nén lại rồi tạo luồng mới.",
    handledBy: "human",
  },
  {
    code: "RL-MED-013", severity: "WARNING", title: "Không sao chép được video sang máy khác", group: "Video/Ổ đĩa",
    symptom: "Bấm 'Chuyển (tự copy)' ra lỗi 'không kết nối tới được máy nguồn'. Thường nổ HÀNG LOẠT khi một máy mất mạng (29/08/2026 để lại 16 cái).",
    autoAction: "KHÔNG phải sự cố nghiêm trọng — luồng gốc VẪN ĐANG PHÁT, đây chỉ là bản sao chưa tạo được. Hệ TỰ DỌN các bản ghi lỗi này sau 30 phút để không che mất cảnh báo thật.",
    humanAction: "ĐỪNG bấm chuyển lại nhiều lần — máy nguồn không với tới được thì lần nào cũng hỏng. Cách xử: dùng 'Thêm video' dán lại link Google Drive vào máy đích, hoặc chờ máy nguồn hồi rồi sao chép lại.",
    handledBy: "both",
  },
  {
    code: "RL-NET-007", severity: "WARNING", title: "Máy không gọi về được nhưng vẫn sống", group: "Máy",
    symptom: "Máy ngừng gửi tin về hệ thống, NHƯNG hệ thống gọi thẳng vào máy thì vẫn được trả lời. Máy còn sống, luồng nhiều khả năng vẫn đang phát bình thường.",
    autoAction: "Hệ TỰ XÁC MINH bằng cách gọi vào cổng worker trước khi kết luận: máy trả lời thì KHÔNG báo động và KHÔNG tự chuyển luồng. Dùng một máy đang khoẻ làm mốc đối chứng — nếu chính máy khoẻ cũng không gọi vào được thì hệ hiểu là đường ra của mình hỏng và không kết luận gì.",
    humanAction: "Không cần xử lý gấp — luồng vẫn phát. Nếu lặp lại nhiều lần trên cùng một máy thì kiểm đường mạng của VPS đó đi ra ngoài (nhà cung cấp), vì nó gọi ra không ổn định.",
    handledBy: "auto",
  },
  {
    code: "RL-NET-006", severity: "EMERGENCY", title: "Mất liên lạc với NHIỀU máy cùng lúc", group: "Máy",
    symptom: "Từ 2 máy trở lên cùng ngừng báo cáo trong một lần quét.",
    autoAction: "Hệ gộp thành MỘT cảnh báo thay vì bắn từng máy, và nói rõ nghi lỗi phía hệ thống.",
    humanAction: "Nhiều máy ở nhiều nhà cung cấp không thể cùng hỏng một lúc — kiểm HỆ THỐNG (Cloud Run, mạng ra ngoài) TRƯỚC khi gọi nhà cung cấp VPS. Luồng live đi thẳng VPS → YouTube nên nhiều khả năng vẫn đang phát; kiểm trên YouTube để xác nhận.",
    handledBy: "both",
  },
  {
    code: "RL-MED-014", severity: "WARNING", title: "Tải video chậm bất thường", group: "Video/Ổ đĩa",
    symptom: "Một video tải về dưới ~100 MB/phút, trong khi máy khoẻ đạt 1.000–1.200 MB/phút. Người thêm video thấy 'Đang tải' đứng rất lâu, tưởng hệ thống treo.",
    autoAction: "Hệ ghi lại tốc độ tải từng video và tự kêu khi máy nào chậm bất thường — không đợi ai để ý.",
    humanAction: "Xem cảnh báo RL-MED-015 trên cùng máy trước (công cụ tải cũ là nguyên nhân hay gặp nhất). Nếu công cụ đã mới mà vẫn chậm thì đường mạng máy đó đi Google có vấn đề — báo nhà cung cấp, và tạm thêm video vào máy khác.",
    handledBy: "both",
  },
  {
    code: "RL-MED-015", severity: "WARNING", title: "Máy thiếu hoặc dùng bản cũ công cụ tải Drive", group: "Video/Ổ đĩa",
    symptom: "Máy chưa có yt-dlp/gdown, hoặc cơ chế tự cập nhật hằng ngày đang hỏng (hay gặp nhất: máy mới dựng chưa có pip3, hoặc kho phần mềm Ubuntu Pro trả lỗi 401).",
    autoAction: "Máy tự khai bản công cụ mỗi nhịp báo về; tự thử cập nhật lại mỗi ngày và BÁO RA khi thất bại (trước 30/08/2026 phần này hỏng im lặng).",
    humanAction: "SSH vào máy: apt-get install -y python3-pip rồi pip3 install -U --break-system-packages yt-dlp gdown, sau đó systemctl restart rise-live. Nếu apt báo 401 ở esm.ubuntu.com thì chuyển file /etc/apt/sources.list.d/*esm* ra chỗ khác rồi thử lại.",
    handledBy: "both",
  },
  {
    code: "RL-MED-016", severity: "CRITICAL", title: "Sổ nói CÓ video, máy KHÔNG có file", group: "Video/Ổ đĩa",
    symptom: "Kho video ghi video ở trạng thái Sẵn sàng trên một máy, nhưng máy đó báo về là nó KHÔNG giữ file ấy. Luồng dùng video này đứng im ở \"Chờ chạy\" và KHÔNG báo lỗi gì — máy phát gặp thiếu video thì lặng lẽ bỏ qua. Sự cố thật 30/08/2026: 2 video tải-thẳng bị xoá khỏi ổ trong khi sổ vẫn ghi Sẵn sàng.",
    autoAction: "Mỗi nhịp máy báo về, hệ đối chiếu danh sách video trong sổ với danh sách máy thật sự đang giữ. Lệch thì ghi mốc thời điểm; chỉ kêu khi lệch KÉO DÀI quá 5 phút (máy vừa khởi động lại cần 1-2 nhịp để nhận lại kho, không kêu oan).",
    humanAction: "Thêm lại video vào máy đó. LƯU Ý: video TẢI-THẲNG từ máy tính KHÔNG có link nguồn nên hệ không tự tải lại được — phải tải lên lại, hoặc chép từ máy khác nếu máy khác còn bản. Video từ link Drive thì chỉ cần xoá bản ghi hỏng rồi thêm lại link.",
    handledBy: "both",
  },
];

export const HANDLED_BY_LABEL: Record<HandledBy, string> = {
  auto: "🤖 Hệ tự xử",
  human: "🧑 Người xử",
  both: "🤝 Hệ + Người",
};
