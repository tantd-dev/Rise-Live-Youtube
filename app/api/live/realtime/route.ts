// RISE LIVE — GIAI ĐOẠN 2, BƯỚC 1 (THỬ NGHIỆM): ĐƯỜNG ĐẨY DỮ LIỆU VỀ MÀN HÌNH (SSE).
//
// Đây là bước THỬ, chưa thay cách cũ: màn hình Live hiện tại vẫn hỏi mỗi 20 giây y như trước.
// Route này chỉ để CHỨNG MINH cơ chế chạy được trên Cloud Run nhiều bản sao, và ĐO xem
// tiết kiệm thật bao nhiêu — trước khi nối vào màn hình thật (D-RL-03).
//
// AN TOÀN:
//  - Sau cờ RISE_LIVE_REALTIME (mặc định TẮT → route trả 404 như không tồn tại).
//  - CHỈ Admin/BLĐ hoặc người có quyền vận hành Live. Chặn xem-thử (viewingAs).
//  - Lọc theo PHẠM VI XEM sẵn có (getVisibleUserEmails) — không ai thấy luồng ngoài phạm vi.
//  - CHỈ gửi mã bản ghi + loại thay đổi + trạng thái thô. TUYỆT ĐỐI không gửi khoá luồng.
//  - Không ghi gì. Không đụng route/màn hình đang chạy.
//
// HẠN GIỜ CLOUD RUN: dịch vụ đang đặt timeoutSeconds=60 nên mỗi kết nối tự đóng ở giây thứ 50
// rồi màn hình nối lại. Muốn kết nối sống lâu (đỡ nối lại) thì nâng hạn giờ dịch vụ — xem ghi chú
// trong THAY-DOI-PHIEN-BAN. Việc nối lại KHÔNG tốn thêm lượt đọc vì tai nghe được giữ qua ân hạn.

import { NextResponse } from "next/server";
import { requireSession, isUnauthorized } from "@/lib/session";
import { getVisibleUserEmails } from "@/lib/access";
import { REALTIME_ON, CONN_MAX_SEC, subscribe, busStats, type LiveChange } from "@/lib/live-realtime-bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PING_MS = 15000;

function canProbe(user: any): boolean {
  const perms = Array.isArray(user?.permissions) ? user.permissions : [];
  return user?.role === "admin" || perms.includes("admin") || perms.includes("riseLive");
}

export async function GET(req: Request) {
  try {
    if (!REALTIME_ON()) return NextResponse.json({ error: "Không khả dụng." }, { status: 404 });
    const user = await requireSession();
    if (user.viewingAs) return NextResponse.json({ error: "Chế độ xem thử không dùng được kênh trực tiếp." }, { status: 403 });
    if (!canProbe(user)) return NextResponse.json({ error: "Bạn không có quyền vào Live Rise." }, { status: 403 });

    // Phạm vi xem — tính MỘT LẦN lúc mở kết nối (không đọc lại mỗi thay đổi).
    const visible = await getVisibleUserEmails(user);
    const vis = visible ? new Set(Array.from(visible).map((e) => String(e).toLowerCase())) : null;
    const inScope = (c: LiveChange) => {
      if (c.col === "liveMachines") return true;                       // máy dùng chung, ai vào Live cũng xem được
      if (!vis) return true;                                            // Admin/BLĐ: toàn công ty
      if (c.by && vis.has(c.by)) return true;
      return c.col === "liveAssets" && c.by === "system";               // video dự phòng hệ thống tự tạo: hiện với mọi người
    };

    const enc = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        let closed = false;
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try { ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
          catch { closed = true; }
        };
        const shutdown = (reason: string) => {
          if (closed) return;
          send("bye", { reason, at: new Date().toISOString() });
          closed = true;
          if (unsubscribe) { unsubscribe(); unsubscribe = null; }
          if (ping) { clearInterval(ping); ping = null; }
          if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
          try { ctrl.close(); } catch { /* đã đóng */ }
        };

        // Đăng ký nghe TRƯỚC rồi mới chào — nếu chào trước thì số "người đang nghe" đếm THIẾU
        // chính người vừa vào (báo 0 trong khi họ đang nghe). Lỗi này đã lộ ra khi đo thật 29/08.
        unsubscribe = subscribe((c) => {
          if (!inScope(c)) return;
          send("change", { col: c.col, id: c.id, kind: c.kind, status: c.status, at: c.at });
        });

        // Chào: cho màn hình biết đang nối vào BẢN SAO NÀO — đây chính là thứ cần chứng minh.
        send("hello", { ...busStats(), connMaxSec: CONN_MAX_SEC, scope: vis ? "phạm vi của tôi" : "toàn công ty", at: new Date().toISOString() });

        ping = setInterval(() => send("ping", busStats()), PING_MS);
        stopTimer = setTimeout(() => shutdown("hết hạn kết nối — hãy nối lại"), CONN_MAX_SEC * 1000);

        // Người xem đóng tab / mất mạng → dọn ngay, không để tai nghe treo.
        req.signal.addEventListener("abort", () => shutdown("người xem ngắt"));
      },
      cancel() {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        if (ping) { clearInterval(ping); ping = null; }
        if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",   // chặn lớp đệm trung gian giữ dữ liệu lại
      },
    });
  } catch (e) {
    if (isUnauthorized(e)) return NextResponse.json({ error: "Phiên đã hết hạn." }, { status: 401 });
    return NextResponse.json({ error: "Lỗi máy chủ." }, { status: 500 });
  }
}
