#!/usr/bin/env bash
# Chạy worker Rise Live thử trên Ubuntu / WSL2 (worker chỉ chạy được trên Linux).
# Cách dùng:
#   1) Trong giao diện Rise Live → tab "Máy live" → Thêm máy → ghi lại MÃ MÁY.
#   2) RISE_LIVE_MACHINE=<mã máy> RISE_LIVE_TOKEN=<giá trị RISE_LIVE_WORKER_TOKEN> bash scripts/chay-worker-thu.sh
# Worker dùng thư mục cứng /root/rise-live nên cần sudo.
set -euo pipefail
: "${RISE_LIVE_MACHINE:?Thiếu RISE_LIVE_MACHINE (mã máy tạo trong giao diện)}"
: "${RISE_LIVE_TOKEN:?Thiếu RISE_LIVE_TOKEN (chuỗi giống RISE_LIVE_WORKER_TOKEN trong .env.local)}"
export RISE_LIVE_URL="${RISE_LIVE_URL:-http://localhost:3000}"

for c in python3 ffmpeg ffprobe; do
  command -v "$c" >/dev/null || { echo "Thiếu '$c'. Cài: sudo apt update && sudo apt install -y python3 python3-pip ffmpeg"; exit 1; }
done
HERE="$(cd "$(dirname "$0")/.." && pwd)"
command -v yt-dlp >/dev/null || echo "Cảnh báo: chưa có yt-dlp (cần khi tải video từ Google Drive): pip3 install -U -r $HERE/public/requirements.txt"

echo "Worker → $RISE_LIVE_URL  (máy: $RISE_LIVE_MACHINE)"
exec sudo -E python3 "$HERE/public/rise-live-agent.py"
