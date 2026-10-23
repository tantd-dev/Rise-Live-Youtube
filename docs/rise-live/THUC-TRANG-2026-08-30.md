# RISE LIVE — THỰC TRẠNG

**Chốt số liệu: 30/08/2026 · App V71.32 · Worker r2.41**

Mọi con số dưới đây là **đo thật từ dữ liệu đang chạy** tại thời điểm chốt, không lấy từ tài liệu cũ.

---

## 1. TÓM TẮT MỘT TRANG

| | |
|---|---|
| Máy phát | **6 máy** (5 đang chạy, VPS 03 đang chết) |
| Luồng | **158 luồng** — 120 đang phát, 14 chờ chạy, 24 dừng |
| Video | **277 video**, tổng khoảng **1.000 GB** nằm trên các máy |
| Băng thông đang đẩy | **975 Mbps** / trần **3.522 Mbps** của 5 máy sống = **28%** |
| Sức chứa thêm | còn khoảng **180 luồng** trước khi chạm mức an toàn 70% |
| Sức khỏe | **120/120 luồng đẩy đúng 1.0×** — không luồng nào tụt |

**Trạng thái chung: khỏe.** Không luồng nào giật, băng thông mới dùng hơn một phần tư, ổ đĩa còn rộng ở mọi máy.

---

## 2. TỪNG MÁY

| Máy | IP | Vai trò | Worker | Tình trạng | Cấu hình | Ổ trống | Trần | Đang đẩy | Tải | Luồng | Video |
|---|---|---|---|---|---|---|---|---|---|---|---|
| VPS 01 Netcup | 203.0.113.10 | Live 24/7 | r2.41 | Online | 16 nhân · 63 GB | 1.861 GB | 400 Mbps | 170 Mbps (43%) | 1,00 | 19 (19 phát) | 46 |
| VPS 02 Lowendviet | 203.0.113.11 | Live 24/7 | r2.41 | Online | 16 nhân · 126 GB | 684 GB | 750 Mbps | 328 Mbps (44%) | 2,25 | 51 (40 phát) | 73 |
| VPS 03 Lowendviet | 203.0.113.12 | Live 24/7 | r2.39 | **CHẾT** | 48 nhân · 63 GB | 1.790 GB | 750 Mbps | — | — | 4 (2 phát) | 45 |
| VPS 04 Lowendviet | 203.0.113.13 | Dùng chung | r2.41 | Online | 16 nhân · 126 GB | 662 GB | 750 Mbps | 244 Mbps (33%) | 2,12 | 52 (31 phát) | 71 |
| VPS 05 Lowendviet | 203.0.113.14 | Dùng chung | r2.41 | Online | 16 nhân · 126 GB | 805 GB | 699 Mbps | 217 Mbps (31%) | 1,54 | 31 (27 phát) | 41 |
| VPS 06 Hetzner | 203.0.113.15 | Live 24/7 | r2.41 | Online | 16 nhân · 126 GB | 938 GB | 923 Mbps | 17 Mbps (2%) | 0,19 | 1 (1 phát) | 1 |

**Đọc bảng này:**

- **VPS 01 Netcup là mắt xích yếu nhất** — trần chỉ 400 Mbps, đã dùng 43%. Máy chạm trần sớm nhất khi mở rộng.
- **VPS 06 gần như trống** — 923 Mbps, 938 GB ổ, mới 1 luồng. Chỗ tốt nhất để rải bớt luồng và đặt bản dự phòng.
- **VPS 03 đang chết** — 45 video và 4 luồng kẹt trên đó. Máy duy nhất đặt ở **Mỹ** (5 máy kia ở Đức), cũng là máy nhà cung cấp đã xác nhận lỗi ngày 29/08.
- **Tải máy đều thấp** — cao nhất 2,25 trên 16 nhân. Nút thắt là **băng thông**, không phải CPU.

---

## 3. HỆ CHẠY NHƯ THẾ NÀO

### Ba tầng

