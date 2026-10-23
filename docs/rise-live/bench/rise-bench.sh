#!/usr/bin/env bash
# ============================================================================
# Rise Live — Benchmark #1  (chạy trên 1 VPS test, Ubuntu/Debian)
# Mục tiêu: đo NĂNG LỰC THẬT của 1 VPS trước khi mua số lượng lớn.
#
# CÁCH DÙNG:
#   1) Đo máy (nhanh, KHÔNG cần YouTube):
#        sudo bash rise-bench.sh probe
#   2) Đo phát RTMP thật tới YouTube (tăng dần số luồng):
#        sudo bash rise-bench.sh rtmp keys.txt 120 [/duong-dan/video_ready.mp4]
#      - keys.txt: mỗi dòng 1 STREAM KEY của 1 buổi live YouTube test
#                  (hoặc dán nguyên URL rtmp://a.rtmp.youtube.com/live2/KEY).
#      - 120: số giây chạy mỗi mức (mặc định 90).
#      - video_ready.mp4 (tùy chọn): nếu có → test COPY-CODEC (đúng cách Rise Live chạy).
#                  nếu không → tự tạo luồng test 1080p 5Mbps (nặng CPU hơn thực tế).
#
# KHÔNG sửa file này cũng chạy được. Mọi kết quả in ra tiếng Việt.
# ============================================================================
set -uo pipefail
MODE="${1:-probe}"
YT_BASE="rtmp://a.rtmp.youtube.com/live2"
say(){ printf "\n\033[1;36m%s\033[0m\n" "$*"; }
ok(){ printf "  \033[1;32m✔\033[0m %s\n" "$*"; }
warn(){ printf "  \033[1;33m!\033[0m %s\n" "$*"; }

need(){ # need <lệnh> <gói-apt>
  command -v "$1" >/dev/null 2>&1 && return 0
  warn "Thiếu '$1' — đang cài ($2)…"
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq "$2" >/dev/null 2>&1; fi
  command -v "$1" >/dev/null 2>&1
}

IFACE="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'dev \K\S+' | head -1)"
[ -z "${IFACE:-}" ] && IFACE="$(ls /sys/class/net | grep -v lo | head -1)"

egress_mbps(){ # đo Mbps GỬI ĐI trung bình trong <giây>
  local sec="${1:-5}" f="/sys/class/net/$IFACE/statistics/tx_bytes" a b
  a=$(cat "$f" 2>/dev/null || echo 0); sleep "$sec"; b=$(cat "$f" 2>/dev/null || echo 0)
  awk -v a="$a" -v b="$b" -v s="$sec" 'BEGIN{printf "%.1f",(b-a)*8/1000000/s}'
}

# ---------------------------------------------------------------------------
probe(){
  say "RISE LIVE — ĐO MÁY (probe)   ·   card mạng: ${IFACE:-?}"
  say "1) CPU & RAM"
  ok "CPU: $(nproc) nhân — $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ //')"
  ok "RAM: $(free -h | awk '/Mem:/{print $2" (còn trống "$7")"}')"
  ok "Ổ đĩa: $(df -h / | awk 'NR==2{print $2" (còn "$4", đã dùng "$5")"}')"

  say "2) Tốc độ đọc ổ đĩa (quan trọng: nhiều luồng cùng đọc file lớn)"
  if need fio fio; then
    fio --name=readtest --filename=/tmp/rise_fio.tmp --size=1G --rw=randread --bs=1M \
        --numjobs=4 --iodepth=8 --runtime=15 --time_based --direct=1 --group_reporting 2>/dev/null \
      | grep -E 'READ:' | sed 's/^/  /' || warn "fio chạy lỗi"
    rm -f /tmp/rise_fio.tmp
  else
    warn "Không cài được fio — đo thô bằng dd"; dd if=/dev/zero of=/tmp/rise_dd.tmp bs=1M count=1024 oflag=direct 2>&1 | tail -1 | sed 's/^/  /'; rm -f /tmp/rise_dd.tmp
  fi

  say "3) Băng thông tải LÊN (cơ sở — chưa phải tới YouTube)"
  if need speedtest-cli speedtest-cli; then
    local up; up=$(speedtest-cli --simple 2>/dev/null | awk '/Upload/{print $2}')
    if [ -n "${up:-}" ]; then
      ok "Upload cơ sở: ${up} Mbps"
      awk -v u="$up" 'BEGIN{s=u*0.75; printf "  → 75%% an toàn = %.0f Mbps → ~%d luồng 5Mbps (CHỈ theo băng thông; CPU/IO có thể chặn trước)\n", s, s/5}'
    else warn "speedtest không trả kết quả — thử lại hoặc đo bằng iperf3 tới máy Rise."
    fi
  fi
  say "XONG probe. Con số quyết định thật nằm ở bước 'rtmp' (phát tới YouTube)."
}

