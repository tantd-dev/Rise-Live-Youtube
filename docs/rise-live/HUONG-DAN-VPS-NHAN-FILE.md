# Hướng dẫn: cho một VPS nhận "tải thẳng video từ máy tính"

> Mục tiêu: để màn **Rise Live → Tải video lên** có thể **chọn VPS này** làm nơi nhận file
> (kéo-thả video từ máy tính lên thẳng VPS đó), không còn cứng vào một máy (Netcup).
>
> Áp dụng khi dựng thêm VPS mới (VPS #3, #4…). Phần app đã xong từ **V61.42** — việc còn lại
> là cấu hình **hạ tầng trên VPS**. Làm 1 lần cho mỗi VPS.

---

## 0. Bức tranh tổng thể (hiểu trước khi làm)

```
Trình duyệt (máy bạn)  --HTTPS-->  live2.<TEN-MIEN-CUA-BAN>  (Caddy trên VPS lo chứng chỉ)
                                        |
                                        v  chuyển tiếp nội bộ
                                   127.0.0.1:8099  (worker rise-live-agent đã tự mở sẵn)
                                        |
                                        v
                                   File lưu vào kho video của VPS này
```

- Worker (`rise-live-agent.py`) **đã tự mở cổng nhận file `8099`** (HTTP thường) nếu có token upload.
- Trình duyệt bắt buộc gọi **HTTPS** → nên cần **Caddy** đứng trước, nhận HTTPS rồi đẩy vào `8099`.
- **Caddy tự xin + tự gia hạn chứng chỉ** (Let's Encrypt) → không phải làm tay.

**Điều kiện cần:**
- VPS chạy **Ubuntu/Linux**, worker Rise Live **đang chạy** (systemd `rise-live`).
- Tên miền `<TEN-MIEN-CUA-BAN>` đang quản trên **Cloudflare** (để thêm bản ghi tên miền con).
- Biết **`RISE_LIVE_UPLOAD_TOKEN`** đang dùng (phải **giống** máy Netcup — token dùng chung).

---

## 1. Trỏ tên miền con vào VPS (Cloudflare) — ⚠️ ĐIỂM QUAN TRỌNG NHẤT

Vào Cloudflare → `<TEN-MIEN-CUA-BAN>` → **DNS** → **Add record**:

| Type | Name | Content (IPv4) | Proxy status |
|------|------|----------------|--------------|
| A | `live2` | `<IP của VPS mới>` | **DNS only (đám mây XÁM)** |

> **BẮT BUỘC để "DNS only" (đám mây XÁM), KHÔNG bật proxy (đám mây CAM).**
> - Đám mây **cam** (proxied): Cloudflare bản Free chặn body **> 100 MB** → video lớn **lỗi 413**, tải hỏng.
> - Đám mây **xám** (DNS only): file đi **thẳng vào VPS**, không dính giới hạn → tải video lớn thoải mái.
>
> 💡 Mẹo: mở xem bản ghi `live` (Netcup) đang xám hay cam rồi làm **y hệt** cho `live2`
> (nhiều khả năng đang xám vì đang tải video lớn được).

Đợi 1–2 phút cho DNS lan. Kiểm tra: `ping live2.<TEN-MIEN-CUA-BAN>` phải ra **đúng IP VPS mới**.

---

## 2. Mở tường lửa cho Caddy (cổng 80 + 443)

Caddy cần **cổng 80** (để xin chứng chỉ) và **443** (để phục vụ HTTPS). Trên VPS:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

**Nên chặn cổng 8099 khỏi Internet** (chỉ cho Caddy nội bộ gọi) cho an toàn — token đã bảo vệ,
nhưng chặn thêm càng chắc:

```bash
sudo ufw deny 8099/tcp
```

(Caddy gọi `127.0.0.1:8099` nội bộ nên không bị ảnh hưởng.)

---

## 3. Đảm bảo worker có token upload

Worker chỉ mở cổng nhận file khi có biến `RISE_LIVE_UPLOAD_TOKEN`. Kiểm tra dịch vụ:

```bash
sudo systemctl show rise-live -p Environment | tr ' ' '\n' | grep -i upload
```

- Nếu **chưa có** `RISE_LIVE_UPLOAD_TOKEN` → thêm vào file dịch vụ (hoặc file env của agent),
  **dùng đúng chuỗi token giống máy Netcup**, rồi:

```bash
sudo systemctl restart rise-live
```

- (Tuỳ chọn) đổi cổng bằng `RISE_LIVE_UPLOAD_PORT` — mặc định `8099`. Giữ mặc định cho gọn.

Kiểm tra worker đã nghe cổng 8099 chưa:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8099/upload
# Ra 401/400 là ĐÚNG (server sống, chỉ thiếu token) — KHÔNG phải "connection refused".
```

---

## 4. Cài Caddy + cấu hình HTTPS

Cài Caddy (Ubuntu):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Sửa cấu hình `/etc/caddy/Caddyfile` — **thay bằng đúng tên miền con của bạn**:

```
live2.<TEN-MIEN-CUA-BAN> {
    reverse_proxy 127.0.0.1:8099
}
```

> Caddy **không giới hạn dung lượng body** mặc định → tải video lớn thoải mái (khác nginx).

Nạp lại Caddy:

```bash
sudo systemctl reload caddy
# hoặc: sudo systemctl restart caddy
```

Xem log để chắc đã xin được chứng chỉ:

```bash
sudo journalctl -u caddy --no-pager | tail -30
# Tìm dòng "certificate obtained successfully" cho live2.<TEN-MIEN-CUA-BAN>
```

---

## 5. Kiểm tra HTTPS hoạt động

Từ máy bạn (hoặc VPS):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://live2.<TEN-MIEN-CUA-BAN>/upload
# Ra 401/400 = ĐÚNG (HTTPS ok, tới được worker, chỉ thiếu token).
```

Nếu ra **000 / timeout** → xem lại DNS (mục 1) hoặc tường lửa (mục 2).
Nếu ra **cert lỗi** → cổng 80 chưa mở, hoặc DNS đang đám mây **cam** (đổi về xám).

---

## 6. Gắn vào Rise Work

1. Vào **Rise Live → tab "🖥 Máy live"**.
2. Tìm dòng VPS này → ô **"📤 tải-thẳng"** → bấm → dán **`https://live2.<TEN-MIEN-CUA-BAN>`** → **OK**.
   - (Máy mới thêm: điền sẵn ô "Địa chỉ nhận file HTTPS" ngay lúc **Thêm máy**.)
3. Mở **tab "Kho video" → "Tải video lên"** → giờ có ô **"Tải lên máy (VPS)"** → chọn máy này.
4. Kéo-thả 1 video **nhỏ** để thử → thấy "✅ Đã tải xong" là chạy.

---

## 7. Sự cố thường gặp

| Hiện tượng | Nguyên nhân | Cách xử |
|---|---|---|
| Tải video **lớn** báo lỗi **413** | DNS đang đám mây **CAM** (Cloudflare chặn >100MB) | Đổi bản ghi `live2` về **DNS only (xám)** |
| Trình duyệt báo **cert/không an toàn** | Chưa xin được chứng chỉ (cổng 80 chưa mở / DNS chưa trỏ đúng) | Mở cổng 80, chờ DNS, xem log Caddy |
| Tải báo **401 / Unauthorized** | Token trên VPS **khác** token chung | Đặt `RISE_LIVE_UPLOAD_TOKEN` **giống** Netcup, restart worker |
| `curl 127.0.0.1:8099` báo **connection refused** | Worker chưa chạy / thiếu token nên không mở cổng | Kiểm tra `systemctl status rise-live` + biến token |
| Ô "Tải lên máy (VPS)" **không hiện** | Chưa gắn địa chỉ cho máy nào (chỉ có 1 đích) | Gắn "📤 tải-thẳng" cho ≥1 máy (mục 6) |

---

## 8. Ghi chú an toàn

- Cổng `8099` chỉ nên gọi **nội bộ** (Caddy → `127.0.0.1`). Chặn `8099` khỏi Internet (mục 2).
- Token upload **chỉ cho phép TẢI FILE**, không truy cập API worker → lộ token thì cũng chỉ tải
  được file lên, không điều khiển được luồng. Dù vậy **giữ kín token**, đừng để lộ.
- Mỗi VPS một tên miền con riêng (`live2`, `live3`…), tất cả để **DNS only (xám)**.

---

**Tóm tắt 1 dòng:** trỏ `live3.<TEN-MIEN-CUA-BAN>` (Cloudflare **xám**) → cài Caddy `reverse_proxy 127.0.0.1:8099`
→ dán địa chỉ vào "📤 tải-thẳng" của máy trong Rise Work → xong.