1. **Máy phát (VPS)** — mỗi máy chạy một chương trình nhỏ gọi là **worker** (`public/rise-live-agent.py`), khởi động cùng máy qua dịch vụ `rise-live`. Worker là **người quản duy nhất** mọi tiến trình phát trên máy đó.
2. **Máy chủ Rise Work (Google Cloud Run)** — giữ **danh sách luồng nào phải phát, ở máy nào, bằng video nào**. Không đụng vào video, không đẩy sóng.
3. **Kho dữ liệu (Firestore)** — nơi hai bên gặp nhau.

### Vòng lặp cơ bản

```
Mỗi 20 giây:
  Worker  →  máy chủ:  "tôi còn sống, đây là tình trạng từng luồng của tôi"
  Máy chủ →  worker:   "đây là danh sách luồng anh PHẢI phát"
  Worker  →  tự so, thiếu thì bật, thừa thì tắt
```

**Điểm mấu chốt:** sóng live đi **thẳng từ VPS lên YouTube**, không qua Rise Work. Máy chủ chết thì luồng **vẫn phát bình thường**, chỉ là không ai điều khiển được. Ngược lại, hệ báo "mất kết nối" **không có nghĩa** khán giả mất sóng.

### Đường đi của một video

```
Google Drive / máy tính  →  VPS (worker tự tải, tự nén nếu cần)  →  ffmpeg đẩy lên YouTube
```

Video **nằm trên ổ VPS**, không nằm ở Rise Work. Muốn chuyển luồng sang máy khác thì máy đó **phải có sẵn bản video** — đây là lý do có cơ chế bản dự phòng (mục 4.8).

---

## 4. CÁC CƠ CHẾ TỰ ĐỘNG

### 4.1 Bật lại tức thì khi luồng chết
Worker gắn ống đọc vào ffmpeg. ffmpeg chết là ống đóng **ngay** → worker biết trong dưới 0,2 giây và bật lại luôn. Đo thật: **52 lần phục hồi dưới 1 giây**.

### 4.2 Cầu dao chống chớp tắt
Luồng chớp tắt quá **5 lần trong 2 phút** → hệ **ngắt và chờ** rồi mới thử lại, để không quay tít vô ích khi mạng đang chết. Thời gian chờ **tăng dần**:

```
lần ngắt 1 → chờ  20 giây        lần ngắt 4 → chờ 120 giây
lần ngắt 2 → chờ  40 giây        lần ngắt 5 trở đi → chờ 300 giây, LẶP MÃI
lần ngắt 3 → chờ  60 giây
```

Chạy ổn định lại 5 phút thì bậc **về đầu**. Không bao giờ bỏ cuộc.

### 4.3 Phân biệt hai loại lỗi
- **Lỗi nguồn/file** (video hỏng, thiếu file, giải mã lỗi) → **dừng hẳn ngay lần đầu**, không tự bật lại. Bật lại chỉ phí công, cần người sửa nguồn.
- **Lỗi mạng/VPS** → tạm thời, tự thử lại theo bậc ở trên cho tới khi hết sự cố.

### 4.4 Phát hiện treo hình
ffmpeg còn sống nhưng đồng hồ ngừng nhích quá **25 giây** → giết để bật lại. Bắt được trường hợp "còn xanh mà hình đứng".

### 4.5 Phát hiện màn đen
Worker tự chụp ảnh luồng mỗi 60 giây ngay tại VPS. Đen liên tục quá 2 phút → cảnh báo.

### 4.6 Cảnh báo giật/lag
Tốc độ đẩy dưới **0,92 lần** thời gian thực kéo dài **90 giây** → báo chủ luồng.

### 4.7 Tự chuyển máy khi máy chết
Máy im quá **60 giây** → hệ **gọi thẳng vào máy để xác minh**. Không ai trả lời mới coi là chết, rồi dời **luồng ưu tiên** sang máy khác. Điều kiện: máy đích phải **đã có sẵn bản video**, còn đủ băng thông và ổ đĩa.

