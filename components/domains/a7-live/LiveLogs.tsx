// RISE LIVE — "NHẬT KÝ" (V64.90). Gộp 2 sổ để nhân sự TỰ theo dõi, không cần hỏi kỹ thuật:
//   • Sự cố      — luồng rớt / bị chặn / cần người, kèm lý do và cách xử.
//   • Chuyển máy — luồng được chuyển từ VPS nào sang VPS nào, ai làm, vì sao, kết quả.
//
// Danh sách dài nên có: LỌC THỜI GIAN (hôm nay/tuần/tháng) · TÌM theo tên · CHỌN SỐ DÒNG mỗi
// trang · PHÂN TRANG — giống các bảng khác trong app.
//
// Tải qua đường riêng /api/live/logs, CHỈ khi mở tab này (trước đây 2 sổ gửi kèm mọi nhịp
// /api/live → đọc thừa hàng trăm bản ghi mỗi lần, góp phần làm chậm app).
"use client";
import { useEffect, useState } from "react";
import { Pill } from "@/components/ui-primitives";

const RANGES: [number, string][] = [[1, "24 giờ"], [7, "7 ngày"], [30, "30 ngày"], [0, "Tất cả"]];
const SIZES = [10, 20, 50, 100];
// GIỜ VIỆT NAM (+7). Mốc thời gian lưu theo giờ quốc tế (UTC) — cắt thẳng chuỗi sẽ hiện CHẬM 7 TIẾNG
// (Chủ Rise Group phát hiện). Phải cộng bù rồi mới hiển thị, giống fmtIncTime bên màn sự cố.
const fmtWhen = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (isNaN(t)) return "—";
  const d = new Date(t + 7 * 3600e3);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} · ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`;
};
const MOVE_TYPE: Record<string, string> = {
  manual_safe_move: "Chuyển tay", manual_emergency_move: "Khẩn cấp (tay)", manual_autocopy_move: "Chuyển tay (tự copy)",
  automatic_failover: "🔁 Tự động cứu", drain_move: "Rút máy", rebalance_move: "Cân bằng tải",
};

// Ten hanh dong trong so kiem toan la ma ky thuat — doi sang tieng Viet cho de doc.
const VIET_HANH_DONG: Record<string, string> = {
  live_add_machine: "Thêm máy phát", live_update_machine: "Sửa máy phát",
  live_delete_machine: "Xoá máy phát", live_set_machine_offline: "Ngắt/bật lại máy phát",
  live_add_asset: "Thêm video", live_delete_asset: "Xoá video",
  live_add_stream: "Tạo luồng", live_update_stream: "Sửa luồng", live_delete_stream: "Xoá luồng",
  live_start_stream: "Bật luồng", live_stop_stream: "Dừng luồng",
  live_move_stream: "Chuyển luồng sang máy khác", live_set_stream_meta: "Đặt mức ưu tiên / dự phòng",
};

function LogList({ kind, machineName, machines }: { kind: "incidents" | "moves" | "actions"; machineName: (id: string) => string; machines: any[] }) {
  const [days, setDays] = useState(7);
  const [size, setSize] = useState(20);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [mid, setMid] = useState("");
  const [d, setD] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    const u = `/api/live/logs?kind=${kind}&days=${days}&size=${size}&page=${page}${q ? `&q=${encodeURIComponent(q)}` : ""}${mid ? `&machineId=${encodeURIComponent(mid)}` : ""}`;
    fetch(u, { cache: "no-store" }).then((r) => r.json()).then((x) => { setD(x); setLoading(false); }).catch(() => { setD({ error: "Lỗi mạng." }); setLoading(false); });
  }, [kind, days, size, page, q, mid]);
  useEffect(() => { setPage(1); }, [days, size, q, mid]);   // đổi bộ lọc → về trang 1

  const rows = d?.rows ?? [];
  const inputStyle = { padding: "5px 9px", borderRadius: 8, border: "1px solid var(--line,#d7deea)", background: "var(--card,#fff)", color: "var(--ink,#0b1c35)", fontSize: 12.5 };
  return (
    <div>
      {/* BỘ LỌC */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <div style={{ display: "inline-flex", gap: 3, background: "var(--surface2,#f1f5f9)", borderRadius: 8, padding: 3 }}>
          {RANGES.map(([n, lb]) => (
            <button key={n} onClick={() => setDays(n)}
              style={{ border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: days === n ? "var(--sel,#0b1c35)" : "transparent", color: days === n ? "var(--sel-ink,#fff)" : "var(--muted,#5b6b82)" }}>{lb}</button>
          ))}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm tên luồng / kênh…" style={{ ...inputStyle, flex: "1 1 170px", minWidth: 140 }} />
        {machines.length > 1 && (
          <select value={mid} onChange={(e) => setMid(e.target.value)} style={inputStyle}>
            <option value="">Mọi máy</option>
            {machines.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <select value={size} onChange={(e) => setSize(Number(e.target.value))} style={inputStyle} title="Số dòng mỗi trang">
          {SIZES.map((s) => <option key={s} value={s}>{s} dòng</option>)}
        </select>
        <span style={{ fontSize: 12, color: "var(--muted,#718096)", marginLeft: "auto" }}>
          {loading ? "đang tải…" : `${d?.total ?? 0} bản ghi`}
        </span>
      </div>

      {/* DANH SÁCH */}
      {d?.error ? <p className="empty">{d.error}</p> : rows.length === 0 ? (
        <p className="empty" style={{ textAlign: "left" }}>{loading ? "Đang tải…" : `Không có ${kind === "moves" ? "lần chuyển máy" : kind === "actions" ? "thao tác nào" : "sự cố"} nào trong khoảng đã chọn.`}</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {kind === "actions" ? rows.map((e: any) => (
            <div key={e.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "8px 12px", background: "var(--card,#fff)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <b style={{ fontSize: 13 }}>{VIET_HANH_DONG[String(e.action)] ?? String(e.action).replace(/^live_/, "").replace(/_/g, " ")}</b>
                <small style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtWhen(e.performedAt)}</small>
              </div>
              {e.detail ? <div style={{ fontSize: 12, marginTop: 4 }}>{String(e.detail).slice(0, 200)}</div> : null}
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>Người thực hiện: <b>{e.performedBy ?? "—"}</b></div>
            </div>
          )) : kind === "incidents" ? rows.map((e: any) => (
            <div key={e.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "8px 12px", background: "var(--card,#fff)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Pill tone={/file|chặn|đình chỉ|chờ người/i.test(String(e.cause)) ? "red" : "amber"}>{e.cause}</Pill>
                  <b style={{ fontSize: 12.5 }}>{e.streamName}</b>
                  {e.channelName ? <small style={{ color: "var(--muted)" }}>· {e.channelName}</small> : null}
                </span>
                <small style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtWhen(e.resolvedAt ?? e.createdAt)} · 🖥 {machineName(e.machineId)}</small>
              </div>
              {e.reason ? <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 4, wordBreak: "break-word" }}>{String(e.reason).slice(0, 200)}</div> : null}
              {e.resolvedBy ? <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>Xử bởi {e.resolvedBy}{e.resolution === "cleared_yt_flag" ? " · đã bỏ cờ YouTube" : e.resolution ? " · đã dừng luồng" : ""}</div> : null}
            </div>
          )) : rows.map((e: any) => (
            <div key={e.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "8px 12px", background: "var(--card,#fff)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Pill tone={e.result === "success" ? "green" : e.result === "rolled_back" ? "amber" : e.state === "failed" ? "red" : "blue"}>
                    {e.result === "success" ? "✅ Xong" : e.result === "rolled_back" ? "↩ Hoàn tác" : e.state === "failed" ? "✗ Hỏng" : "⏳ Đang chuyển"}
                  </Pill>
                  <b style={{ fontSize: 12.5 }}>{e.streamName}</b>
                  <small style={{ color: "var(--muted)" }}>{MOVE_TYPE[String(e.moveType)] ?? e.moveType}</small>
                </span>
                <small style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtWhen(e.startedAt)}</small>
              </div>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                🖥 <b>{machineName(e.sourceMachineId)}</b> <span style={{ color: "var(--muted)" }}>→</span> <b>{machineName(e.targetMachineId)}</b>
              </div>
              {e.reason ? <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 3 }}>Lý do: {String(e.reason).slice(0, 160)}</div> : null}
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
                {e.initiatedBy === "system" ? "Hệ thống tự chuyển" : `Người thực hiện: ${e.initiatedByName ?? e.initiatedBy ?? "—"}`}
                {e.completedAt ? ` · xong ${fmtWhen(e.completedAt)}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* PHÂN TRANG */}
      {(d?.pages ?? 1) > 1 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center", marginTop: 12 }}>
          <button className="rowbtn" disabled={page <= 1} onClick={() => setPage(1)}>|«</button>
          <button className="rowbtn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹</button>
          <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Trang <b style={{ color: "var(--ink)" }}>{d.page}</b>/{d.pages}</span>
          <button className="rowbtn" disabled={page >= (d?.pages ?? 1)} onClick={() => setPage((p) => p + 1)}>›</button>
          <button className="rowbtn" disabled={page >= (d?.pages ?? 1)} onClick={() => setPage(d?.pages ?? 1)}>»|</button>
        </div>
      )}
    </div>
  );
}

