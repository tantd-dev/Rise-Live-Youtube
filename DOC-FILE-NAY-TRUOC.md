# RISE LIVE — gói mã nguồn để đọc và chỉnh sửa

> Đây là **hệ phát trực tiếp nhiều máy chủ (multi-VPS live streaming)** trích ra từ
> ứng dụng quản trị nội bộ **Rise Work** của Rise Group.
> Gói này đã **bỏ hết mật khẩu, khoá, địa chỉ máy thật**. Xem mục *Đã lược bỏ* ở dưới.

---

## ⚠️ ĐỌC MỤC NÀY TRƯỚC KHI CHẠY BẤT CỨ THỨ GÌ

Worker (`public/rise-live-agent.py`) nối vào máy chủ điều khiển qua biến `RISE_LIVE_URL`.

**TUYỆT ĐỐI KHÔNG đặt `RISE_LIVE_URL` trỏ về máy chủ Rise Work đang chạy thật.**

Không phải vì lý do bảo mật — mà vì **cơ chế giành quyền phát (lease)**: mỗi luồng chỉ
được đúng một máy phát, và máy nào báo danh sau sẽ **giành mất quyền phát của máy đang
phát**. Một worker thử nghiệm nối vào đàn máy thật sẽ **làm tắt các luồng đang phát thật**.

Trong gói này địa chỉ đó đã được thay bằng `<DIA-CHI-MAY-CHU-CUA-BAN>`. Hãy để nguyên
như vậy cho tới khi bạn dựng máy chủ điều khiển riêng.

---

## Hệ thống này làm gì

Chạy **hàng trăm luồng phát trực tiếp 24/7** lên YouTube từ nhiều máy chủ ảo (VPS), tự
phục hồi khi một máy chết. Quy mô đã chạy thật: **hơn 160 luồng trên 5 máy**, thiết kế
nhắm tới 500 luồng.

**Kiến trúc hai lớp — điểm cốt lõi cần hiểu trước khi sửa bất cứ gì:**

```
┌─────────────────────────────────────────────┐
│  LỚP ĐIỀU KHIỂN  (Next.js + Firestore)      │
│  · giao diện quản trị                        │
│  · quyết định luồng nào chạy ở máy nào       │
│  · cấp / thu quyền phát (lease)              │
│  · nhận nhịp tim, gom cảnh báo               │
└───────────────┬─────────────────────────────┘
                │  HTTP, hỏi/đáp mỗi ~10 giây
                │  (worker CHỦ ĐỘNG hỏi — máy chủ
                │   không cần mở cổng vào VPS)
   ┌────────────┼────────────┬────────────┐
   ▼            ▼            ▼            ▼
 VPS 1        VPS 2        VPS 3        VPS n
 worker.py    worker.py    worker.py    worker.py
   │
   └─ tự tải video (yt-dlp / gdown) → chuẩn hoá →
      chạy FFmpeg copy-codec đẩy lên YouTube RTMP
```

**Vì sao worker chủ động hỏi thay vì máy chủ ra lệnh:** không phải mở cổng nào trên
VPS, không cần IP tĩnh, không cần VPN. Thêm máy chỉ việc chạy một khối lệnh cài đặt.

**Vì sao FFmpeg dùng `copy-codec`:** không nén lại video → gần như không tốn CPU, nên
một VPS rẻ vẫn tải được vài chục luồng. Đổi lại: video nguồn **phải được chuẩn hoá
trước** (cùng khung hình, cùng codec) — phần chuẩn hoá đó nằm trong worker.

**Giới hạn thật sự là băng thông đẩy, không phải CPU.** Nên có `lib/live-capacity.ts`
tính sức chứa từng máy theo tốc độ upload, và ngưỡng an toàn đặt ở khoảng 70% băng
thông máy.

---

## Bản đồ tệp