### 4.8 Tự tạo bản dự phòng
Hệ tự chép video sang máy thứ hai cho **luồng ưu tiên đang phát** (hoặc trong khung hẹn giờ, hoặc sắp phát trong 2 giờ). Luồng đã dừng thì không tải — cố ý, để khỏi chiếm ổ.

Đo thật: **14/14 luồng ưu tiên đang phát đều chuyển được ngay**.

### 4.9 Chống phát trùng
Worker mất liên lạc máy chủ quá 60 giây thì có thể đã bị chuyển luồng sang máy khác → **tự dừng** để không hai máy cùng đẩy vào một khoá (YouTube báo trùng luồng). Chỉ áp cho luồng bật "tự động chuyển" — hiện **13 luồng**.

---

## 5. NGƯỠNG ĐANG DÙNG

| Việc | Ngưỡng |
|---|---|
| Máy coi là mất kết nối | 60 giây không báo về |
| Máy im "nghiêm trọng" | 300 giây |
| Tự chuyển luồng khi máy chết | 60 giây |
| Băng thông — an toàn / sát mép / đầy | 70% / 85% / 95% |
| Ổ đĩa — nhắc dọn / nguy cấp | dưới 10% hoặc 20 GB / dưới 3% hoặc 15 GB |
| CPU quá tải | tải vượt 1,5 lần số nhân |
| Màn đen | 2 phút |
| Khởi động lại nhiều | 3 lần trong 15 phút |
| Tải video chậm | dưới 100 MB/phút với file trên 50 MB |

Tất cả gom một chỗ trong `lib/live-alert-thresholds.ts`, chỉnh bằng biến môi trường, **không cần sửa mã**.

---

## 6. CẢNH BÁO

**26 mã sự cố** có tên và hướng xử lý riêng (`RL-NET-*` mạng · `RL-PRC-*` tiến trình · `RL-RES-*` tài nguyên · `RL-MED-*` video…), định nghĩa ở `lib/live-incident-catalog.ts`.

Ba mức: **CẢNH BÁO** (biết để theo dõi) · **NGHIÊM TRỌNG** (phải xử) · **KHẨN** (đang mất sóng). Gửi vào chuông trong app và email người phụ trách.

---

## 7. NHẬT KÝ SỰ CỐ — 497 BẢN GHI (14/08 → 30/08)

| Mức độ | Số lần | Nghĩa là gì |
|---|---|---|
| Dưới 1 giây | 52 | Chớp một cái, khán giả gần như không thấy |
| 2–5 giây | 356 | YouTube rớt kết nối, ffmpeg nối lại ngay |
| 6–60 giây | 5 | Hiếm |
| 1–5 phút | 84 | **Gần như toàn bộ dồn vào 29/08** — 3 máy Lowendviet mất đường ra internet |

Nhóm 84 lần "1–5 phút" có nguyên nhân đã xác định (nhà cung cấp VPS xác nhận lỗi). Bậc thử lại mới ở mục 4.2 chính là để lần sau không mất 5 phút cho một sự cố mạng 30 giây.

---

## 8. CẤU HÌNH ĐANG BẬT

| Cờ | Nghĩa |
|---|---|
| `RISE_WORK_LIVE` | Bật màn Rise Live |
| `RISE_LIVE_PERMS2` | Phân quyền theo người |
| `RISE_LIVE_L3` | Nối YouTube (tự phát hiện kênh bị chặn/đình chỉ) |
| `RISE_LIVE_MOVE` | Cho chuyển luồng giữa các máy |
| `RISE_LIVE_LEASE` | Chống phát trùng |
| `RISE_LIVE_AUTOFAILOVER` | Tự chuyển máy khi sự cố |
| `RISE_LIVE_FAILOVER_OFFLINE_SEC=60` | Ngưỡng coi máy là chết |
| `RISE_LIVE_WRITE_ON_CHANGE`, `RISE_LIVE_READ_CONSOLIDATE` | Cắt chi phí Firestore |
| `RISE_LIVE_REALTIME` | Lớp đẩy dữ liệu trực tiếp lên màn hình |

