// RISE LIVE L3 — Đợt 1 · Khu "Kết nối kênh YouTube" (giao diện). Tự ẩn khi cờ tắt / không phải
// Admin. Bấm "Kết nối kênh" -> điều hướng sang đăng nhập Google (route /api/live/youtube/connect).
"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui-primitives";

const STATE_LABEL: Record<string, string> = {
  CONNECTED: "Đã kết nối", DEGRADED: "Kết nối trục trặc", EXPIRED: "Hết hạn",
  REVOKED: "Bị thu hồi", REAUTH_REQUIRED: "Cần kết nối lại",
};
// Giải thích rõ từng trạng thái (hiện khi rê chuột) — tránh hiểu nhầm "trục trặc" = luồng phập phù.
const STATE_HINT: Record<string, string> = {
  CONNECTED: "Rise đang xác minh được trạng thái kênh này từ YouTube.",
  DEGRADED: "Lần gần nhất Rise gọi YouTube để xác minh trạng thái kênh này bị lỗi tạm (mạng/token) — KÊNH VẪN PHÁT BÌNH THƯỜNG, không phải luồng chập chờn. Thường tự hết ở lần kiểm sau; nếu kéo dài hãy Hủy kết nối rồi nối lại.",
  EXPIRED: "Phiên kết nối YouTube đã hết hạn — cần nối lại.",
  REVOKED: "Quyền kết nối đã bị thu hồi — cần nối lại.",
  REAUTH_REQUIRED: "Cần kết nối lại kênh YouTube (làm mới quyền).",
};

