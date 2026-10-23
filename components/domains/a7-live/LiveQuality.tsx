// LIVE RISE — CHẤT LƯỢNG PHÁT (③) + LUỒNG THEO ĐƠN VỊ (④).
//
// ⚠ BÀI HỌC V67.4 (Chủ Rise Group hỏi "601 lần gián đoạn có chính xác không?"):
// Con số 601 ĐÚNG về số học nhưng SAI về ý nghĩa — nó gộp chung hai thứ rất khác nhau:
//   · 511/519 lần là đường truyền CHỚP rồi tự nối lại trong 0–5 giây (trung bình 4,2s).
//     Nguyên nhân: Broken pipe (397) / Connection reset (85) — YouTube hoặc đường truyền tự ngắt.
//     Với luồng RTMP chạy 24/7 thì đây là HÀNH VI BÌNH THƯỜNG của Internet, không phải hỏng hóc.
//   · 133/601 (22%) đến từ LUỒNG THỬ NGHIỆM (bật/tắt để nghịch) — không phản ánh vận hành thật.
// Hiện một con số to "601 lần gián đoạn" là CHỈ SỐ GÂY SỢ: đúng số nhưng khiến người đọc tưởng
// hệ đang hỏng nặng, trong khi thực tế mỗi luồng chỉ mất ~4 giây mỗi ngày.
//
// Vì vậy bảng này: tách CHỚP khỏi GIÁN ĐOẠN THẬT · loại luồng thử nghiệm (nói rõ đã loại mấy cái)
// · lấy TỔNG THỜI GIAN MẤT SÓNG làm số chính thay vì số lần · giải thích nguyên nhân bằng tiếng Việt.
//
// CHỈ ĐỌC — tính từ danh sách luồng ĐÃ TẢI SẴN. Không gọi thêm API, không đọc thêm Firestore.
"use client";
import { Card, Pill, Rail, RailQuiet } from "@/components/ui-primitives";

const fmtDur = (h: number) => h >= 24 ? `${Math.floor(h / 24)} ngày ${h % 24}h` : `${h}h`;
const isPrio = (s: any) => {
  const i = String(s.importance || (s.priority ? "priority" : "normal"));
  return i === "priority" || i === "critical";
};
// Luồng thử nghiệm: bật/tắt liên tục để nghịch → làm sai lệch thống kê vận hành. Loại ra, nhưng
// NÓI RÕ đã loại mấy cái để không ai nghi số bị giấu.
const isTest = (s: any) => /(^|[^a-z])test([^a-z]|$)|thử nghiệm|thử /i.test(String(s.name ?? ""));
// Ngưỡng: dưới mức này coi là "chớp" (khán giả gần như không nhận ra), trên là gián đoạn thật.
const BLIP_SEC = 30;