Công tắc tắt khẩn: `RISE_LIVE_FAILOVER_OFF=1` tắt toàn bộ tự chuyển máy ngay, không cần dựng lại.

---

## 9. ĐIỂM YẾU HIỆN TẠI

1. **VPS 03 đang chết** — 45 video và 4 luồng kẹt, trong đó có luồng hẹn giờ sẽ không lên sóng được. Máy đặt ở Mỹ, hỏng 2 lần trong 2 ngày.
2. **VPS 01 Netcup trần thấp** — 400 Mbps, đã 43%. Chạm trần sớm nhất khi mở rộng.
3. **Luồng dồn không đều** — VPS 02 giữ 40 luồng đang phát trong khi VPS 06 chỉ có 1.
4. **Chỉ 13/158 luồng bật "tự động chuyển"** — số còn lại máy chết là mất sóng cho tới khi có người xử tay.
5. **Kéo worker có chớp sóng** — từ r2.41 (Chủ Rise Group chọn, đổi lấy số liệu và cảnh báo). Nên chọn giờ vắng, làm lần lượt từng máy.

---

## 10. SỨC CHỨA — CÒN MỞ RỘNG ĐƯỢC BAO NHIÊU

```
Trần băng thông 5 máy đang sống      3.522 Mbps
Mức an toàn 70%                      2.465 Mbps
Đang dùng                              975 Mbps  (28%)
Còn trống tới mức an toàn            1.490 Mbps

Trung bình mỗi luồng                   8,1 Mbps
=> Còn nhận thêm khoảng               ~180 luồng
=> Tổng sức chứa an toàn              ~300 luồng
```

VPS 03 sống lại thì thêm khoảng **64 luồng** nữa, tức **~365 luồng**. Muốn tới mốc **500** cần thêm khoảng **2 máy** cỡ 750–900 Mbps.

---

## 11. VẬN HÀNH — 3 VIỆC HAY LÀM NHẤT

**Thêm máy mới.** Live Rise → Máy live → *Thêm máy* (tên, IP, **trần băng thông thật của nhà cung cấp**) → bấm *Cài đặt* ở dòng máy đó → dán khối lệnh vào SSH máy mới. Khối lệnh tự tải worker, tự tạo dịch vụ, tự cài công cụ tải video. Máy hiện Online sau khoảng 10 giây.

**Cập nhật worker.** Worker **không tự cập nhật**. Phải kéo lại script rồi khởi động lại dịch vụ `rise-live` trên **từng máy**. Từ r2.41 việc này làm luồng **chớp khoảng 1 giây** → chọn giờ vắng, làm lần lượt.

**Kiểm nhanh sức khỏe.** Live Rise → *Máy live*: cột phiên bản phải giống nhau ở mọi máy · băng thông không máy nào quá 70% · ổ trống không máy nào dưới 20 GB.

---

## 12. BẢN ĐỒ MÃ NGUỒN

| Việc | Ở đâu |
|---|---|
| Chương trình chạy trên VPS | `public/rise-live-agent.py` |
| Giao diện | `components/domains/a7-live/` |
| Nhận tin từ máy phát | `app/api/live/agent/route.ts` |
| Cảnh báo | `lib/live-alerts.ts` · `app/api/live/alerts/run/route.ts` |
| Tự chuyển máy + bản dự phòng | `app/api/live/failover/run/route.ts` · `lib/live-move.ts` |
| Ngưỡng | `lib/live-alert-thresholds.ts` |
| Mã sự cố | `lib/live-incident-catalog.ts` |
| Chống phát trùng | `lib/live-lease.ts` |
| Tính sức chứa | `lib/live-capacity.ts` |
| Khoá video dự phòng | `lib/live-asset-lock.ts` |

---

## 13. NGUỒN SỐ LIỆU

Đo bằng script chỉ-đọc trên dữ liệu thật ngày 30/08/2026, cộng cấu hình đọc trực tiếp từ Cloud Run. Không con số nào lấy từ tài liệu cũ hay ước lượng.

*Tài liệu này không chứa khoá, mật khẩu hay token nào.*
