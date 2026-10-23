// DỌN BẢN DỰ PHÒNG KHÔNG CÒN DÙNG.
//
// Vấn đề Chủ Rise Group nêu (27/08/2026): luồng ưu tiên được hệ TỰ nhân bản video sang máy khác
// làm dự phòng — hợp lý khi luồng đang chạy. Nhưng khi luồng DỪNG hoặc BỊ XOÁ, các bản nhân bản
// nằm lại vĩnh viễn và âm thầm ăn ổ cứng. Đo thực tế lúc làm: 25 bản mồ côi = 84 GB.
//
// ⚠ CỐ Ý KHÔNG TỰ XOÁ. Xoá là không khôi phục được — nhất là video TẢI TAY (không có link Drive
// để tải lại). Nên ở đây chỉ LIỆT KÊ + để người xem tự chọn và bấm dọn. Đúng tinh thần: Rise Work
// ghi nhận và đề xuất, người quyết.
"use client";
import { useEffect, useState } from "react";

export function OrphanBackups({ post, rawPost, flash }: {
  post: (body: any, okMsg?: string) => Promise<any>;
  rawPost: (body: any) => Promise<any>;
  flash: (m: string) => void;
}) {
  const [data, setData] = useState<any>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = async () => {
    const r = await rawPost({ action: "list_orphan_backups" });
    if (r?.ok) { setData(r); setSel((r.items ?? []).map((x: any) => String(x.id))); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (!data?.totalCount) return null;   // không có gì để dọn → không làm rối màn

  const items: any[] = data.items ?? [];
  const selGb = Math.round((items.filter((x) => sel.includes(String(x.id))).reduce((s, x) => s + (Number(x.sizeMb) || 0), 0) / 1024) * 10) / 10;

  const doClean = async () => {
    if (!sel.length) return flash("Chưa chọn bản nào.");
    const risky = items.filter((x) => sel.includes(String(x.id)) && !x.fromDrive).length;
    const warn = risky > 0
      ? `\n\n⚠ Trong đó có ${risky} bản là video TẢI TAY (không có link Drive) — xoá rồi KHÔNG tải lại được.`
      : "";
    if (!window.confirm(`Dọn ${sel.length} bản dự phòng không còn dùng (~${selGb} GB)?${warn}\n\nCác bản này không luồng nào đang dùng. Xoá xong không khôi phục được.`)) return;
    setBusy(true);
    const r = await rawPost({ action: "cleanup_orphan_backups", ids: sel });
    setBusy(false);
    if (!r?.ok) return flash(r?.error ?? "Chưa dọn được.");
    flash(`Đã dọn ${r.deleted} bản dự phòng${r.skipped ? ` (bỏ qua ${r.skipped} bản vừa có luồng dùng lại)` : ""}.`);
    void load();
  };

  return (
    <div style={{ margin: "10px 0", padding: "11px 13px", borderRadius: 11, border: "1px dashed var(--amber,#d97706)", background: "var(--soft-amber,#fff7e6)" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <b style={{ fontSize: 13.5 }}>🧹 Bản dự phòng không còn dùng: {data.totalCount} bản · ~{data.totalGb} GB</b>
        <button className="rowbtn" onClick={() => setOpen((v) => !v)}>{open ? "Thu gọn" : "Xem danh sách"}</button>
        <button className="rowbtn" disabled={busy || !sel.length} style={{ marginLeft: "auto", background: "var(--soft-red,#fdeaea)", color: "var(--red,#dc2626)", fontWeight: 800 }}
          onClick={doClean}>{busy ? "Đang dọn…" : `🗑 Dọn ${sel.length} bản (~${selGb} GB)`}</button>
      </div>
      <small className="block" style={{ color: "var(--muted)", marginTop: 5 }}>
        Đây là bản hệ thống <b>tự nhân ra</b> để cứu luồng ưu tiên. Luồng đã dừng/xoá nên không còn ai dùng.
        <b> Hệ KHÔNG tự xoá</b> — bạn xem rồi tự quyết.
      </small>

      {open && (
        <div style={{ marginTop: 9, maxHeight: 260, overflow: "auto", borderTop: "1px dashed var(--line)", paddingTop: 8 }}>
          {items.map((x) => {
            const on = sel.includes(String(x.id));
            return (
              <label key={x.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "5px 0", fontSize: 12.5, cursor: "pointer" }}>
                <input type="checkbox" checked={on} onChange={() => setSel((v) => on ? v.filter((y) => y !== String(x.id)) : [...v, String(x.id)])} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ overflowWrap: "anywhere" }}>{x.name}</b>
                  <small className="block" style={{ color: "var(--muted)" }}>
                    {x.machineName} · {x.sizeMb} MB · {String(x.createdAt).slice(0, 10)}
                    {x.fromDrive ? " · có link Drive (tải lại được)" : " · ⚠ tải tay, xoá là mất hẳn"}
                  </small>
                </span>
              </label>
            );
          })}
          {data.totalCount > items.length && (
            <small className="block" style={{ color: "var(--muted)", marginTop: 6 }}>
              Đang hiện {items.length}/{data.totalCount} bản (nặng nhất trước). Dọn xong đợt này sẽ hiện tiếp.
            </small>
          )}
        </div>
      )}
    </div>
  );
}
