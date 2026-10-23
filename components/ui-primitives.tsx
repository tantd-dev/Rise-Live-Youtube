"use client";
import { useState, useEffect, type ReactNode } from "react";

// Điện thoại? (để bảng đổi sang layout THẺ cho dễ đọc, không cuộn ngang / vỡ chữ).
function useIsMobile(bp = 720) {
  const [m, setM] = useState(false);
  useEffect(() => {
    const check = () => setM(typeof window !== "undefined" && window.innerWidth < bp);
    check(); window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [bp]);
  return m;
}

// Thanh phân trang dùng chung: chọn số hàng/trang + X–Y/Tổng + nút Trang đầu/Trước/Sau/Trang cuối.
// Thay cho kiểu "Xem thêm" — mọi danh sách dài dùng cái này cho nhất quán.
export function Pager({ total, page, perPage, onPage, onPerPage, options = [10, 20, 30, 50, 100], label = "Số hàng mỗi trang:" }: {
  total: number; page: number; perPage: number;
  onPage: (p: number) => void; onPerPage: (n: number) => void;
  options?: number[]; label?: string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const cur = Math.min(Math.max(1, page), totalPages);
  const from = total === 0 ? 0 : (cur - 1) * perPage + 1;
  const to = Math.min(cur * perPage, total);
  return (
    <div className="pager">
      <label>{label}
        <select value={perPage} onChange={(e) => onPerPage(Number(e.target.value))}>
          {options.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <div className="pager-right">
        <span className="pager-info">{from}–{to}/{total}</span>
        <div className="pager-nav">
          <button className="rowbtn" disabled={cur <= 1} onClick={() => onPage(1)} title="Trang đầu">|‹</button>
          <button className="rowbtn" disabled={cur <= 1} onClick={() => onPage(cur - 1)} title="Trang trước">‹</button>
          <span className="pager-cur">{cur}/{totalPages}</span>
          <button className="rowbtn" disabled={cur >= totalPages} onClick={() => onPage(cur + 1)} title="Trang sau">›</button>
          <button className="rowbtn" disabled={cur >= totalPages} onClick={() => onPage(totalPages)} title="Trang cuối">›|</button>
        </div>
      </div>
    </div>
  );
}

export function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <article className="card">
      <div className="cardhead">
        <h2>{title}</h2>
        <span className="cardmeta">{action}</span>
      </div>
      {children}
    </article>
  );
}

export function Pill({ tone, children, title }: { tone: string; children: React.ReactNode; title?: string }) {
  return <span className={`pill ${tone}`} title={title}>{children}</span>;
}

export function Field({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={wide ? "wide" : ""}>
      {label}
      {children}
    </label>
  );
}

export function Table({
  heads,
  rows,
  defaultVisible = 10,
  sortValues,
}: {
  heads: string[];
  rows: React.ReactNode[][];
  defaultVisible?: number;
  // Giá trị "thô" để sắp xếp — song song với rows (cùng thứ tự dòng/cột),
  // dùng cột nào để trống (null) thì cột đó không bấm sắp xếp được. Không
  // truyền prop này thì bảng giữ nguyên hành vi cũ (không sắp xếp được),
  // không ảnh hưởng các chỗ khác đang dùng Table.
  sortValues?: (string | number | null)[][];
}) {
  // Phân trang thay cho "Xem thêm": chọn số hàng/trang + nút đầu/trước/sau/cuối (không phải bấm bung).
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(defaultVisible && defaultVisible > 20 ? defaultVisible : 20);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const isMobile = useIsMobile();

  let orderedRows = rows;
  if (sort && sortValues) {
    orderedRows = rows
      .map((r, i) => ({ r, key: sortValues[i]?.[sort.col] ?? null }))
      .sort((a, b) => {
        if (a.key === null && b.key === null) return 0;
        if (a.key === null) return 1;
        if (b.key === null) return -1;
        if (typeof a.key === "number" && typeof b.key === "number") return (a.key - b.key) * sort.dir;
        return String(a.key).localeCompare(String(b.key), "vi") * sort.dir;
      })
      .map((x) => x.r);
  }

  const total = orderedRows.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const cur = Math.min(page, totalPages);
  const shown = total > perPage ? orderedRows.slice((cur - 1) * perPage, cur * perPage) : orderedRows;
  // ── ĐIỆN THOẠI: mỗi dòng = 1 THẺ, mỗi ô có NHÃN cột (dễ đọc, không cuộn ngang / vỡ chữ) ──
  if (isMobile) {
    return (
      <div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {shown.map((r, i) => (
            <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "11px 13px", background: "var(--card)", display: "flex", flexDirection: "column", gap: 6 }}>
              {r.map((c, j) => {
                if (c === null || c === undefined || c === "" || c === false) return null;   // ô rỗng → bỏ
                const label = heads[j];
                return (
                  <div key={j} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 13, flexWrap: "wrap" }}>
                    {label ? <span style={{ color: "var(--muted)", fontWeight: 700, fontSize: 11, minWidth: 96, flex: "0 0 auto" }}>{label}</span> : null}
                    <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{c}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {total > perPage && <Pager total={total} page={cur} perPage={perPage} onPage={setPage} onPerPage={(n) => { setPerPage(n); setPage(1); }} />}
      </div>
    );
  }
  return (
    <div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              {heads.map((h, i) => {
                const canSort = Boolean(sortValues) && sortValues!.some((row) => row[i] !== null && row[i] !== undefined);
                return (
                  <th
                    key={h || `col-${i}`}
                    className={canSort ? "sortable" : ""}
                    onClick={
                      canSort
                        ? () => setSort((prev) => (prev?.col === i ? { col: i, dir: (prev.dir * -1) as 1 | -1 } : { col: i, dir: 1 }))
                        : undefined
                    }
                  >
                    {h}
                    {canSort && sort?.col === i ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > perPage && <Pager total={total} page={cur} perPage={perPage} onPage={setPage} onPerPage={(n) => { setPerPage(n); setPage(1); }} />}
    </div>
  );
}

// ── DẢI CHỈ SỐ PHẲNG (30/08/2026 — Chủ Rise Group duyệt bản mẫu) ────────────────────────────
//
// VÌ SAO BỎ KIỂU THẺ HỘP. Đo trên chính màn Tổng quan thật:
//  · Mỗi chỉ số một hộp to mà nội dung tí xíu nằm sát trái → phần còn lại trắng trơn. Chủ Rise
//    Group gọi đúng tên: "nhìn mấy ô trắng trống trơn chứ mấy cái hộp".
//  · SÁU ô rỗng nghĩa (0 luồng lỗi · 0-0 cảnh báo · 0 chờ Vòng 2 · 0 chờ Vòng 3 · 0 đã đánh giá ·
//    0 nghỉ hôm nay) chiếm chỗ NGANG BẰNG ô 121/121. Số 0 hét to như số quan trọng.
//  · Hộp lồng hộp: mỗi nhóm một khối có viền, bên trong lại các hộp có viền → hai lớp khung.
//
// NAY: một khối cho cả nhóm, các dòng ngăn bằng đường kẻ mảnh. Số 0 chìm xuống màu mờ, số cần
// chú ý mới có màu. Ba dải gộp lại từ 15 hộp còn 3 khối — màn ngắn hẳn, đỡ phải cuộn.
// GIỮ NGUYÊN: nguồn dữ liệu, con số, và đường bấm sang màn chi tiết (mỗi dòng vẫn bấm được).
export function Rail({ icon, tone = "ink", value, label, desc, onClick }: {
  icon: string; tone?: "ink" | "green" | "amber" | "red" | "muted";
  value?: ReactNode; label?: string; desc?: ReactNode; onClick?: () => void;
}) {
  const col = tone === "green" ? "var(--green)" : tone === "amber" ? "var(--amber)"
    : tone === "red" ? "var(--red)" : tone === "muted" ? "var(--muted)" : "var(--ink)";
  return (
    <button type="button" onClick={onClick} className="ck-rail" data-clickable={onClick ? "1" : undefined} style={{
      width: "100%", textAlign: "left", background: "transparent", border: 0,
      borderBottom: "1px solid var(--line)", padding: "13px 0", color: "var(--ink)",
      cursor: onClick ? "pointer" : "default",
      display: "flex", alignItems: "baseline", gap: 11, flexWrap: "wrap",
    }}>
      <span style={{ fontSize: 15, width: 19, textAlign: "center", flex: "none", color: col }}>{icon}</span>
      {value != null && <b className="tnum" style={{ fontSize: 20, fontWeight: 800, color: col, letterSpacing: "-.01em" }}>{value}</b>}
      {label && <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>}
      {desc && <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{desc}</span>}
    </button>
  );
}
// Dòng "không có gì" — gom mọi mục rỗng nghĩa vào ĐÚNG MỘT dòng mờ thay vì mỗi cái một hộp.
export function RailQuiet({ text, onClick }: { text: string; onClick?: () => void }) {
  return <Rail icon="✓" tone="muted" desc={text} onClick={onClick} />;
}