// Tab "Nhật ký": 2 sổ con. `openPanel` = khối "vụ việc ĐANG MỞ" (giữ nguyên màn cũ) hiện ở sổ Sự cố.
// DỌN NHẬT KÝ — CHỈ ADMIN (30/08/2026, Chủ Rise Group yêu cầu).
// Nhật ký tích lại hàng trăm dòng, phần lớn là chớp 1–5 giây vô hại; nhân viên mở luồng thấy một
// danh sách đỏ dài thì hoảng dù chẳng có chuyện gì. Nút này dọn được.
// Máy chủ mới là chỗ chặn quyền thật (route /api/live/logs trả 403 nếu không phải Admin) — chỗ này
// chỉ là giấu nút cho đỡ vướng mắt. KHÔNG BAO GIỜ đụng tới sổ kiểm toán "Thao tác người dùng".
function DonNhatKy({ flash }: { flash?: (m: string) => void }) {
  const [dangChay, setDangChay] = useState(false);
  const chay = async (ngay: number) => {
    const nhan = ngay > 0 ? `dọn các dòng CŨ HƠN ${ngay} NGÀY` : "XOÁ SẠCH toàn bộ nhật ký sự cố";
    if (!window.confirm(`Bạn sắp ${nhan}.\n\nGồm: sự cố trên từng luồng · sự cố máy · lần chuyển máy.\nKHÔNG đụng tới sổ "Thao tác người dùng" (vết ai làm gì vẫn giữ nguyên).\n\nKhông hoàn tác được. Tiếp tục?`)) return;
    setDangChay(true);
    try {
      const r = await fetch("/api/live/logs", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all", olderThanDays: ngay }) });
      const x = await r.json();
      if (!r.ok) { flash?.(x?.error ?? "Không dọn được."); return; }
      flash?.(`Đã dọn: ${x.blips ?? 0} sự cố trên ${x.streams ?? 0} luồng · ${x.incidents ?? 0} sự cố máy · ${x.moves ?? 0} lần chuyển máy. Tải lại trang để thấy.`);
    } catch { flash?.("Lỗi mạng."); } finally { setDangChay(false); }
  };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink,#0b1c35)" }}>🧹 Dọn nhật ký</span>
      <span className="plain" style={{ fontSize: 11, color: "var(--muted)" }}>Chỉ Quản trị. Giữ nguyên sổ &ldquo;Thao tác người dùng&rdquo;.</span>
      <span style={{ flex: 1 }} />
      <button className="rowbtn" disabled={dangChay} onClick={() => chay(7)}>Cũ hơn 7 ngày</button>
      <button className="rowbtn" disabled={dangChay} onClick={() => chay(1)}>Cũ hơn 1 ngày</button>
      <button className="rowbtn" disabled={dangChay} onClick={() => chay(0)}
        style={{ borderColor: "var(--danger,#b3261e)", color: "var(--danger,#b3261e)" }}>Xoá sạch</button>
    </div>
  );
}

