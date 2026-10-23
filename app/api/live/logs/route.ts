// RISE LIVE — NHẬT KÝ (chỉ đọc). Gộp 2 sổ để nhân sự tự theo dõi:
//   kind=incidents → Nhật ký SỰ CỐ   (liveIncidentLog)
//   kind=moves     → Nhật ký CHUYỂN MÁY (liveMoveExecutions)
//   kind=actions   → Nhật ký THAO TÁC NGƯỜI DÙNG (auditLogs, action bắt đầu "live_")
//
// VÌ SAO THÊM "THAO TÁC" (28/08/2026 — Chủ Rise báo "xử lý xong nhưng nhật ký không lưu vết"):
// hai sổ trên chỉ ghi việc MÁY tự làm (sự cố, tự chuyển máy). Việc NGƯỜI làm để xử lý sự cố —
// dừng/bật lại luồng, sửa khoá, đổi máy, đặt mức ưu tiên — vẫn được ghi vết đầy đủ trong sổ
// kiểm toán chung, nhưng KHÔNG hiện ở màn Live nên nhìn như "không lưu vết". Nay đọc thẳng ra.
//
// VÌ SAO TÁCH RIÊNG (V64.90): trước đây 2 sổ này gửi kèm MỌI nhịp /api/live (route bị gọi rất
// nhiều) → đọc thừa hàng trăm bản ghi mỗi lần, tốn chi phí + góp phần làm CHẬM app. Nay chỉ tải
// KHI người dùng mở tab Nhật ký, có PHÂN TRANG + LỌC THỜI GIAN nên đọc ít hơn hẳn.
//
// Phạm vi xem: dùng chung cơ chế getVisibleUserEmails (như Báo cáo/Đánh giá) — nhân viên thấy
// việc của mình, Trưởng nhóm thấy đội, Admin/BLĐ thấy tất cả. Chuyển máy lọc theo CHỦ LUỒNG.
import { NextResponse } from "next/server";
import { firestore } from "@/lib/firestore";
import { requireSession } from "@/lib/session";
import { getVisibleUserEmails } from "@/lib/access";

export const dynamic = "force-dynamic";
const FLAG = () => process.env.RISE_LIVE === "1" || true; // Live luôn bật; giữ chỗ cho gate sau này

