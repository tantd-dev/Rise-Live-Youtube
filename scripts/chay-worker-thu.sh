#!/usr/bin/env bash
# Chạy worker Rise Live thử trên Ubuntu / WSL2 (worker chỉ chạy được trên Linux).
# Cách dùng:
#   1) Trong giao diện Rise Live → tab "Máy live" → Thêm máy → ghi MÃ MÁY vào .env.local (RISE_LIVE_MACHINE=...).
#   2) npm run worker
# Script tự nạp .env.local: RISE_LIVE_MACHINE, RISE_LIVE_TOKEN (thiếu thì lấy RISE_LIVE_WORKER_TOKEN), RISE_LIVE_URL.
# Biến đặt sẵn trên dòng lệnh được ưu tiên hơn .env.local, vd: RISE_LIVE_MACHINE=<mã khác> npm run worker
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

# Nạp .env.local — chỉ đặt biến CHƯA có trong môi trường; bỏ dòng trống/chú thích, dấu nháy và \r (file sửa từ Windows).
if [ -f "$HERE/.env.local" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
    [ -z "${!key+x}" ] && export "$key=$val"
  done < "$HERE/.env.local"
fi
export RISE_LIVE_TOKEN="${RISE_LIVE_TOKEN:-${RISE_LIVE_WORKER_TOKEN:-}}"

: "${RISE_LIVE_MACHINE:?Thiếu RISE_LIVE_MACHINE (mã máy tạo trong giao diện — điền vào .env.local)}"
: "${RISE_LIVE_TOKEN:?Thiếu RISE_LIVE_TOKEN (hoặc RISE_LIVE_WORKER_TOKEN trong .env.local)}"
export RISE_LIVE_URL="${RISE_LIVE_URL:-http://localhost:3000}"
RISE_LIVE_URL="${RISE_LIVE_URL%/}"
# Worker tự nối "/api/live/agent" vào sau -> URL chỉ được là gốc máy chủ (vd http://localhost:3000).
case "$RISE_LIVE_URL" in
  *://*/*) echo "RISE_LIVE_URL='$RISE_LIVE_URL' có đường dẫn phía sau — chỉ để gốc máy chủ, vd http://localhost:3000 (sửa trong .env.local)."; exit 1;;
esac

for c in python3 ffmpeg ffprobe; do
  command -v "$c" >/dev/null || { echo "Thiếu '$c'. Cài: sudo apt update && sudo apt install -y python3 python3-pip ffmpeg"; exit 1; }
done
command -v yt-dlp >/dev/null || echo "Cảnh báo: chưa có yt-dlp (cần khi tải video từ Google Drive): pip3 install -U -r $HERE/public/requirements.txt"

echo "Worker → $RISE_LIVE_URL  (máy: $RISE_LIVE_MACHINE)"
exec sudo -E python3 "$HERE/public/rise-live-agent.py"