export function LiveLogsTabs({ machineName, machines = [], openPanel, isAdmin = false, flash }: { machineName: (id: string) => string; machines?: any[]; openPanel?: React.ReactNode; isAdmin?: boolean; flash?: (m: string) => void }) {
  const [sub, setSub] = useState<"incidents" | "moves" | "actions">("incidents");
  return (
    <div>
      {isAdmin ? <DonNhatKy flash={flash} /> : null}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {(([["incidents", "🛠 Sự cố"], ["moves", "🔀 Chuyển máy"], ["actions", "👤 Thao tác người dùng"]]) as [typeof sub, string][]).map(([k, lb]) => (
          <button key={k} className="rowbtn" onClick={() => setSub(k)}
            style={sub === k ? { background: "var(--sel,#0b1c35)", color: "var(--sel-ink,#fff)" } : {}}>{lb}</button>
        ))}
      </div>
      {sub === "incidents" ? (
        <>
          {openPanel}
          <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--ink,#0b1c35)", marginBottom: 4 }}>📜 Lịch sử sự cố đã xử lý</div>
            <p className="plain" style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px" }}>Giữ lại kể cả khi luồng ĐÃ DỪNG / đã bỏ cờ — mốc giờ · người xử · lý do.</p>
            <LogList kind="incidents" machineName={machineName} machines={machines} />
          </div>
        </>
      ) : sub === "actions" ? (
        <>
          {/* Chu Rise 28/08: "xu ly xong nhung nhat ky khong luu vet" — hai so tren
              chi ghi viec MAY tu lam. Viec NGUOI lam de xu ly su co van duoc ghi
              day du trong so kiem toan chung, chi la chua hien o man Live. */}
          <div style={{ fontSize: 13, fontWeight: 800, color: "var(--ink,#0b1c35)", marginBottom: 4 }}>👤 Thao tác người dùng trên Live</div>
          <p className="plain" style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 10px" }}>Ai đã dừng/bật lại luồng, sửa khoá, đổi máy, đặt mức ưu tiên — mốc giờ và người thực hiện. Đây là vết xử lý sự cố.</p>
          <LogList kind="actions" machineName={machineName} machines={machines} />
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, fontWeight: 800, color: "var(--ink,#0b1c35)", marginBottom: 4 }}>🔀 Nhật ký chuyển máy</div>
          <p className="plain" style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 10px" }}>Luồng được chuyển từ máy nào sang máy nào, ai làm (hoặc hệ thống tự cứu), vì sao và kết quả ra sao.</p>
          <LogList kind="moves" machineName={machineName} machines={machines} />
        </>
      )}
    </div>
  );
}