export async function GET(request: Request) {
  try {
    const user = await requireSession();
    if (!FLAG()) return NextResponse.json({ enabled: false, rows: [] });
    const url = new URL(request.url);
    const kindRaw = String(url.searchParams.get("kind") ?? "");
    const kind = kindRaw === "moves" ? "moves" : kindRaw === "actions" ? "actions" : "incidents";
    // Mốc thời gian: 1 = hôm nay/24h · 7 = tuần · 30 = tháng · 0 = tất cả (trần 90 ngày)
    const daysRaw = Number(url.searchParams.get("days"));
    const days = [0, 1, 2, 7, 30].includes(daysRaw) ? daysRaw : 7;
    const size = Math.min(100, Math.max(10, Number(url.searchParams.get("size")) || 20));
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const q = String(url.searchParams.get("q") ?? "").trim().toLowerCase();
    const machineId = String(url.searchParams.get("machineId") ?? "").trim();

    const visible = await getVisibleUserEmails(user);
    const vis = visible ? new Set(Array.from(visible).map((e) => String(e).toLowerCase())) : null;
    const sinceMs = days > 0 ? Date.now() - days * 86400000 : Date.now() - 90 * 86400000;
    const sinceISO = new Date(sinceMs).toISOString();

    let rows: any[] = [];
    if (kind === "incidents") {
      const snap = await firestore.collection("liveIncidentLog").orderBy("createdAt", "desc").limit(600).get().catch(() => null);
      rows = (snap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) }))
        .filter((e: any) => String(e.createdAt ?? e.resolvedAt ?? "") >= sinceISO)
        .filter((e: any) => !vis || vis.has(String(e.streamOwner ?? "").toLowerCase()));
    } else if (kind === "actions") {
      // THAO TÁC NGƯỜI DÙNG trên Rise Live. Firestore không truy vấn được "bắt đầu bằng"
      // nên lấy theo thời gian rồi lọc tiền tố "live_" ở đây (số bản ghi nhỏ).
      const snap = await firestore.collection("auditLogs")
        .where("performedAt", ">=", sinceISO).orderBy("performedAt", "desc").limit(600).get().catch(() => null);
      rows = (snap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) }))
        .filter((e: any) => String(e.action ?? "").startsWith("live_"))
        // Phạm vi xem: nhân viên thấy thao tác của mình, Trưởng nhóm thấy đội, Admin thấy tất cả.
        .filter((e: any) => !vis || vis.has(String(e.performedBy ?? "").toLowerCase()))
        .map((e: any) => ({ ...e, startedAt: e.performedAt, createdAt: e.performedAt }));
    } else {
      // Chuyển máy: bản ghi KHÔNG lưu chủ luồng → lọc phạm vi bằng danh sách luồng mình được thấy.
      const [snap, sSnap] = await Promise.all([
        firestore.collection("liveMoveExecutions").orderBy("startedAt", "desc").limit(400).get().catch(() => null),
        vis ? firestore.collection("liveStreams").limit(2000).get().catch(() => null) : Promise.resolve(null),
      ]);
      const mineStreamIds = vis && sSnap
        ? new Set(sSnap.docs.filter((d) => vis.has(String((d.data() as any).createdBy ?? "").toLowerCase())).map((d) => d.id))
        : null;
      rows = (snap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) }))
        .filter((e: any) => String(e.startedAt ?? "") >= sinceISO)
        .filter((e: any) => !mineStreamIds || mineStreamIds.has(String(e.streamId ?? "")));
    }
    if (machineId) rows = rows.filter((e: any) => String(e.machineId ?? "") === machineId || String(e.sourceMachineId ?? "") === machineId || String(e.targetMachineId ?? "") === machineId);
    if (q) rows = rows.filter((e: any) => `${e.streamName ?? ""} ${e.channelName ?? ""} ${e.cause ?? ""} ${e.reason ?? ""} ${e.detail ?? ""} ${e.action ?? ""} ${e.performedBy ?? ""}`.toLowerCase().includes(q));

    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const cur = Math.min(page, pages);
    return NextResponse.json({ enabled: true, kind, days, size, page: cur, pages, total, rows: rows.slice((cur - 1) * size, cur * size) });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Lỗi máy chủ." }, { status: 500 });
  }
}

// ─── DỌN NHẬT KÝ (30/08/2026 — Chủ Rise Group yêu cầu) ───────────────────────────────────────
//
// VÌ SAO CÓ: nhật ký sự cố tích lại hàng trăm dòng, phần lớn là chớp 1–5 giây vô hại. Nhân viên mở
// luồng ra thấy một danh sách đỏ dài thì hoảng, dù thực tế không có gì. Admin cần dọn được.
//
// BỐN RÀO CHẮN — đây là xoá dữ liệu thật nên không làm ẩu:
//  1. CHỈ ADMIN. Kiểm ở MÁY CHỦ, không phải chỉ giấu nút đi.
//  2. KHÔNG BAO GIỜ ĐỘNG VÀO SỔ KIỂM TOÁN (auditLogs). Đó là vết ai-làm-gì, xoá là mất trách nhiệm.
//     Nút này chỉ dọn sổ MÁY TỰ GHI: sự cố luồng, sự cố máy, lần chuyển máy.
//  3. CHÍNH VIỆC DỌN CŨNG BỊ GHI VẾT vào sổ kiểm toán: ai dọn, dọn gì, xoá bao nhiêu dòng.
//  4. CÓ ĐƯỜNG DỌN MỀM: `olderThanDays` — chỉ xoá dòng cũ hơn N ngày, giữ lại phần gần đây.
//     Muốn xoá sạch thì để 0 (phải chủ ý).
type PhamVi = "blips" | "incidents" | "moves" | "all";