| Đường dẫn | Nội dung |
|---|---|
| `public/rise-live-agent.py` | **Worker** (r2.42) — chạy trên mỗi VPS. Một tệp Python, không phụ thuộc thư viện ngoài. Đây là phần đáng đọc nhất. |
| `app/api/live/agent/route.ts` | Nơi worker hỏi/đáp — trái tim của hệ. Đọc tệp này trước tiên ở phía máy chủ. |
| `app/api/live/` | 13 điểm cuối máy chủ (nhịp tim, ảnh xem-trước, cảnh báo, chuyển máy, nhật ký, SSE, YouTube). |
| `lib/live-lease.ts` | Cấp / thu quyền phát. Đọc cùng `live-replica.ts` và `app/api/live/failover/`. |
| `lib/live-capacity.ts` | Tính sức chứa máy theo băng thông. |
| `lib/live-alerts.ts` · `live-alert-thresholds.ts` · `live-incident-catalog.ts` | Cảnh báo + danh mục khoảng 90 mã sự cố. |
| `lib/live-realtime-bus.ts` | Đẩy cập nhật về giao diện qua SSE, dùng chung một kết nối Firestore cho mỗi bản sao máy chủ. |
| `lib/live-youtube-*.ts` | Nối YouTube qua OAuth: tạo / chuyển trạng thái buổi phát, lấy khoá phát. |
| `components/domains/a7-live/` | Giao diện quản trị (React). `RiseLive.tsx` rất lớn (~250 KB) — đọc theo từng phần, đừng nạp cả tệp. |
| `scripts/rl-*.ts` | Script **chỉ đọc** để đo hiện trạng (sức chứa, rủi ro quy mô, tốc độ tải). An toàn khi chạy. |
| `docs/rise-live/` | Tài liệu thiết kế + hướng dẫn dựng VPS nhận file qua HTTPS. |

## Phần dùng chung của Rise Work (không thuộc Rise Live)

Rise Live không đọc hay biên dịch được nếu thiếu 10 tệp này, nên chúng được kèm theo:

`lib/firestore.ts` (nối Firestore) · `lib/session.ts` (đăng nhập) · `lib/access.ts`
(phân quyền) · `lib/notify.ts` (thông báo) · `lib/audit.ts` (nhật ký) ·
`lib/youtube-check.ts` · `lib/app-url.ts` · `lib/secret-store.ts` ·
`lib/channel-assignments.ts` · `components/ui-primitives.tsx`

Nếu ghép vào ứng dụng khác thì **thay chúng bằng phần tương đương của bạn** — đây là
lớp keo của Rise Work, không phải phần cốt lõi của Rise Live.

## Bảng dữ liệu (Firestore)

`liveStreams` (luồng — bảng chính) · `liveMachines` (máy) · `liveMoveExecutions` (lịch
chuyển máy) · `liveIncidentLog` (sự cố) · `liveYoutubeConnections` (nối YouTube) ·
`liveSettings` · `liveThumbs` · `liveAssets` · `liveUnitSummary` · `liveAlertSummary`

Ngoài ra dùng `users` và `channels` của Rise Work (phân quyền + gắn kênh).

## Cần gì để chạy

**Lớp điều khiển:** Next.js (app router) + một project Firebase/Firestore. Biến môi
trường xem `.env.example`. Bắt buộc tối thiểu: `RISE_WORK_LIVE=1` và
`RISE_LIVE_WORKER_TOKEN`.

**Mỗi VPS phát:** Ubuntu + systemd, có `python3` · `ffmpeg` · `yt-dlp` · `gdown`.
Giao diện có nút sinh sẵn khối lệnh cài đặt trọn gói (tự cài phần mềm, tải worker, tạo
dịch vụ tự khởi động lại) — xem `RiseLive.tsx` quanh dòng ~2696.

## Đã lược bỏ khỏi gói này

- **6 địa chỉ IP thật** của dàn VPS đang phát → thay bằng dải `203.0.113.x` (dải dành
  riêng cho tài liệu, không thuộc máy của ai).
- **Địa chỉ máy chủ Rise Work thật** → `<DIA-CHI-MAY-CHU-CUA-BAN>`.
- **Tên miền công ty** → `<TEN-MIEN-CUA-BAN>`.
- Không có mật khẩu, khoá dịch vụ, khoá OAuth, hay khoá phát YouTube nào trong gói —
  toàn bộ mã đọc chúng từ biến môi trường, không tệp nào gõ cứng.

## Lưu ý khi sửa

1. **Worker KHÔNG tự cập nhật.** Sửa `rise-live-agent.py` rồi phải kéo lại tệp và khởi
   động lại dịch vụ trên **từng** VPS, sau đó đối chiếu cột phiên bản worker trên giao
   diện. Quên một máy là máy đó chạy bản cũ mà không ai biết.
2. **Đừng bỏ cơ chế lease** nếu chạy nhiều hơn một máy — bỏ là hai máy cùng đẩy một
   luồng, YouTube sẽ chặn kênh.
3. Bộ mã sự cố (`live-incident-catalog.ts`) gắn với giao diện và tài liệu vận hành.
   Thêm hành vi cảnh báo mới thì cập nhật cả danh mục.
4. Mọi thứ đều nằm sau cờ bật/tắt (biến môi trường `RISE_LIVE_*`). Thêm tính năng nên
   giữ nếp đó để bật dần, tắt nhanh khi có sự cố.