# ---------------------------------------------------------------------------
rtmp(){
  local keyfile="${2:-}" secs="${3:-90}" file="${4:-}"
  [ -z "$keyfile" ] || [ ! -f "$keyfile" ] && { echo "Thiếu file keys. Ví dụ: sudo bash rise-bench.sh rtmp keys.txt 120"; exit 1; }
  need ffmpeg ffmpeg || { echo "Cần ffmpeg."; exit 1; }
  mapfile -t KEYS < <(grep -vE '^\s*$' "$keyfile")
  local total="${#KEYS[@]}"
  [ "$total" -lt 1 ] && { echo "keys.txt rỗng."; exit 1; }

  say "RISE LIVE — ĐO PHÁT RTMP TỚI YOUTUBE   ·   ${total} key · mỗi mức ${secs}s · card ${IFACE:-?}"
  if [ -n "$file" ] && [ -f "$file" ]; then ok "Chế độ COPY-CODEC từ: $file (đúng cách Rise Live chạy)"; MODEFF="copy";
  else warn "Không có file → tạo luồng test 1080p 5Mbps (encode, NẶNG CPU hơn thực tế)"; MODEFF="gen"; fi

  url_of(){ case "$1" in rtmp://*) echo "$1";; *) echo "$YT_BASE/$1";; esac; }
  launch(){ # launch <url>
    if [ "$MODEFF" = "copy" ]; then
      ffmpeg -hide_banner -loglevel error -stream_loop -1 -re -i "$file" -c copy -f flv "$1" >/dev/null 2>&1 &
    else
      ffmpeg -hide_banner -loglevel error -re -f lavfi -i "testsrc2=size=1920x1080:rate=30" -f lavfi -i "sine=frequency=440" \
        -c:v libx264 -preset veryfast -b:v 5000k -maxrate 5000k -bufsize 10000k -g 60 -pix_fmt yuv420p \
        -c:a aac -b:a 128k -f flv "$1" >/dev/null 2>&1 &
    fi
    echo $!
  }

  printf "\n  %-8s %-8s %-14s %-12s %s\n" "SỐ LUỒNG" "SỐNG" "EGRESS(Mbps)" "TẢI CPU" "GHI CHÚ"
  local best=0
  for ((n=1; n<=total; n++)); do
    local pids=()
    for ((i=0; i<n; i++)); do pids+=("$(launch "$(url_of "${KEYS[$i]}")")"); done
    sleep 8                       # cho luồng ổn định
    local eg; eg=$(egress_mbps 6) # đo egress trong lúc chạy
    sleep $((secs>14?secs-14:2))
    local alive=0; for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=$((alive+1)); done
    local load; load=$(awk '{print $1}' /proc/loadavg)
    local note="ok"; [ "$alive" -lt "$n" ] && note="⚠ có luồng RỚT ($((n-alive)) chết)"
    [ "$alive" -eq "$n" ] && best="$n"
    printf "  %-8s %-8s %-14s %-12s %s\n" "$n" "$alive/$n" "$eg" "$load" "$note"
    for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
    wait 2>/dev/null
    [ "$alive" -lt "$n" ] && { warn "Bắt đầu rớt ở mức $n → dừng ramp."; break; }
    sleep 3
  done
  say "KẾT QUẢ: máy này giữ ỔN ĐỊNH tối đa ~${best} luồng (mức cao nhất mọi luồng còn sống)."
  echo "  → Nhân số này với vùng an toàn 75% + trừ dự phòng khi quy hoạch cả cụm. Gửi bảng trên cho tôi để tính số VPS cho 200/500 luồng."
}

case "$MODE" in
  probe) probe ;;
  rtmp)  rtmp "$@" ;;
  *) echo "Dùng: sudo bash rise-bench.sh probe   |   sudo bash rise-bench.sh rtmp keys.txt [giây] [file_ready.mp4]" ;;
esac