export function YoutubeConnect({ flash }: { flash?: (m: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [syncing, setSyncing] = useState(false);
  const [q, setQ] = useState("");                       // tìm kênh (khi có nhiều kênh)
  const [showAll, setShowAll] = useState(false);        // xem tất cả / chỉ ~20 kênh đầu
  const [collapsed, setCollapsed] = useState(true);     // MẶC ĐỊNH THU GỌN — bấm mới mở (đỡ chiếm chỗ đầu Tổng quan, nhất là điện thoại)
  const [editIds, setEditIds] = useState<Set<string>>(new Set());  // kênh ĐANG mở lại để đổi nối (mặc định KHÓA khi đã nối)
  const load = async () => { try { const r = await fetch("/api/live/youtube"); setData(await r.json()); } catch { /* im lặng */ } };
  const doSync = async () => {
    setSyncing(true);
    try {
      const r = await fetch("/api/live/youtube/sync", { method: "POST" });
      const j = await r.json();
      if (j.error) flash?.("⚠ " + j.error);
      else flash?.(`✅ Đã đồng bộ ${j.synced} kênh${j.failed ? `, ${j.failed} lỗi` : ""}.`);
      await load();
    } catch { flash?.("⚠ Đồng bộ lỗi."); } finally { setSyncing(false); }
  };
  const doMap = async (connectionId: string, riseChannelId: string, current: string) => {
    // Đang nối kênh rồi mà ĐỔI/BỎ → hỏi lại (chống bấm nhầm). Nối lần đầu thì làm luôn.
    const nameOf = (id: string) => (data?.riseChannels ?? []).find((rc: any) => rc.id === id)?.name ?? "";
    if (current && current !== riseChannelId) {
      const nextTxt = riseChannelId ? `“${nameOf(riseChannelId)}”` : "(bỏ nối)";
      if (!window.confirm(`Kênh này đang nối với “${nameOf(current)}”.\nĐổi sang ${nextTxt}?`)) { await load(); return; }
    }
    try {
      const r = await fetch("/api/live/youtube", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "map", connectionId, riseChannelId }) });
      const j = await r.json();
      if (j.error) flash?.("⚠ " + j.error); else flash?.(riseChannelId ? "✅ Đã nối & khóa kênh." : "✅ Đã bỏ nối kênh.");
      setEditIds((s) => { const n = new Set(s); n.delete(connectionId); return n; });  // nối xong → KHÓA lại
      await load();
    } catch { flash?.("⚠ Nối kênh lỗi."); }
  };
  const doDisconnect = async (connectionId: string, title: string) => {
    if (!window.confirm(`Hủy kết nối kênh YouTube “${title}”?\nHệ thống sẽ thu hồi quyền ở Google + gỡ kênh khỏi Rise Work.\n(KHÔNG ảnh hưởng luồng đang phát — luồng đẩy bằng Khoá luồng riêng.)`)) return;
    try {
      const r = await fetch("/api/live/youtube", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "disconnect", connectionId }) });
      const j = await r.json();
      if (j.error) flash?.("⚠ " + j.error); else flash?.("✅ Đã hủy kết nối kênh.");
      await load();
    } catch { flash?.("⚠ Hủy kết nối lỗi."); }
  };
  useEffect(() => { void load(); }, []);
  // Đọc thông báo trả về từ callback (?live_yt=ok/err&m=...) rồi dọn URL.
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const s = u.searchParams.get("live_yt"), m = u.searchParams.get("m");
      if (s) {
        flash?.((s === "ok" ? "✅ " : "⚠ ") + (m || ""));
        u.searchParams.delete("live_yt"); u.searchParams.delete("m");
        window.history.replaceState({}, "", u.toString());
        void load();
      }
    } catch { /* bỏ qua */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || !data.enabled || !data.canConnect) return null;
  const conns: any[] = data.connections ?? [];
  return (
    <div style={{ marginBottom: 12 }}>
      <Card
        title="📺 Kết nối kênh YouTube (theo dõi chính xác trạng thái)"
        action={
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
            <button className="rowbtn" onClick={() => setCollapsed((v) => !v)} title="Thu gọn / mở khu kết nối kênh">{collapsed ? `▸ Mở (${conns.length} kênh${conns.filter((c: any) => c.youtubeState?.broadcastStatus === "live").length ? `, ${conns.filter((c: any) => c.youtubeState?.broadcastStatus === "live").length} đang live` : ""})` : "▾ Thu gọn"}</button>
            {!collapsed && data.configured && (<>
              {conns.length > 0 && <button className="rowbtn" disabled={syncing} onClick={doSync}>{syncing ? "Đang đồng bộ…" : "🔄 Đồng bộ"}</button>}
              <a className="rowbtn" href="/api/live/youtube/connect?mode=control" title="Cấp luôn cả quyền THEO DÕI và ĐIỀU KHIỂN (bật/tắt sóng từ app) trong một lần — khỏi phải bật điều khiển riêng sau này">➕ Kết nối kênh (kèm điều khiển)</a>
              <a className="rowbtn" href="/api/live/youtube/connect" title="Chỉ cấp quyền theo dõi trạng thái (không điều khiển được sóng)" style={{ fontSize: 11, color: "var(--muted,#94a3b8)" }}>Chỉ theo dõi</a>
            </>)}
          </span>
        }
      >
        {!collapsed && (<>
        {!data.configured && (
          <p className="plain" style={{ color: "var(--amber,#d97706)" }}>
            ⚠ Máy chủ chưa cấu hình OAuth — chưa kết nối được. (Kỹ thuật: đặt GOOGLE_OAUTH_CLIENT_ID/SECRET.)
          </p>
        )}
        {conns.length === 0 ? (
          <p className="empty">Chưa kết nối kênh nào. Bấm <b>“Kết nối kênh”</b> → đăng nhập tài khoản Google quản kênh → xong.</p>
        ) : (() => {
          // Ở QUY MÔ LỚN (100-200+ kênh): tìm kiếm + ưu tiên kênh CHƯA nối/đang trục trặc lên đầu +
          // chỉ hiện ~20 kênh, phần còn lại bấm "Xem tất cả" (khỏi phình trang Tổng quan).
          const kw = q.trim().toLowerCase();
          const filtered = conns.filter((c) => !kw || String(c.channelTitle ?? "").toLowerCase().includes(kw) || String(c.connectedBy ?? "").toLowerCase().includes(kw));
          const attn = (c: any) => (!c.riseChannelId ? 0 : 1) + (c.connectionState !== "CONNECTED" ? 0 : 2);   // chưa nối / trục trặc lên trước
          const sorted = [...filtered].sort((a, b) => attn(a) - attn(b) || String(a.channelTitle).localeCompare(String(b.channelTitle), "vi"));
          const LIMIT = 20;
          const shown = showAll ? sorted : sorted.slice(0, LIMIT);
          return (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {conns.length > 8 && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Tìm trong ${conns.length} kênh (tên kênh / người nối)…`} style={{ flex: "1 1 220px", minWidth: 160, fontSize: 12.5, padding: "5px 9px", borderRadius: 7, border: "1px solid var(--line,#e7ecf2)" }} />
                {kw && <span style={{ fontSize: 12, color: "var(--muted)" }}>{filtered.length}/{conns.length}</span>}
              </div>
            )}
            {shown.map((c) => {
              const ys = c.youtubeState;
              const live = ys?.broadcastStatus === "live";
              const n = Number(ys?.liveCount ?? 0);
              const synced = !!ys;
              return (
                <div key={c.id} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px 10px", padding: "8px 2px", borderBottom: "1px solid var(--line,#eef2f6)" }}>
                  {c.thumbnail
                    ? <img src={c.thumbnail} alt="" width={26} height={26} style={{ borderRadius: "50%", flex: "none" }} />
                    : <span style={{ width: 26, flex: "none" }} />}
                  <span style={{ flex: 1, minWidth: 120, overflow: "hidden" }}>
                    <b style={{ fontSize: 13, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.channelTitle}</b>
                    {c.connectedBy ? <small style={{ fontSize: 10.5, color: "var(--muted,#98a2b3)" }} title="Người đã kết nối kênh này">👤 {c.connectedBy}</small> : null}
                  </span>
                  {c.riseChannelId && !editIds.has(c.id) ? (
                    // ĐÃ NỐI → KHÓA lại (không đổi nhầm). Bấm "Đổi" mới cho chọn lại.
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none", maxWidth: 220 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--green,#2f9e44)", border: "1px solid var(--green,#b7e0c2)", borderRadius: 7, padding: "3px 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title="Đã nối & khóa kênh Rise">🔒 {(data.riseChannels ?? []).find((rc: any) => rc.id === c.riseChannelId)?.name ?? "kênh Rise"}</span>
                      <button type="button" onClick={() => setEditIds((s) => new Set(s).add(c.id))} title="Đổi kênh nối" style={{ fontSize: 11, color: "var(--blue,#2563eb)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Đổi</button>
                    </span>
                  ) : (
                    <select
                      value={c.riseChannelId ?? ""}
                      onChange={(e) => doMap(c.id, e.target.value, c.riseChannelId ?? "")}
                      style={{ fontSize: 11.5, padding: "3px 6px", borderRadius: 7, border: `1px solid ${c.riseChannelId ? "var(--green,#2f9e44)" : "var(--line,#e7ecf2)"}`, background: "var(--card)", maxWidth: 180 }}
                      title="Nối kênh này với 1 kênh trong Rise Work — chọn xong sẽ tự KHÓA lại"
                    >
                      <option value="">— Nối kênh Rise —</option>
                      {(data.riseChannels ?? []).map((rc: any) => <option key={rc.id} value={rc.id}>{rc.name}</option>)}
                    </select>
                  )}
                  {!c.riseChannelId && <span style={{ fontSize: 11, color: "var(--muted,#98a2b3)", flex: "none" }} title="Chưa nối kênh Rise">chưa nối</span>}
                  {synced && (
                    live
                      ? (() => {
                          // HIỆN ĐỦ mọi luồng đang phát của kênh (không chỉ luồng đầu tiên).
                          const bcs: any[] = (Array.isArray(ys.broadcasts) && ys.broadcasts.length)
                            ? ys.broadcasts
                            : (ys.watchUrl ? [{ watchUrl: ys.watchUrl }] : []);
                          return (
                            <span style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: 6, flex: "none" }}>
                              <span style={{ fontSize: 11, fontWeight: 800, color: "var(--red,#c95050)" }}>🔴 Đang live{n > 1 ? ` (${n})` : ""}</span>
                              {bcs.map((b, i) => (
                                <a key={i} href={b.watchUrl || "#"} target="_blank" rel="noreferrer" title={b.title || `Luồng ${i + 1}`} style={{ fontSize: 11, fontWeight: 700, color: "var(--red,#c95050)", textDecoration: "none" }}>▶{bcs.length > 1 ? ` ${i + 1}` : " Mở"}</a>
                              ))}
                            </span>
                          );
                        })()
                      : <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted,#7a8697)" }}>⚪ Không live</span>
                  )}
                  <span title={`${STATE_HINT[c.connectionState] ?? ""}${c.lastError ? `\n(Lỗi gần nhất: ${c.lastError})` : ""}`} style={{ fontSize: 11, fontWeight: 700, color: c.connectionState === "CONNECTED" ? "var(--green,#248867)" : "var(--amber,#c98617)" }}>
                    {STATE_LABEL[c.connectionState] ?? c.connectionState}
                  </span>
                  {c.hasControlScope
                    ? <span title="Đã cấp quyền ĐIỀU KHIỂN (bật/tắt sóng từ app) — Đợt 2" style={{ fontSize: 10.5, fontWeight: 700, color: "var(--rl,#0e8f84)", whiteSpace: "nowrap" }}>🎛 điều khiển được</span>
                    : <a href="/api/live/youtube/connect?mode=control" title="Xin thêm quyền để ĐIỀU KHIỂN lên/xuống sóng ngay trên app (Đợt 2)" style={{ fontSize: 10.5, fontWeight: 700, color: "var(--blue,#2563eb)", textDecoration: "none", whiteSpace: "nowrap" }}>🎛 Bật điều khiển</a>}
                  <button type="button" onClick={() => doDisconnect(c.id, c.channelTitle)} title="Hủy kết nối kênh YouTube này (thu hồi quyền ở Google + gỡ khỏi Rise Work). Không ảnh hưởng luồng đang phát." style={{ fontSize: 10.5, fontWeight: 700, color: "var(--red,#c95050)", background: "none", border: "1px solid var(--red,#f0c2c2)", borderRadius: 6, padding: "2px 7px", cursor: "pointer", whiteSpace: "nowrap", flex: "none" }}>✕ Hủy kết nối</button>
                </div>
              );
            })}
            {sorted.length > LIMIT && (
              <button type="button" onClick={() => setShowAll((v) => !v)} style={{ alignSelf: "center", marginTop: 6, fontSize: 12.5, color: "var(--blue,#2563eb)", background: "none", border: "none", cursor: "pointer" }}>
                {showAll ? "Thu gọn ▲" : `Xem tất cả ${sorted.length} kênh ▼`}
              </button>
            )}
          </div>
          );
        })()}
        <p className="plain" style={{ fontSize: 11.5, color: "var(--muted,#7a8697)", marginTop: 8, marginBottom: 0 }}>
          Kênh đã kết nối: hệ thống xác minh chính xác trạng thái phía YouTube. Kênh chưa kết nối vẫn phát bình thường.
        </p>
        </>)}
      </Card>
    </div>
  );
}
