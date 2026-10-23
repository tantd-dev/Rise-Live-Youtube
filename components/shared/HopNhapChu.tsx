"use client";
import { useEffect, useRef, useState } from "react";

// Hộp hỏi/nhập chữ dùng chung (thay window.prompt). Khôi phục theo cách RiseLive.tsx gọi:
// setHoi({ tieuDe, nhan, moTa, goiY, giaTriDau, batBuoc, nhieuDong, nutXacNhan, nguyHiem, xong })
export type YeuCauNhap = {
  tieuDe: string;
  nhan?: string;
  moTa?: string;
  goiY?: string;
  giaTriDau?: string;
  batBuoc?: boolean;
  nhieuDong?: boolean;
  nutXacNhan?: string;
  nguyHiem?: boolean;
  xong: (giaTri: string) => void | Promise<void>;
};

export function HopNhapChu({ yeuCau, dong }: { yeuCau: YeuCauNhap | null; dong: () => void }) {
  const [giaTri, setGiaTri] = useState("");
  const [loi, setLoi] = useState("");
  const o = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (yeuCau) { setGiaTri(yeuCau.giaTriDau ?? ""); setLoi(""); setTimeout(() => o.current?.focus(), 30); }
  }, [yeuCau]);

  useEffect(() => {
    if (!yeuCau) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") dong(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [yeuCau, dong]);

  if (!yeuCau) return null;

  const gui = async () => {
    const v = giaTri.trim();
    if (yeuCau.batBuoc && !v) { setLoi("Cần nhập nội dung."); return; }
    try { await yeuCau.xong(v); } finally { dong(); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={yeuCau.tieuDe} onClick={dong}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--card,#fff)", color: "var(--ink,#1a2230)", borderRadius: 14, border: "1px solid var(--line,#e3e8ef)", width: "min(480px,100%)", padding: 18, boxShadow: "0 20px 50px rgba(0,0,0,.25)" }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>{yeuCau.tieuDe}</h3>
        {yeuCau.moTa && <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--muted,#6b7686)", lineHeight: 1.5 }}>{yeuCau.moTa}</p>}
        <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{yeuCau.nhan}</label>
        {yeuCau.nhieuDong ? (
          <textarea ref={o as any} rows={4} value={giaTri} placeholder={yeuCau.goiY} style={{ width: "100%" }}
            onChange={(e) => { setGiaTri(e.target.value); setLoi(""); }} />
        ) : (
          <input ref={o as any} value={giaTri} placeholder={yeuCau.goiY} style={{ width: "100%" }}
            onChange={(e) => { setGiaTri(e.target.value); setLoi(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") void gui(); }} />
        )}
        {loi && <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--red,#b91c1c)" }}>{loi}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button type="button" className="rowbtn" onClick={dong}>Huỷ</button>
          <button type="button" className={yeuCau.nguyHiem ? "rowbtn" : "primary"} onClick={() => void gui()}
            style={yeuCau.nguyHiem ? { background: "var(--red,#b91c1c)", color: "#fff", borderColor: "var(--red,#b91c1c)", fontWeight: 700 } : undefined}>
            {yeuCau.nutXacNhan ?? "Xác nhận"}
          </button>
        </div>
      </div>
    </div>
  );
}
