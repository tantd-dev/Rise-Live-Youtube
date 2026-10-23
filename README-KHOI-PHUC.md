# Rise Live — bản khôi phục để chạy thử

Gói gốc (RISE-LIVE-GOI-CHIA-SE.zip) chỉ chứa phần Rise Live, thiếu khung ứng dụng. Bản này **giữ nguyên toàn bộ code gốc** và bổ sung các tệp thiếu để chạy được trên máy cá nhân với Firestore giả lập (không cần Firebase thật).

## Đã khôi phục gì

| Tệp thêm | Vai trò |
|---|---|
| `package.json`, `tsconfig.json`, `next.config.mjs`, `.gitignore` | Cấu hình dự án Next.js 15 + React 19 + firebase-admin. Code gốc dùng `await cookies()` nên suy ra là Next 15 |
| `app/layout.tsx`, `app/page.tsx`, `app/live-client.tsx` | Khung trang gốc, mount `<RiseLive>` (cần thêm hàm `flash` nên bọc bằng client component) |
| `app/api/dev/login`, `app/api/dev/logout` | Đăng nhập thử: tạo user admin + phiên trong Firestore. **Tự khoá nếu không phải Firestore giả lập** |
| `components/shared/HopNhapChu.tsx` | Hộp nhập chữ, suy ra từ cách `RiseLive.tsx` gọi (đây là module nội bộ duy nhất bị thiếu) |
| `app/globals.css` | Biến màu và các class chung (card, pill, rowbtn, form, pager…). Các class `rl-*` đã có sẵn trong RiseLive.tsx |
| `firebase.json`, `.env.local.example` | Firestore emulator + biến môi trường |
| `scripts/chay-worker-thu.sh` | Chạy worker trên Ubuntu/WSL2 |

Các tệp dùng chung trong gói (`lib/firestore.ts`, `session.ts`, `access.ts`, `audit.ts`, `notify.ts`…) **không sửa**.

## Đã kiểm tra / chưa kiểm tra

- Đã kiểm: 135 câu `import … from "@/…"` đều trỏ tới tệp và export có thật.
- **Chưa chạy `npm install`, `next build`, `tsc`**, vì môi trường soạn không có mạng. Có thể còn lỗi vặt khi chạy lần đầu. `next.config.mjs` đang bỏ qua lỗi kiểu khi build; chạy `npm run typecheck` để xem lỗi thật.
- `HopNhapChu` và `globals.css` là suy luận từ cách code gọi, giao diện có thể khác bản gốc về thẩm mỹ.

## Yêu cầu

Node 20+, Java 11+ (cho Firestore emulator), Ubuntu hoặc WSL2 (cho worker), `python3`, `ffmpeg`, `yt-dlp`, `gdown`.
**Nếu PC là Windows: chạy cả 3 thứ (Node, emulator, worker) trong cùng một WSL2 Ubuntu** để `localhost` trỏ về cùng một chỗ.

## Chạy

```bash
npm install
cp .env.local.example .env.local      # sửa RISE_LIVE_WORKER_TOKEN thành chuỗi ngẫu nhiên dài

# Terminal 1
npm run emulator                      # Firestore giả lập, cổng 8080

# Terminal 2
npm run dev                           # http://localhost:3000 → bấm "Đăng nhập thử"
```

Trong giao diện:
1. Tab **Máy live** → Thêm máy (IP nhập 127.0.0.1, trần băng thông đặt theo upload thật của mạng) → ghi lại **mã máy**.
2. Terminal 3 (Ubuntu/WSL):
   ```bash
   RISE_LIVE_MACHINE=<mã máy> RISE_LIVE_TOKEN="giá trị RISE_LIVE_WORKER_TOKEN" npm run worker
   ```
   Máy chuyển sang **Online** sau vài giây là worker đã nối được.
3. Tab **Kho video** → thêm video thử (dùng link Google Drive cho bản thử; tải thẳng từ trình duyệt lên VPS có thể đòi HTTPS qua Caddy, chưa kiểm). Chờ trạng thái sẵn sàng.
4. Tab **Luồng phát** → tạo luồng: chọn video, chọn máy, dán **stream key** của kênh YouTube thử → Bật.
5. Mở YouTube Studio → Phát trực tiếp để xem luồng lên sóng.

## Lưu ý an toàn

- Dùng **kênh YouTube thử**, không dùng kênh thật. Kênh phải bật tính năng live (lần đầu có thể chờ ~24 giờ).
- Worker chạy bằng user thường (không `sudo`): dữ liệu (`assets/`, `raw/`, `logs/`…) nằm ở thư mục gốc repo.
- Mạng công ty có thể chặn RTMP (cổng 1935). Cần báo IT trước khi test.
- Mỗi lần test xong nhớ **dừng worker** để không đẩy luồng ngoài ý muốn.

## Chưa được dựng (không cần cho lần chạy thử đầu)

Nối YouTube qua OAuth + Secret Manager (cần Google Cloud thật), gửi email cảnh báo (Resend), cron tự cứu / cảnh báo (Cloud Scheduler, gọi tay được bằng header `x-cron-secret`), kênh realtime SSE (sau cờ `RISE_LIVE_REALTIME`).

## Nếu gặp lỗi

| Hiện tượng | Hướng xử lý |
|---|---|
| Trang báo "Không kết nối được Firestore" | Chưa chạy `npm run emulator`, hoặc thiếu `FIRESTORE_EMULATOR_HOST` trong `.env.local` |
| `/api/live` trả 404 | Thiếu `RISE_WORK_LIVE=1` |
| Worker báo 401/403 | `RISE_LIVE_TOKEN` khác `RISE_LIVE_WORKER_TOKEN`, hoặc sai mã máy |
| Máy mãi không Online | Worker chạy ngoài WSL nên `localhost` không tới Node; chạy chung trong WSL |
| Lỗi thiếu module khi `npm run dev` | Gửi nguyên văn lỗi để bổ sung tệp |