async function xoaBotSuu(ten: string, mocISO: string | null): Promise<number> {
  // Xoá theo lô 400 (dưới trần 500 của Firestore). Có trần vòng lặp để không bao giờ chạy vô tận.
  let da = 0;
  for (let vong = 0; vong < 50; vong++) {
    const snap = await firestore.collection(ten).limit(400).get().catch(() => null);
    if (!snap || snap.empty) break;
    const canXoa = snap.docs.filter((d) => {
      if (!mocISO) return true;                       // xoá sạch
      const t = String((d.data() as any).at ?? (d.data() as any).createdAt ?? "");
      return t !== "" && t < mocISO;                  // chỉ dòng CŨ hơn mốc
    });
    if (!canXoa.length) break;                        // lô này không còn gì cũ → dừng (tránh quay vô ích)
    const batch = firestore.batch();
    canXoa.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    da += canXoa.length;
    if (snap.size < 400) break;
  }
  return da;
}

export async function POST(request: Request) {
  try {
    const user = await requireSession();
    // RÀO 1 — chỉ Admin, kiểm ở máy chủ.
    const laAdmin = user.role === "admin" || (Array.isArray((user as any).permissions) && (user as any).permissions.includes("admin"));
    if (!laAdmin) return NextResponse.json({ error: "Chỉ Quản trị viên mới dọn được nhật ký." }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const pv = (["blips", "incidents", "moves", "all"] as PhamVi[]).includes(body?.scope) ? (body.scope as PhamVi) : "blips";
    const ngay = Math.max(0, Math.min(365, Number(body?.olderThanDays) || 0));
    const mocISO = ngay > 0 ? new Date(Date.now() - ngay * 86400000).toISOString() : null;

    let soBlip = 0, soLuong = 0, soSuCo = 0, soChuyen = 0;

    // (a) Sự cố ghi TRÊN TỪNG LUỒNG — cái hiện "⚡ tự phục hồi Ns" ở thẻ luồng. Đây là thứ gây hoảng nhất.
    if (pv === "blips" || pv === "all") {
      const snap = await firestore.collection("liveStreams").get();
      for (const d of snap.docs) {
        const cu: any[] = Array.isArray((d.data() as any).recentIncidents) ? (d.data() as any).recentIncidents : [];
        if (!cu.length) continue;
        const giu = mocISO ? cu.filter((e: any) => String(e?.at ?? "") >= mocISO) : [];
        if (giu.length === cu.length) continue;
        soBlip += cu.length - giu.length; soLuong++;
        await d.ref.update({ recentIncidents: giu, incidentCount: giu.length }).catch(() => { /* doc đã xoá */ });
      }
    }
    // (b) Sự cố MÁY   (c) Lần chuyển máy
    if (pv === "incidents" || pv === "all") soSuCo = await xoaBotSuu("liveIncidentLog", mocISO);
    if (pv === "moves" || pv === "all") soChuyen = await xoaBotSuu("liveMoveExecutions", mocISO);

    // RÀO 3 — ghi vết chính việc dọn này. KHÔNG đụng gì khác trong sổ kiểm toán.
    const { logAudit } = await import("@/lib/audit");
    await logAudit(firestore, {
      action: "live_reset_logs", entityType: "liveLogs", entityId: pv, performedBy: user.email,
      detail: `Dọn nhật ký (${pv}${ngay > 0 ? `, cũ hơn ${ngay} ngày` : ", XOÁ SẠCH"}) — sự cố luồng ${soBlip} dòng/${soLuong} luồng · sự cố máy ${soSuCo} · chuyển máy ${soChuyen}`,
    }).catch(() => { /* ghi vết lỗi không được chặn việc đã làm xong */ });

    return NextResponse.json({ ok: true, scope: pv, olderThanDays: ngay, blips: soBlip, streams: soLuong, incidents: soSuCo, moves: soChuyen });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Lỗi máy chủ." }, { status: 500 });
  }
}