export function LiveQuality({ streams, machineName, scopeLabel }: {
  streams: any[]; machineName: (id: string) => string; scopeLabel?: string;
}) {
  const all = (streams ?? []) as any[];
  if (all.length === 0) return null;
  const testCount = all.filter(isTest).length;
  const list = all.filter((s) => !isTest(s));           // chỉ tính luồng vận hành thật
  if (list.length === 0) return null;

  const live = list.filter((s) => s.status === "live");
  const ups = live.filter((s) => s.liveSince).map((s) => Math.round((Date.now() - Date.parse(s.liveSince)) / 3600000));
  const avgUp = ups.length ? Math.round(ups.reduce((a, b) => a + b, 0) / ups.length) : 0;
  const maxUp = ups.length ? Math.max(...ups) : 0;
  const fresh = ups.filter((h) => h < 6).length;

  // Chi tiết gần đây (mỗi luồng giữ tối đa 10 lần)
  const recent = list.flatMap((s) => (Array.isArray(s.recentIncidents) ? s.recentIncidents : [])
    .map((e: any) => ({ ...e, machineId: s.machineId, streamName: s.name })));
  const blips = recent.filter((e: any) => (Number(e.downSec) || 0) <= BLIP_SEC);
  const realCuts = recent.filter((e: any) => (Number(e.downSec) || 0) > BLIP_SEC);
  const downSec = recent.reduce((n, e: any) => n + (Number(e.downSec) || 0), 0);
  const avgSec = recent.length ? (downSec / recent.length) : 0;

  // "Mỗi luồng mất sóng bao nhiêu giây mỗi ngày" — số dễ hiểu và trung thực hơn "số lần".
  const streamDays = live.filter((s) => s.liveSince)
    .reduce((n, s) => n + (Date.now() - Date.parse(s.liveSince)) / 86400000, 0);
  const secPerDay = streamDays > 0 ? downSec / streamDays : 0;

  // Nguyên nhân — dịch sang tiếng Việt cho người không đọc log kỹ thuật
  const causes: Record<string, number> = {};
  recent.forEach((e: any) => {
    const t = String(e.reason ?? "").toLowerCase();
    const k = t.includes("broken pipe") ? "Đường truyền tự đứt"
      : t.includes("connection reset") ? "YouTube ngắt kết nối"
      : t.includes("timed out") || t.includes("timeout") ? "Quá thời gian chờ"
      : t ? "Khác" : "";
    if (k) causes[k] = (causes[k] ?? 0) + 1;
  });
  const causeTop = Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 3);

  const byMachine: Record<string, number> = {};
  realCuts.forEach((e: any) => { const k = String(e.machineId ?? ""); if (k) byMachine[k] = (byMachine[k] ?? 0) + 1; });
  const worstMachine = Object.entries(byMachine).sort((a, b) => b[1] - a[1])[0];

  // ④ Gom theo ĐƠN VỊ
  //
  // 30/08/2026 — Chủ Rise Group hỏi: "đang live 4-5 luồng mà đây báo Ban lãnh đạo có 1 luồng?".
  // Nguyên nhân: bảng này ĂN THEO bộ lọc của phần Chất lượng phát, tức đã bỏ luồng có chữ
  // "test" trong tên. Bỏ luồng thử nghiệm khỏi thống kê GIÁN ĐOẠN là đúng (bật/tắt nghịch làm
  // lệch số), nhưng bảng ĐƠN VỊ trả lời câu hỏi khác: đội nào đang GÁNH bao nhiêu luồng — mà
  // luồng thử nghiệm vẫn chiếm máy, vẫn ăn băng thông. Nên bảng này đếm TOÀN BỘ, và ghi rõ
  // trong đó có mấy luồng thử nghiệm để không ai phải đoán.
  const units: Record<string, { total: number; live: number; prio: number; test: number }> = {};
  all.forEach((s) => {
    const k = String(s.createdByUnit ?? "").trim() || "(chưa gán đơn vị)";
    const u = units[k] ?? { total: 0, live: 0, prio: 0, test: 0 };
    u.total += 1;
    if (s.status === "live") u.live += 1;
    if (isPrio(s)) u.prio += 1;
    if (isTest(s)) u.test += 1;
    units[k] = u;
  });
  const unitRows = Object.entries(units).sort((a, b) => b[1].total - a[1].total);
  const grand = all.length;
  const chuaGan = units["(chưa gán đơn vị)"]?.total ?? 0;

  return (
    <>
      <Card title="📈 Chất lượng phát" action={<span style={{ fontSize: 12, color: "var(--muted)" }}>{scopeLabel ? `tính trên ${scopeLabel}` : ""}</span>}>
        {/* DẢI PHẲNG thay cho 5 thẻ hộp (30/08/2026 — Chủ Rise Group duyệt bản mẫu). Thứ nào bằng 0
            gộp vào MỘT dòng mờ thay vì mỗi cái một hộp to. */}
        <div style={{ margin: "0 0 11px" }}>
          <Rail icon="〰️" tone={secPerDay > 300 ? "red" : secPerDay > 60 ? "amber" : "green"}
            value={secPerDay >= 60 ? `${(secPerDay / 60).toFixed(1)} phút` : `${secPerDay.toFixed(1)} giây`}
            label="mất sóng mỗi ngày" desc="— trung bình mỗi luồng" />
          <Rail icon="⏱️" value={fmtDur(avgUp)} label="phát liên tục, trung bình"
            desc={`— ${live.length} luồng đang phát · bền nhất ${fmtDur(maxUp)}`} />
          {realCuts.length > 0 && <Rail icon="✂️" tone="amber" value={String(realCuts.length)} label="gián đoạn thật"
            desc={`— trên ${BLIP_SEC} giây, cần để ý${worstMachine ? ` · nhiều nhất: ${machineName(worstMachine[0])} (${worstMachine[1]} lần)` : ""}`} />}
          {fresh > 0 && <Rail icon="🔁" tone="amber" value={String(fresh)} label="luồng vừa bật lại"
            desc="— trong 6 giờ qua, mới sập hoặc mới bật" />}
          {realCuts.length === 0 && fresh === 0 && <RailQuiet text={`Không có gián đoạn thật nào, không luồng nào vừa phải bật lại`} />}
        </div>

        {/* MỘT CÂU KẾT LUẬN thay cho khối chữ dài. Người trực cần biết "đường truyền có ổn không",
            phần giảng giải vì-sao vẫn giữ đủ nhưng nằm sau một dòng bấm. */}
        <div style={{ display: "flex", alignItems: "center", gap: 9, borderRadius: 10, padding: "10px 12px", fontSize: 13, fontWeight: 600,
          background: realCuts.length > 0 ? "var(--soft-amber)" : "var(--soft-green)", color: realCuts.length > 0 ? "var(--amber)" : "var(--green)" }}>
          <span>{realCuts.length > 0 ? "⚠️" : "✓"}</span>
          <span>{realCuts.length > 0
            ? <>Có {realCuts.length} lần gián đoạn thật (trên {BLIP_SEC} giây) — xem chi tiết ở Nhật ký</>
            : <>Đường truyền đang tốt — mọi lần chớp đều tự nối lại dưới {BLIP_SEC} giây</>}</span>
        </div>
        <details style={{ marginTop: 9 }}>
          <summary style={{ fontSize: 12.5, color: "var(--blue)", fontWeight: 600, cursor: "pointer" }}>
            Vì sao chớp rồi tự nối lại là bình thường · số liệu dựa trên đâu ↓
          </summary>
          <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.7, marginTop: 8, display: "grid", gap: 6 }}>
            <div>
              🔄 <b>{blips.length} lần đường truyền chớp rồi tự nối lại</b> (dưới {BLIP_SEC} giây
              {recent.length ? `, trung bình ${avgSec.toFixed(1)} giây` : ""}) — khán giả gần như không nhận ra.
              {causeTop.length ? <> Nguyên nhân: {causeTop.map(([k, v]) => `${k} (${v})`).join(" · ")}.</> : null}
            </div>
            <div>
              Với luồng chạy 24/7, việc kết nối tự đứt rồi nối lại là <b>hành vi bình thường của Internet</b>,
              không phải máy yếu. Chỉ cần để ý khi có <b>gián đoạn thật</b> (trên {BLIP_SEC} giây) hoặc khi
              một máy/luồng lặp lại bất thường.
            </div>
            <div>
              <b>Số liệu dựa trên đâu:</b> tính từ <b>{BLIP_SEC > 0 ? recent.length : 0} lần gần nhất</b> (hệ giữ tối đa
              10 lần mỗi luồng){testCount > 0 ? <> · đã <b>loại {testCount} luồng thử nghiệm</b> khỏi thống kê vận hành</> : null}.
              Đủ để thấy chỗ đang có vấn đề, nhưng <b>chưa đủ để so tuần này với tuần trước</b> — nên ở đây
              cố ý <b>không vẽ xu hướng</b> thay vì đưa ra con số không chắc.
            </div>
          </div>
        </details>
      </Card>

      <Card title="👥 Luồng theo đơn vị" action={<span style={{ fontSize: 12, color: "var(--muted)" }}>{grand} luồng</span>}>
        <small className="block" style={{ color: "var(--muted)", marginBottom: 8 }}>
          Đội nào đang gánh nhiều luồng nhất, và bao nhiêu trong đó <b>chưa được bảo vệ</b> (luồng “Thường”
          không có bản dự phòng — máy gặp sự cố là mất sóng cho tới khi có người xử tay).
          <br />Bảng này đếm <b>toàn bộ luồng</b>, kể cả luồng thử nghiệm (bảng Chất lượng phát ở trên thì
          bỏ luồng thử nghiệm ra, nên hai bảng có thể lệch số).
          {chuaGan > 0 ? <> <b>“Chưa gán đơn vị”</b> là luồng tạo từ trước khi hệ ghi lại đơn vị người tạo —
          không phải lỗi phát sóng, chỉ là thiếu nhãn.</> : null}
        </small>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                {["Đơn vị", "Luồng", "Đang phát", "Ưu tiên", "Chưa bảo vệ"].map((h, i) => (
                  <th key={h} style={{ textAlign: i ? "right" : "left", padding: "8px 9px", fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--muted)", borderBottom: "1px solid var(--border,#e7ecf2)", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {unitRows.map(([name, u]) => {
                const unprotected = u.total - u.prio;
                return (
                  <tr key={name} style={{ borderBottom: "1px solid var(--border,#eef2f6)" }}>
                    <td style={{ padding: "8px 9px" }}>
                      <b>{name}</b>
                      <span style={{ display: "block", marginTop: 3, height: 5, borderRadius: 4, background: "var(--border,#e7ecf2)", overflow: "hidden", maxWidth: 170 }}>
                        <span style={{ display: "block", height: "100%", width: `${Math.round((u.total / grand) * 100)}%`, background: "var(--rl,#0e8f84)" }} />
                      </span>
                      <small style={{ color: "var(--muted)", fontSize: 11 }}>{Math.round((u.total / grand) * 100)}% tổng số luồng</small>
                    </td>
                    <td style={{ padding: "8px 9px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {u.total}
                      {u.test > 0 ? <small className="block" style={{ color: "var(--muted)", fontSize: 11, fontWeight: 400 }}>{u.test} thử nghiệm</small> : null}
                    </td>
                    <td style={{ padding: "8px 9px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{u.live}</td>
                    <td style={{ padding: "8px 9px", textAlign: "right" }}>{u.prio > 0 ? <Pill tone="green">{u.prio}</Pill> : <small style={{ color: "var(--muted)" }}>0</small>}</td>
                    <td style={{ padding: "8px 9px", textAlign: "right" }}>{unprotected > 0 ? <Pill tone="amber">{unprotected}</Pill> : <small style={{ color: "var(--muted)" }}>—</small>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
