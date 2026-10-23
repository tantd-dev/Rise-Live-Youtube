// RISE LIVE R1.2 — GIAO DIỆN điều khiển (Admin/BLĐ). 3 khu: Luồng phát · Kho video · Máy live.
// Mục tiêu: BẤM NÚT, không gõ lệnh. Đọc/ghi qua /api/live (sau cờ RISE_WORK_LIVE).
"use client";
import { useEffect, useState, useRef, Fragment } from "react";
import { Card, Pill, Field, Pager, Rail, RailQuiet } from "@/components/ui-primitives";
import { YoutubeConnect } from "./YoutubeConnect";
import { LiveLogsTabs } from "./LiveLogs";   // V64.90 — tab "Nhật ký": sự cố + chuyển máy (phân trang)
import { INCIDENT_CATALOG, HANDLED_BY_LABEL, type HandledBy } from "@/lib/live-incident-catalog";
import { OrphanBackups } from "@/components/domains/a7-live/OrphanBackups";
import { LiveQuality } from "@/components/domains/a7-live/LiveQuality";
import { HopNhapChu, type YeuCauNhap } from "@/components/shared/HopNhapChu";

type Tab = "overview" | "streams" | "incidents" | "assets" | "machines" | "perms" | "codes";
const money = (n: number) => Math.round(Number(n) || 0);
// Nhãn độ phân giải từ chiều cao khung hình; low=true nếu dưới 1080 (để làm nổi cảnh báo).
const resLabel = (w: number, h: number): { t: string; low: boolean } => {
  h = Number(h) || 0; if (!h) return { t: "—", low: false };
  const t = h >= 2160 ? "4K" : h >= 1440 ? "1440p" : h >= 1080 ? "1080p" : h >= 720 ? "720p" : `${h}p`;
  return { t, low: h < 1080 };
};
// ISO → "HH:mm dd/mm" (giờ Việt Nam) cho hiển thị lịch.
const fmtWhen = (iso: string) => {
  if (!iso) return "";
  try { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0");
    const vn = new Date(d.getTime() + (7 * 60 + d.getTimezoneOffset()) * 60000);
    return `${p(vn.getHours())}:${p(vn.getMinutes())} ${p(vn.getDate())}/${p(vn.getMonth() + 1)}`;
  } catch { return ""; }
};

// LÝ DO luồng rớt (từ stderr ffmpeg) → dịch sang tiếng Việt dễ hiểu + CÁCH KHẮC PHỤC (bảng sự cố gọn).
// `ncc` = tên nhà cung cấp THẬT của máy gặp sự cố. Trước đây câu gợi ý ghi cứng "netcup" — nhưng
// 4/5 máy là Lowendviet, chỉ VPS 01 là Netcup, nên nó chỉ người ta sang trang quản trị SAI nhà cung
// cấp (Chủ Rise Group phát hiện 30/08/2026 khi sự cố ở VPS 05 mà gợi ý bảo vào netcup).
function incidentCause(reason?: string, ncc?: string): { label: string; fix: string } {
  const r = String(reason ?? "").toLowerCase();
  const nhaCC = String(ncc ?? "").trim();
  if (!r) return { label: "", fix: "" };
  if (/chặn|đình chỉ|không còn phát công khai|không có buổi phát|nghi bị/.test(r)) return { label: "YouTube chặn/đình chỉ", fix: "Vào YouTube Studio kiểm tra buổi phát/kênh (bản quyền, đình chỉ, kết thúc sớm). Nếu ổn, Lên sóng lại." };
  if (/reset by peer|broken pipe|connection refused|epipe|end of file|closed|eof/.test(r)) return { label: "YouTube/mạng ngắt kết nối", fix: "Thường tự nối lại được. Nếu lặp nhiều: kiểm tra Khoá luồng còn đúng (YouTube Studio) + đường mạng VPS." };
  if (/network is unreachable|failed to resolve|name or service|timed out|timeout|no route|temporary failure/.test(r)) return { label: "Mạng VPS gián đoạn", fix: `Kiểm tra mạng / trang quản trị VPS${nhaCC ? ` (${nhaCC})` : ""} xem có nghẽn hay mất kết nối không.` };
  if (/invalid data|moov atom|decod|corrupt|no such file|invalid argument/.test(r)) return { label: "File video lỗi", fix: "Kiểm tra lại video nguồn; thử tải/nén lại rồi tạo luồng mới." };
  if (/403|401|unauthorized|forbidden|permission/.test(r)) return { label: "YouTube từ chối khoá", fix: "Khoá luồng có thể sai/hết hạn — lấy lại khoá mới trong YouTube Studio rồi Sửa luồng." };
  return { label: "Lỗi phát", fix: "Xem lý do kỹ thuật (di chuột). Nếu lặp nhiều lần: kiểm tra khoá + mạng." };
}

// Giây → "Xd Yh", "Xh Ym", "Xm" — hiển thị "đã chạy bao lâu" (live time). Cộng thêm thời gian
// từ nhịp heartbeat cuối để số nhích thật (worker báo mỗi ~10s).
const fmtUptime = (sec: number): string => {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  if (sec < 60) return `${sec}s`;
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}n ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

// "Còn gánh được bao nhiêu luồng ở mức chất lượng này" — theo băng thông đo/nhập của máy,
// chừa dự phòng (safety), trừ số luồng đang chạy. Trả null nếu chưa có băng thông.
// ═══ NGƯỠNG AN TOÀN BĂNG THÔNG (Chủ Rise Group chốt 27/08/2026) ═══
// Máy đã chạm 70% băng thông thì KHÔNG nhận thêm luồng LIVE nữa.
// ⚠ CHỈ chặn việc LIVE. KHÔNG chặn tải video lên để SAO LƯU dự phòng — vì bản sao lưu chỉ nằm trên
// ổ, không phát sóng, nên không tốn Mbps nào. (Chủ Rise chỉ ra đúng chỗ này.)
// Cách hiển thị theo ý bro: VẪN HIỆN máy đó trong danh sách nhưng KHÔNG CHỌN ĐƯỢC, để người dùng
// biết máy tồn tại và đang đầy — thay vì ẩn đi làm người ta tưởng mất máy.
const BW_SAFE_PCT = 0.70;
const bwOfMachine = (m: any) => {
  const max = Number(m?.uploadMbps) || 0;
  if (max <= 0) return null;                       // chưa nhập trần → không kết luận được
  const used = m?.txMbps != null ? Number(m.txMbps) : null;
  if (used == null || !Number.isFinite(used)) return null;
  return { max, used, pct: used / max, conMbps: Math.max(0, max * BW_SAFE_PCT - used) };
};
// true = máy đã chạm ngưỡng, không cho thêm luồng live
const bwFull = (m: any) => { const b = bwOfMachine(m); return !!b && b.pct >= BW_SAFE_PCT; };
const bwLabel = (m: any) => {
  const b = bwOfMachine(m);
  if (!b) return "";
  return b.pct >= BW_SAFE_PCT
    ? ` · ⛔ băng thông ${Math.round(b.pct * 100)}% — KHÔNG nhận thêm luồng`
    : ` · băng thông còn ${Math.round(b.conMbps)} Mbps`;
};


function streamsLeft(machine: any, preset: any, safety: number): number | null {
  const up = Number(machine?.uploadMbps) || 0; const per = Number(preset?.bandwidthMbps) || 0;
  if (up <= 0 || per <= 0) return null;
  // Băng thông ĐANG dùng: ưu tiên số THỰC (txMbps từ worker) → real-time; nếu chưa có thì ước
  // lượng theo số luồng đang chạy × mức/luồng.
  const usedMbps = machine?.txMbps != null ? Number(machine.txMbps) : (Number(machine?.liveCount) || 0) * per;
  return Math.max(0, Math.floor((up * safety - usedMbps) / per));
}

// Sức khoẻ = tín hiệu L2 (tiến trình + luồng dữ liệu), CHƯA phải sức khoẻ phía YouTube (L3).
// Worker báo good/starting/error; giữ thêm excellent/poor/nodata cho tương thích. Nhãn trung thực,
// KHÔNG gọi "khỏe hoàn toàn" khi chưa có L3.
const HEALTH: Record<string, { t: string; tone: any }> = {
  good: { t: "Tín hiệu ổn", tone: "green" }, excellent: { t: "Tín hiệu ổn", tone: "green" },
  starting: { t: "Đang khởi động", tone: "amber" }, poor: { t: "Tín hiệu yếu", tone: "amber" },
  error: { t: "Máy phát lỗi", tone: "red" }, nodata: { t: "Mất tín hiệu", tone: "gray" }, unknown: { t: "—", tone: "gray" },
};
const STATUS: Record<string, { t: string; tone: any }> = {
  queued: { t: "Chờ chạy", tone: "gray" }, starting: { t: "Đang khởi động", tone: "amber" },
  live: { t: "Đang phát", tone: "green" }, stopping: { t: "Đang dừng", tone: "amber" },
  stopped: { t: "Đã dừng", tone: "gray" }, error: { t: "Lỗi", tone: "red" },
};
const ASSET_STATUS: Record<string, { t: string; tone: any }> = {
  pending: { t: "Chờ xử lý", tone: "gray" }, downloading: { t: "Đang tải", tone: "amber" },
  // "waiting" (worker r2.34) = ĐANG XẾP HÀNG TẢI, khác hẳn "queued" = đang chờ tới lượt NÉN.
  // Trước đây cả hai đều rơi vào một chữ "Chờ xử lý" đứng im, người thêm video không biết máy đang
  // làm gì — video treo 30 phút mà tưởng hệ thống hỏng (Chủ Rise gặp 29–30/08/2026).
  waiting: { t: "Đang xếp hàng tải", tone: "gray" },
  queued: { t: "Đang chờ nén", tone: "gray" }, normalizing: { t: "Đang nén", tone: "amber" }, ready: { t: "Sẵn sàng", tone: "green" }, error: { t: "Lỗi", tone: "red" },
};
// ── BẢN CÔNG CỤ TẢI DRIVE trên từng máy (V71.18) ────────────────────────────────────────────────
// Vì sao có mục này: sự cố 29–30/08/2026 — VPS 06 mới dựng chạy yt-dlp bản 2022, tải Drive chậm 56
// lần khả năng thật của chính nó, SUỐT MỘT NGÀY không ai biết vì máy vẫn báo Online, vẫn xanh, không
// một dấu hiệu nào. Phát hiện được chỉ vì Chủ Rise Group tình cờ thấy tải lâu. Nay bản công cụ hiện
// ngay cạnh bản agent, và máy nào lệch thì nhuộm đỏ.
//
// KHÔNG ghim cứng một con số bản nào — hôm nay đúng, ba tháng nữa sai. Thay vào đó lấy bản MỚI NHẤT
// mà chính đàn máy đang chạy làm mốc: máy nào thấp hơn mốc đó là máy bị bỏ lại phía sau.
function banCongCuMoiNhat(machines: any[]): string {
  return machines.map((m: any) => String(m?.ytdlpVersion ?? "")).filter(Boolean).sort().pop() ?? "";
}
function congCuMay(m: any, banMoiNhat: string) {
  if (!m?.agentVersion) return null;                       // máy chưa từng báo về → chưa nói gì được
  const ban = String(m.ytdlpVersion ?? "");
  const loi = String(m.toolError ?? "");
  const thieuGdown = m.gdownOk === false;
  const cu = !!(ban && banMoiNhat && ban < banMoiNhat);
  const xau = !ban || cu || thieuGdown || !!loi;
  if (!xau) return <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>yt-dlp {ban}</div>;
  const vi = !ban ? "CHƯA CÓ yt-dlp" : cu ? `yt-dlp ${ban} — CŨ (đàn đang dùng ${banMoiNhat})` : `yt-dlp ${ban}`;
  return (
    <div title={loi || "Tải video từ Drive trên máy này sẽ chậm hoặc hỏng. Xem mã lỗi RL-MED-015 để biết cách sửa."}
      style={{ fontSize: 10, color: "var(--red,#dc2626)", fontWeight: 700, marginTop: 2, whiteSpace: "normal" }}>
      ⚠ {vi}{thieuGdown ? " · thiếu gdown" : ""}
      {loi ? <div style={{ fontWeight: 400, marginTop: 1 }}>{loi.slice(0, 120)}</div> : null}
    </div>
  );
}

// Dòng phụ dưới ô trạng thái: tiến độ tải % / chỗ đứng trong hàng đợi. Trả "" khi không có gì để nói.
function tienDoTai(a: any): string {
  if (a?.status === "waiting") {
    const truoc = Number(a.queueAhead) || 0;
    return truoc > 0 ? `còn ${truoc} video trước` : "sắp tới lượt";
  }
  if (a?.status !== "downloading") return "";
  const pct = a.progressPct == null ? null : Number(a.progressPct);
  const da = Number(a.downloadedMb) || 0, tong = Number(a.totalMb) || 0;
  if (pct == null && !da) return "đang bắt đầu…";
  const phan = pct == null ? "" : `${pct}% · `;
  return tong > 0 ? `${phan}${Math.round(da)}/${Math.round(tong)} MB` : `${Math.round(da)} MB`;
}

// Đổi lỗi thô (thường từ gdown khi tải Drive) sang câu tiếng Việt rõ, gợi ý cách xử. Giữ lỗi gốc ở tooltip.
function friendlyAssetError(raw: string): string {
  const e = String(raw || "").toLowerCase();
  // THỨ TỰ QUAN TRỌNG — và đã sửa LẠI lần hai (30/08/2026). Lịch sử để không ai lặp lại:
  //  · Ban đầu ca "chưa mở quyền" nằm trước → khớp nhầm mọi thứ, cả đội đi kiểm quyền cả buổi trong
  //    khi quyền VẪN MỞ.
  //  · Sửa lần một (29/08) lại đổ cho "FILE QUÁ LỚN" — cũng SAI. Chủ Rise bác đúng: file 5,4 GB tải
  //    ngon lành cùng lúc với file nhỏ hơn bị chặn.
  //  · Nguyên nhân THẬT, xác minh bằng cách gọi thẳng Google: "Quota exceeded" — Google giới hạn lượt
  //    tải công khai THEO TỪNG FILE mỗi ngày, hết lượt thì khoá ~24 giờ rồi tự mở lại (30/08 các link
  //    hôm trước hỏng đã tải được bình thường). Không liên quan kích thước, quyền, hay file hỏng.
  // Nên HẠN MỨC phải soi TRƯỚC, vì nó phổ biến nhất và hay đội lốt hai lỗi kia.
  if (/quota|too many|many accesses|rate.?limit|try again later|han muc|hạn mức/.test(e))
    return "Google KHOÁ HẠN MỨC TẢI của riêng file này — file bị tải quá nhiều lượt trong ngày. KHÔNG phải lỗi quyền, cũng không phải file hỏng, và không liên quan file to hay nhỏ. Cách xử NHANH NHẤT: tạo một BẢN SAO của file trên Drive rồi dán link bản sao (bản sao có hạn mức riêng). Hoặc chờ khoảng 24 giờ Google tự mở lại. Hoặc dùng \"Tải video lên\" kéo-thả từ máy tính.";
  if (/permission|anyone with the link|access denied|request access|you need access|cannot retrieve the public link/.test(e))
    return "Drive chưa mở quyền tải: mở file trên Drive → Chia sẻ → chọn \"Bất kỳ ai có đường liên kết\" (vai Người xem), rồi thêm lại.";
  if (/virus|scan|confirm|from the browser/.test(e))
    return "Google trả về trang xác nhận \"không quét virus được\" (hay gặp với file lớn) và công cụ tải khựng ở đó. Quyền chia sẻ KHÔNG có vấn đề. Thử thêm lại một lần — bản worker mới tự bấm qua trang này. Vẫn hỏng thì dùng \"Tải video lên\" kéo-thả từ máy tính.";
  if (/not found|does not exist|no such|404|deleted/.test(e))
    return "Không tìm thấy file trên Drive (link sai, hoặc file đã xoá/di chuyển). Kiểm tra lại link.";
  if (/output format|muxer|invalid argument|encoder|conversion failed|nen that bai/.test(e))
    return "Nén/chuẩn hoá video thất bại (xem chi tiết bên dưới) — thử lại; nếu lặp lại báo kỹ thuật.";
  return "Xử lý video thất bại — xem \"Chi tiết lỗi\" bên dưới. Nếu tải từ Drive: kiểm tra link đã chia sẻ \"Ai có link\"; hoặc dùng \"Tải video lên\" (kéo-thả) cho chắc.";
}

export function RiseLive({ user, flash, active = true }: { user: any; flash?: (m: string) => void; active?: boolean }) {
  const [hoi, setHoi] = useState<YeuCauNhap | null>(null);   // hộp hỏi/nhập dùng chung
  // BẤM "Xem luồng" Ở Ô CẢNH BÁO PHẢI RA ĐÚNG NHỮNG LUỒNG ĐANG CẢNH BÁO (01/09/2026 — Chủ Rise
  // Group hỏi "bấm vào có ra đúng các luồng đó không?"). Trước đây nút này chỉ ĐỔI TAB, người
  // trực vẫn phải tự dò tên trong 163 luồng — đúng lúc đang gấp thì đó là việc tệ nhất.
  const [locCanhBao, setLocCanhBao] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [d, setD] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const activeRef = useRef(active); activeRef.current = active;   // module đang xem? (giữ mounted khi rời để upload SỐNG)

  const load = async () => {
    const x = await fetch("/api/live", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ error: "Lỗi mạng." }));
    setD(x); setLoading(false);
  };
  // Poll 20s (R1.4: giãn từ 12s để giảm read khi 300 luồng — CHỈ nhịp làm mới GIAO DIỆN dashboard, KHÔNG
  // liên quan worker/agent/watchdog phát hiện lỗi luồng ở máy chủ). TẠM DỪNG khi module bị ẩn HOẶC tab
  // trình duyệt chạy nền (document.hidden) — không tốn read lúc không ai nhìn. Quay lại → làm mới NGAY.
  const shown = () => activeRef.current && (typeof document === "undefined" || !document.hidden);

  // ── D-RL-03: MÁY CHỦ TỰ BÁO KHI CÓ THAY ĐỔI (thay vì màn hình hỏi lại mỗi 20 giây) ──
  // Lợi cho người dùng: bật/tắt luồng là thấy NGAY, không phải đợi hết nhịp.
  // Lợi cho chi phí: hết đọc lại toàn bộ danh sách mỗi 20 giây cho TỪNG người đang xem.
  //
  // AN TOÀN: nhịp hỏi lại VẪN CÒN, chỉ giãn ra làm lưới hứng. Kênh báo không chạy (chưa bật cờ,
  // mạng chặn, máy chủ lỗi) → tự quay về đúng nhịp 20 giây như cũ. Không có đường nào làm màn Live
  // đứng im. Máy chết cũng vẫn bắt được bằng nhịp hỏi lại, vì máy chết thì KHÔNG có thay đổi nào để báo.
  const [rt, setRt] = useState(false);          // kênh báo đang chạy?
  const lamMoiRef = useRef<any>(null);
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let es: EventSource | null = null, stopped = false, retry: any = null, nhoi: any = null;
    // Dồn nhiều thay đổi sát nhau thành MỘT lần làm mới — bật 10 luồng cùng lúc không nên gọi 10 lần.
    const lamMoiGon = () => { if (nhoi) return; nhoi = setTimeout(() => { nhoi = null; if (shown()) void load(); }, 1200); };
    lamMoiRef.current = lamMoiGon;
    const noi = () => {
      if (stopped) return;
      es = new EventSource("/api/live/realtime");
      es.addEventListener("hello", () => setRt(true));
      es.addEventListener("change", lamMoiGon);
      es.addEventListener("bye", () => { es?.close(); if (!stopped) retry = setTimeout(noi, 300); });
      es.onerror = () => {
        // Cờ tắt → route trả 404 → về nhịp cũ. Mạng chập chờn → thử lại thưa, không dội máy chủ.
        setRt(false); es?.close(); if (!stopped) retry = setTimeout(noi, 15000);
      };
    };
    noi();
    return () => { stopped = true; es?.close(); if (retry) clearTimeout(retry); if (nhoi) clearTimeout(nhoi); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── NHỊP HỎI LẠI THEO VIỆC ĐANG CÓ (V71.23) ────────────────────────────────────────────────
  // Đo thật 30/08/2026: mỗi lần hỏi lại đọc 441 bản ghi, và màn Live bị hỏi 387 lần/giờ → chiếm
  // ~180.000 lượt đọc/giờ, khoản TỐN NHẤT của cả Rise Live (~$75/tháng). Trong khi kênh đẩy đã báo
  // NGAY mọi thay đổi đáng kể rồi — nhịp hỏi lại chỉ còn là LƯỚI HỨNG phòng khi kênh đẩy hỏng.
  //
  // Ba nhịp, chọn theo việc đang có:
  //  · Kênh đẩy KHÔNG chạy      → 20 giây (y như cũ, không có lưới nào khác)
  //  · Có video ĐANG TẢI/xếp hàng → 20 giây — kênh đẩy CỐ Ý không báo phần trăm tải (báo thì video
  //    11 GB bắn tin mỗi 2 giây), nên phải tự hỏi mới thấy thanh tiến độ nhích. NHANH HƠN mức 60
  //    giây cũ, tức lúc cần nhìn thì mượt hơn trước.
  //  · Mọi thứ đứng yên + kênh đẩy chạy tốt → 120 giây. Đo được 279/279 video đang Sẵn sàng nên
  //    đây là trạng thái gần như thường trực.
  // Thứ CHẬM đi: mấy số đo tức thời không nằm trong kênh đẩy (tốc độ đẩy, bitrate, thời gian chạy)
  // cập nhật 2 phút/lần thay vì 1. Còn luồng lỗi / mất sóng / đổi máy / tụt tốc thì kênh đẩy báo
  // NGAY như cũ, không đợi nhịp nào.
  // Dùng GIÁ TRỊ boolean làm phụ thuộc, KHÔNG dùng mảng video: mảng đổi danh tính sau MỖI lần tải,
  // mà thân effect lại gọi tải → tải xong đổi mảng → effect chạy lại → tải tiếp… thành vòng lặp vô hạn
  // dội máy chủ. Boolean chỉ đổi khi thật sự có/hết việc, nên effect chỉ dựng lại đúng lúc cần.
  const coViec = ((d?.assets ?? []) as any[]).some((a: any) => a && a.status !== "ready" && a.status !== "error");
  const daTaiLanDau = useRef(false);
  useEffect(() => {
    if (!daTaiLanDau.current) { daTaiLanDau.current = true; void load(); }
    const nhip = !rt ? 20000 : (coViec ? 20000 : 120000);
    const t = setInterval(() => { if (shown()) void load(); }, nhip);
    return () => clearInterval(t);
  }, [rt, coViec]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active) void load(); }, [active]);
  // Deep-link: mở đúng tab khi vào từ "Việc cần xử lý" (VD luồng Live cần xử lý → tab Luồng phát).
  // Module này được giữ MOUNTED (để tải video chạy nền) nên effect chỉ-mount sẽ không nổ ở các lần
  // vào sau — vì vậy đọc lại khoá mỗi khi module hiện ra (active bật) rồi xoá khoá đi.
  useEffect(() => {
    if (!active) return;
    try { const t = sessionStorage.getItem("riseLiveTab"); if (t) { setTab(t as Tab); sessionStorage.removeItem("riseLiveTab"); } } catch { /* */ }
  }, [active]);
  // Tab trình duyệt hiện lại (chuyển app khác về, mở lại) → làm mới ngay để không xem số cũ.
  useEffect(() => {
    const onVis = () => { if (shown()) { void load(); void loadYt(); } };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    return () => { if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Batch 6 (B) — L3: lấy trạng thái YouTube theo KÊNH (kênh đã kết nối + đã nối) để hiện "YouTube xác nhận" cho từng luồng.
  const [ytByCh, setYtByCh] = useState<Record<string, any>>({});
  const loadYt = () => fetch("/api/live/youtube").then((r) => r.json()).then((j) => {
    if (j?.connections) { const m: Record<string, any> = {}; j.connections.forEach((c: any) => { if (c.riseChannelId) m[c.riseChannelId] = { youtubeState: c.youtubeState, connectionState: c.connectionState, hasControlScope: c.hasControlScope }; }); setYtByCh(m); }
  }).catch(() => {});
  useEffect(() => { void loadYt(); const t = setInterval(() => { if (shown()) void loadYt(); }, 60000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Chỉ những lệnh thực sự làm ĐỔI TRẠNG THÁI luồng/máy mới cần làm mới dồn dập.
  const LENH_DOI_TRANG_THAI = new Set(["start_stream", "stop_stream", "add_stream", "delete_stream",
    "update_stream", "move_stream", "set_machine_offline", "add_asset", "copy_asset", "delete_asset"]);
  const post = async (payload: any, ok?: string) => {
    setBusy(true);
    const r = await fetch("/api/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then((x) => x.json()).catch(() => ({ error: "Lỗi mạng." }));
    setBusy(false);
    if (r.error) { flash?.("⚠ " + r.error); return false; }
    // Cảnh báo preflight (không chặn) → gắn kèm câu báo thành công.
    const warn = Array.isArray(r.warnings) && r.warnings.length ? " ⚠ " + r.warnings.join(" · ") : "";
    // `note` = tin BÌNH THƯỜNG máy chủ muốn nói thêm (không phải cảnh báo). Ví dụ: video này máy khác
    // đã có nên hệ chép thẳng thay vì tải lại Drive — người dùng nên biết vì nó xong nhanh khác thường.
    const note = typeof r.note === "string" && r.note ? " · " + r.note : "";
    flash?.((ok ?? "Đã lưu.") + note + warn); await load();
    // LÀM MỚI DỒN DẬP SAU THAO TÁC (Chủ Rise Group 29/08: bấm Bật xong chờ khá lâu
    // mới thấy luồng chạy). Giao diện tự làm mới 20 giây/lần — nếu chỉ đợi nhịp đó
    // thì máy đã lên sóng rồi mà màn hình vẫn chưa biết. Nay sau mỗi thao tác làm
    // mới thêm ở giây 3 · 7 · 14 (máy chủ cũng đã rút nhịp hỏi của VPS xuống 3s).
    // Chỉ vài lượt đọc mỗi lần bấm — không đáng kể.
    if (LENH_DOI_TRANG_THAI.has(String(payload?.action ?? ""))) {
      [3000, 7000, 14000].forEach((ms) => setTimeout(() => { if (shown()) void load(); }, ms));
    }
    return true;
  };
  // Gọi API KHÔNG reload (để hiện khoá / thao tác im lặng) — trả JSON thô.
  const rawPost = async (payload: any) =>
    fetch("/api/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then((x) => x.json()).catch(() => ({ error: "Lỗi mạng." }));

  // TOKEN TẢI-LÊN lấy THEO YÊU CẦU (S0 bảo mật) — không còn nằm sẵn trong payload polling. Xin 1 lần
  // rồi nhớ lại cho phiên này (kéo-thả tải + xem lệnh cài dùng chung). forInstall=true để ghi audit rõ.
  const [uploadTok, setUploadTok] = useState<{ token: string; port: number } | null>(null);
  const ensureUploadTok = async (forInstall?: boolean): Promise<{ token: string; port: number } | null> => {
    if (uploadTok) return uploadTok;
    const r = await rawPost({ action: "upload_token", forInstall: !!forInstall });
    if (r?.token) { const v = { token: r.token as string, port: Number(r.port) || 8099 }; setUploadTok(v); return v; }
    flash?.("⚠ " + (r?.error || "Không lấy được token tải lên."));
    return null;
  };

  // TẢI VIDEO LÊN — chạy ở CẤP CAO NHẤT (không bị huỷ khi chuyển tab). Thanh tiến độ nổi.
  const [uploads, setUploads] = useState<any[]>([]);
  const uploadFile = async (file: File, presetId: string, targetUrl?: string) => {
    const cfg = d?.uploadConfig;
    const base = String(targetUrl || cfg?.httpsUrl || "").replace(/\/+$/, "");   // đích tải: máy được chọn, mặc định env
    if (!base) return;
    const tk = await ensureUploadTok();   // xin token đúng lúc tải (không phát sẵn mỗi lần polling)
    if (!tk?.token) return;
    const uid = `${Date.now()}-${file.name}-${file.size}`;
    const nm = file.name.replace(/\.[^.]+$/, "").slice(0, 120);
    setUploads((u) => [...u.filter((x) => x.id !== uid), { id: uid, name: nm, pct: 0, status: "uploading" }]);
    const upd = (patch: any) => setUploads((u) => u.map((x) => x.id === uid ? { ...x, ...patch } : x));
    const qs = new URLSearchParams({ token: tk.token, email: d.userEmail || "", preset: presetId, name: nm }).toString();
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${base}/upload?${qs}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) upd({ pct: Math.round((e.loaded * 100) / e.total) }); };
    xhr.onload = () => { const okr = xhr.status === 200; upd({ status: okr ? "done" : "error", pct: 100 }); if (okr) { flash?.("✅ Đã tải xong video: " + nm); setTimeout(load, 2500); setTimeout(() => setUploads((u) => u.filter((x) => x.id !== uid)), 6000); } else { flash?.("⚠ Tải video lỗi: " + nm); } };
    xhr.onerror = () => upd({ status: "error" });
    xhr.onabort = () => upd({ status: "cancelled" });
    upd({ status: "uploading", xhr });   // giữ tham chiếu xhr để HUỶ được
    xhr.send(file);
  };
  // Huỷ / dừng một lần tải: đang tải -> abort (dừng gửi ngay); xong/lỗi/đã huỷ -> gỡ khỏi danh sách.
  const cancelUpload = (uid: string) => setUploads((u) => u.map((x) => {
    if (x.id !== uid) return x;
    if (x.status === "uploading" && x.xhr) { try { x.xhr.abort(); } catch { /* ignore */ } return { ...x, status: "cancelled" }; }
    return null;   // đã dừng rồi -> đánh dấu gỡ
  }).filter(Boolean) as any[]);
  // Đang tải mà đóng/tải lại trang → CẢNH BÁO (tải qua trình duyệt không sống sót khi đóng app).
  useEffect(() => {
    if (!uploads.some((u) => u.status === "uploading")) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [uploads]);

  if (loading) return <p className="empty">Đang tải Live Rise…</p>;
  if (d?.error) return <p className="empty">{d.error}</p>;
  if (d && d.enabled === false) return (
    <Card title="📡 Live Rise">
      <p className="plain">Tính năng <b>Live Rise</b> đang <b>tắt</b>. Liên hệ quản trị hệ thống để bật. <span style={{ color: "var(--muted)", fontSize: 12 }}>(Kỹ thuật: đặt RISE_WORK_LIVE=1)</span></p>
    </Card>
  );

  const machines: any[] = d?.machines ?? [];
  const assets: any[] = d?.assets ?? [];
  const streams: any[] = d?.streams ?? [];
  const presets: any[] = d?.presets ?? [];
  const readyAssets = assets.filter((a) => a.status === "ready");
  const machineName = (id: string) => machines.find((m) => m.id === id)?.name ?? "—";
  // Tên NHÀ CUNG CẤP thật của máy — để câu gợi ý xử lý sự cố chỉ đúng trang quản trị.
  const nccMay = (id: string) => String(machines.find((m) => m.id === id)?.provider ?? "").trim();
  const assetName = (id: string) => assets.find((a) => a.id === id)?.name ?? "—";
  const presetLabel = (id: string) => presets.find((p) => p.id === id)?.label ?? id;

  const navItem = (id: Tab, icon: string, label: string, n = 0) => (
    <button className={"rl-item" + (tab === id ? " on" : "")} onClick={() => setTab(id)}>
      <span className="rl-ic">{icon}</span><span className="rl-lb">{label}</span>{n > 0 && <span className="rl-n">{n}</span>}
    </button>
  );

  return (
    <div className="rl-shell">
      <HopNhapChu yeuCau={hoi} dong={() => setHoi(null)} />
      <style>{`
        .rl-shell{--rl:#0e8f84;--rl-soft:#dcf1ef;display:flex;gap:18px;align-items:flex-start;max-width:100%;box-sizing:border-box}
        .rl-shell *{box-sizing:border-box}
        .rl-nav{flex:0 0 208px;position:sticky;top:8px;display:flex;flex-direction:column;gap:2px;background:var(--surface,#fff);border:1px solid var(--border,#e7ecf2);border-radius:14px;padding:12px 10px}
        .rl-brand{display:flex;align-items:center;gap:8px;font-weight:750;font-size:15px;letter-spacing:-.01em;padding:4px 8px 8px;color:var(--ink,#1a2230)}
        .rl-brand .dot{width:8px;height:8px;border-radius:50%;background:#e0334b;box-shadow:0 0 0 3px rgba(224,51,75,.15)}
        .rl-group{font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted,#7a8697);padding:12px 8px 5px}
        .rl-item{display:flex;align-items:center;gap:9px;width:100%;text-align:left;border:none;background:none;cursor:pointer;padding:8px 10px;border-radius:9px;font-size:13.7px;font-weight:600;color:var(--ink,#1a2230);line-height:1.3}
        .rl-item:hover{background:var(--surface2,#f5f8fa)}
        .rl-item.on{background:var(--rl-soft);color:var(--rl)}
        .rl-item .rl-ic{font-size:15px;width:18px;text-align:center;flex:none}
        .rl-item .rl-lb{flex:1}
        .rl-item .rl-n{font-size:11px;font-weight:700;background:var(--surface2,#eef2f6);color:var(--muted,#7a8697);border-radius:999px;padding:1px 7px;min-width:20px;text-align:center}
        .rl-item.on .rl-n{background:var(--rl);color:#fff}
        .rl-main{flex:1;min-width:0;max-width:100%}
        .rl-cards{display:flex;flex-direction:column;gap:10px}
        .rl-card{border:1px solid var(--border,#e7ecf2);border-radius:12px;padding:12px;background:var(--surface,#fff)}
        /* ═══ R-LAYOUT Đợt 2 — THẺ LUỒNG (máy tính) ═══
           Nguyên tắc chống tràn: mọi vùng chữ đặt minWidth:0 + cắt bằng dấu … ⇒ hết chỗ thì
           CHỮ co lại, KHUNG không nở. Không đặt min-width cứng cho hàng. */
        .rl-rows{display:flex;flex-direction:column;gap:6px}
        .rl-row{border:1px solid var(--border,#e7ecf2);border-radius:11px;background:var(--surface,#fff);overflow:hidden}
        .rl-row.bad{border-left:3px solid #dc2626}
        .rl-row.warn{border-left:3px solid #d97706}
        .rl-row.open{border-color:var(--rl,#0e8f84)}
        .rl-row-top{display:grid;grid-template-columns:26px 58px minmax(0,1fr) minmax(0,auto) auto;gap:10px;align-items:center;padding:8px 11px;cursor:pointer}
        .rl-row-top:hover{background:var(--surface2,#f6f9fb)}
        .rl-seq{font-size:11.5px;font-weight:700;color:var(--muted,#7a8697);text-align:center;font-variant-numeric:tabular-nums}
        .rl-th{width:58px;height:33px;display:block;flex:none;border-radius:6px;overflow:hidden;background:var(--surface2,#eef2f6)}
        .rl-idn{min-width:0}
        .rl-idn b{display:block;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .rl-idn small{display:block;color:var(--muted,#7a8697);font-size:11.5px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .rl-stat{min-width:0;display:flex;flex-direction:column;gap:3px;align-items:flex-end}
        .rl-chips{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
        .rl-metrics{color:var(--muted,#7a8697);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;font-variant-numeric:tabular-nums}
        .rl-acts{display:flex;gap:6px;align-items:center;flex:none}
        .rl-go{border:none;background:var(--rl-soft,#dcf1ef);color:var(--rl,#0e8f84);font-size:12px;font-weight:700;border-radius:8px;padding:7px 11px;cursor:pointer;white-space:nowrap;text-decoration:none;display:inline-block}
        .rl-go-off{background:transparent;color:var(--muted,#7a8697);cursor:default}
        .rl-more{border:1px solid var(--border,#e7ecf2);background:transparent;color:var(--muted,#7a8697);font-weight:800;border-radius:8px;padding:6px 9px;cursor:pointer;line-height:1}
        .rl-more:hover{background:var(--surface2,#f0f4f8)}
        .rl-row-detail{border-top:1px solid var(--border,#e7ecf2);padding:11px 13px 12px;background:var(--surface2,#f8fafc)}
        .rl-dl{display:grid;grid-template-columns:128px minmax(0,1fr);gap:6px 12px;font-size:12.5px;align-items:start}
        .rl-dl .k{color:var(--muted,#7a8697);font-size:11.5px;font-weight:700}
        .rl-dl .v{min-width:0;overflow-wrap:anywhere}
        .rl-dbtn{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:9px;padding-top:9px;border-top:1px dashed var(--border,#e7ecf2)}
        .rl-grouphead{cursor:pointer;background:var(--rl-soft,#eef7f6);border-radius:8px;padding:8px 12px;font-weight:700;font-size:13px}
        @media(max-width:820px){
          .rl-row-top{grid-template-columns:24px minmax(0,1fr) auto;gap:8px}
          .rl-th{display:none}
          .rl-stat{align-items:flex-start}
          .rl-metrics{display:none}
          .rl-dl{grid-template-columns:1fr;gap:2px 0}
          .rl-dl .k{margin-top:6px}
        }
        /* CHẾ ĐỘ TỐI cho khối CSS riêng này */
        .rise-dark .rl-row{background:#111c2e;border-color:#22304a}
        .rise-dark .rl-row-top:hover{background:#182740}
        .rise-dark .rl-row-detail{background:#0f1a2b;border-top-color:#22304a}
        .rise-dark .rl-more{border-color:#22304a}
        .rise-dark .rl-more:hover{background:#182740}
        .rise-dark .rl-th{background:#182740}
        /* ═══ KHO VIDEO trên ĐIỆN THOẠI — bảng 9 cột thì chắc chắn tràn ngang ═══
           Chủ Rise Group gặp thật: phải vuốt sang ngang mới thao tác hết được.
           Cách xử: trên máy nhỏ ẨN các cột phụ (người tải · thời gian · độ phân giải · chất lượng
           · máy · dung lượng) và dồn thông tin quan trọng thành MỘT DÒNG PHỤ ngay dưới tên.
           Giữ lại đúng 3 cột cần thao tác: Tên · Trạng thái · nút. Máy tính giữ nguyên đủ cột. */
        .rl-sub{display:none}
        @media(max-width:760px){
          .rl-assets th:nth-child(2),.rl-assets td:nth-child(2),
          .rl-assets th:nth-child(3),.rl-assets td:nth-child(3),
          .rl-assets th:nth-child(4),.rl-assets td:nth-child(4),
          .rl-assets th:nth-child(5),.rl-assets td:nth-child(5),
          .rl-assets th:nth-child(6),.rl-assets td:nth-child(6),
          .rl-assets th:nth-child(8),.rl-assets td:nth-child(8){display:none}
          .rl-assets td:first-child{white-space:normal}
          .rl-assets td:first-child b{max-width:100%!important;white-space:normal!important}
          /* PHAI co !important: o nut co whiteSpace:"nowrap" viet THANG trong the,
             kieu noi tuyen luon thang CSS -> khong co !important thi o nut van khong
             xuong dong va day tran ngang (Chu Rise gap thuc te 29/08). */
          .rl-assets td:last-child{white-space:normal!important}
          .rl-assets td:last-child button{margin-bottom:3px}
          .rl-assets td:last-child select,.rl-assets td:last-child button{max-width:100%}
          .rl-assets{width:100%;table-layout:fixed}
          .rl-assets td,.rl-assets th{word-break:break-word}
          .rl-sub{display:block;color:var(--muted,#7a8697);font-size:11.5px;font-weight:400;margin-top:2px}
        }
        .rl-nav-mobile{display:none}
        @media(max-width:760px){
          .rl-shell{flex-direction:column;gap:12px}
          .rl-nav{display:none}
          .rl-nav-mobile{display:block;width:100%;padding:11px 13px;border-radius:12px;border:1px solid var(--border,#e7ecf2);background:var(--surface,#fff);font-size:15px;font-weight:700;color:var(--ink,#1a2230)}
        }
        /* ═══ CHẾ ĐỘ TỐI ═══
           GỐC LỖI (V65.1 trở về trước): .rl-shell tự đặt --rl/--rl-soft bằng màu SÁNG cố định.
           .rl-shell nằm TRONG .rise-dark nên định nghĩa tại chỗ này ĐÈ LÊN màu tối của chủ đề
           -> nền xanh nhạt + chữ sáng = mất chữ (thấy rõ nhất ở đầu nhóm "Theo kênh").
           Sửa tận gốc: lật chính 2 biến đó khi ở nền Tối -> mọi chỗ dùng chúng tự đúng,
           không phải vá từng nơi. */
        .rise-dark .rl-shell{--rl:#2dd4bf;--rl-soft:#10231f}
        .rise-dark .rl-grouphead{color:var(--ink)}
      `}</style>
      <select className="rl-nav-mobile" value={tab} onChange={(e) => setTab(e.target.value as Tab)} aria-label="Chọn khu Live Rise">
        {[["overview", "📊 Tổng quan", 0], ["streams", "🔴 Luồng & Lịch", streams.length], ["incidents", "🛠 Nhật ký", 0], ["assets", "🎞 Nguồn video", assets.length],
          ...(d?.canInfra ? [["machines", "🖥 Máy live", machines.length]] : []),
          ...(d?.canGrant ? [["perms", "🔐 Phân quyền", 0]] : []), ["codes", "📖 Mã lỗi", 0]].map(([id, lb, n]) => (
          <option key={id as string} value={id as string}>{lb}{(n as number) > 0 ? ` (${n})` : ""}</option>
        ))}
      </select>
      <aside className="rl-nav">
        <div className="rl-brand"><span className="dot"></span>Live Rise</div>
        <div className="rl-group">Vận hành</div>
        {navItem("overview", "📊", "Tổng quan")}
        {navItem("streams", "🔴", "Luồng & Lịch", streams.length)}
        {navItem("incidents", "🛠", "Nhật ký", streams.filter((s: any) => s.needsHuman || s.restartHalted || s.ytIssue).length)}
        {navItem("assets", "🎞", "Nguồn video", assets.length)}
        {(d?.canInfra || d?.canGrant) && <>
          <div className="rl-group">Kỹ thuật</div>
          {d?.canInfra && navItem("machines", "🖥", "Máy live", machines.length)}
          {d?.canGrant && navItem("perms", "🔐", "Phân quyền")}
        </>}
        <div className="rl-group">Tra cứu</div>
        {navItem("codes", "📖", "Mã lỗi")}
      </aside>
      <main className="rl-main">
        {tab === "overview" && <YoutubeConnect flash={flash} />}
        {d?.scopeLabel && d.scopeLabel !== "toàn công ty" && (
          <p className="plain" style={{ margin: "0 0 12px", fontSize: 12.5 }}>👁 Bạn đang xem <b>luồng {d.scopeLabel}</b> (máy dùng chung để biết còn chỗ). Admin/Ban lãnh đạo xem toàn công ty.</p>
        )}
        {tab === "overview" && <OverviewPanel d={d} machines={machines} presets={presets} safety={d?.safetyFactor ?? 0.7} onGo={setTab} locTheoCanhBao={(ids: string[]) => { setLocCanhBao(ids); setTab("streams"); }} post={post} busy={busy} reload={load} streams={streams} machineName={machineName} />}
        {tab === "overview" && d?.canInfra && <LiveCostEstimate streams={streams} machines={machines} assets={assets} cadence={d?.cadence} />}
        {tab === "streams" && <StreamsPanel locCanhBao={locCanhBao} boLocCanhBao={() => setLocCanhBao([])} d={d} streams={streams} readyAssets={readyAssets} machines={machines} presets={presets} machineName={machineName} assetName={assetName} presetLabel={presetLabel} safety={d?.safetyFactor ?? 0.7} post={post} rawPost={rawPost} busy={busy} flash={flash} ytByCh={ytByCh} afterControl={() => { void load(); void loadYt(); }} />}
        {tab === "incidents" && <LiveLogsTabs machineName={machineName} machines={machines} isAdmin={user?.role === "admin"} flash={flash} openPanel={<IncidentLogPanel streams={streams} machineName={machineName} incidentLog={[]} />} />}
        {tab === "assets" && <AssetsPanel d={d} assets={assets} machines={machines} presets={presets} machineName={machineName} presetLabel={presetLabel} safety={d?.safetyFactor ?? 0.7} post={post} rawPost={rawPost} busy={busy} flash={flash} reload={load} uploadFile={uploadFile} uploadTok={uploadTok} ensureUploadTok={ensureUploadTok} streams={streams} canInfra={!!d?.canInfra} />}
        {tab === "machines" && d?.canInfra && d?.failoverOff && (
          <div style={{ marginBottom: 12, padding: "11px 14px", borderRadius: 12,
            border: "1px solid " + (d.failoverOff.disabled ? "var(--red,#dc2626)" : "var(--border,#e7ecf2)"),
            background: d.failoverOff.disabled ? "rgba(220,38,38,.07)" : "var(--card,#f8fafc)" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <b style={{ fontSize: 13.5, color: d.failoverOff.disabled ? "var(--red,#b91c1c)" : "var(--ink)" }}>
                {d.failoverOff.disabled ? "⛔ Cơ chế TỰ CỨU đang TẮT" : "🛟 Cơ chế tự cứu đang bật"}
              </b>
              <button className="rowbtn" disabled={busy} onClick={() => {
                if (d.failoverOff.disabled) { if (confirm("Bật lại cơ chế tự cứu?\n\nTừ giờ luồng ưu tiên sẽ lại được tự chuyển máy khi máy gặp sự cố.")) void post({ action: "set_failover_off", off: false }, "Đã bật lại cơ chế tự cứu."); return; }
                setHoi({
                  tieuDe: "⛔ TẮT KHẨN cơ chế tự cứu", nhan: "Lý do tắt", batBuoc: true, nhieuDong: true,
                  moTa: "Luồng đang phát VẪN PHÁT bình thường, cảnh báo VẪN CHẠY — chỉ dừng phần tự chuyển máy khi máy gặp sự cố.",
                  goiY: "VD: đang bảo trì mạng, không muốn luồng nhảy máy",
                  nutXacNhan: "Tắt khẩn", nguyHiem: true,
                  xong: (ly: string) => void post({ action: "set_failover_off", off: true, reason: ly }, "Đã TẮT cơ chế tự cứu — luồng đang phát không bị ảnh hưởng."),
                });
              }} style={{ fontWeight: 700, color: d.failoverOff.disabled ? "var(--green,#16a34a)" : "var(--red,#b91c1c)" }}>
                {d.failoverOff.disabled ? "▶ Bật lại" : "⛔ Tắt khẩn"}
              </button>
            </div>
            <p className="plain" style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--muted)" }}>
              {d.failoverOff.disabled
                ? `Tắt bởi ${d.failoverOff.by ?? "—"}${d.failoverOff.reason ? " · lý do: " + d.failoverOff.reason : ""}. Máy chết sẽ KHÔNG được tự cứu cho tới khi bật lại.`
                : "Dùng khi cơ chế tự chuyển máy chạy sai và cần dừng NGAY. Chỉ dừng phần tự chuyển — luồng đang phát vẫn phát, cảnh báo vẫn chạy."}
            </p>
          </div>
        )}
        {tab === "machines" && d?.canInfra && <MachinesPanel machines={machines} streams={streams} post={post} busy={busy} canInfra={!!d?.canInfra} uploadToken={uploadTok?.token} ensureUploadTok={ensureUploadTok} cluster={d?.clusterCapacity} history={d?.moveHistory} assets={assets} />}
        {tab === "perms" && d?.canGrant && <PermissionsPanel post={post} busy={busy} />}
        {tab === "codes" && <CodesPanel />}
      </main>
      {uploads.length > 0 && (
        <div style={{ position: "fixed", right: 18, bottom: 18, zIndex: 50, width: 300, maxWidth: "90vw", background: "var(--surface,#fff)", border: "1px solid var(--border,#e2e7ee)", borderRadius: 12, boxShadow: "0 10px 30px rgba(16,24,40,.18)", padding: "10px 12px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "var(--ink,#1a2230)" }}>📤 Đang tải lên ({uploads.filter((u) => u.status === "uploading").length}) — đổi tab/module vẫn chạy, xong sẽ báo (đừng đóng app)</div>
          {uploads.slice(-4).map((u: any) => (
            <div key={u.id} style={{ marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, color: "var(--muted)", gap: 6 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{u.name}</span>
                <span style={{ whiteSpace: "nowrap" }}>{u.status === "done" ? "✅" : u.status === "error" ? "❌" : u.status === "cancelled" ? "⛔ đã huỷ" : u.pct + "%"}</span>
                <button onClick={() => cancelUpload(u.id)} title={u.status === "uploading" ? "Huỷ tải" : "Gỡ khỏi danh sách"} style={{ border: "none", background: "none", cursor: "pointer", color: u.status === "uploading" ? "#dc2626" : "var(--muted)", fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
              </div>
              <div style={{ height: 5, background: "var(--surface2,#e5edf7)", borderRadius: 4, overflow: "hidden", marginTop: 2 }}><div style={{ width: `${u.pct}%`, height: "100%", background: u.status === "error" || u.status === "cancelled" ? "#dc2626" : "var(--rl,#0e8f84)", transition: "width .2s" }} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── PHÂN QUYỀN RISE LIVE (chỉ Admin) — gán 5 GÓI quyền cho từng người, có phạm vi + hiệu lực ──
function PermissionsPanel({ post, busy }: any) {
  const [data, setData] = useState<any>(null);
  const [sel, setSel] = useState("");
  const [pkgs, setPkgs] = useState<string[]>([]);
  const [scope, setScope] = useState("assigned_channels");
  const [ef, setEf] = useState(""); const [et, setEt] = useState("");
  const [q, setQ] = useState(""); const [unitF, setUnitF] = useState("");
  const load = async () => {
    const r = await fetch("/api/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "list_live_permissions" }) }).then((x) => x.json()).catch(() => null);
    if (r?.ok) setData(r);
  };
  useEffect(() => { void load(); }, []);
  // MẶC ĐỊNH THEO CÂY CÔNG TY (gợi ý sẵn khi mở 1 người chưa gán — bro chỉnh tuỳ ý trước khi Lưu):
  //  Trưởng/Trưởng phòng → Vận hành + Quản lý phạm vi (đơn vị); Phó nhóm → Vận hành + Quản lý phạm
  //  vi (đội mình); Nhân viên → chỉ Vận hành kênh (kênh được giao). Vai trò khác → để trống.
  const roleDefault = (role: string): { pkgs: string[]; scope: string } => {
    if (role === "lead" || role === "head") return { pkgs: ["operate", "scope"], scope: "unit" };
    if (role === "deputy") return { pkgs: ["operate", "scope"], scope: "unit" };
    if (role === "employee") return { pkgs: ["operate"], scope: "assigned_channels" };
    return { pkgs: [], scope: "assigned_channels" };
  };
  const pick = (email: string) => {
    setSel(email);
    const a = (data?.assignments ?? []).find((x: any) => x.email === email);
    if (a) { setPkgs(a.packages ?? []); setScope(a.scope ?? "assigned_channels"); setEf(a.effectiveFrom ?? ""); setEt(a.effectiveTo ?? ""); return; }
    // Chưa gán → gợi ý sẵn theo vai trò (không tự lưu — chỉ tích sẵn để bấm nhanh).
    const c = (data?.candidates ?? []).find((x: any) => x.email === email);
    const d = roleDefault(String(c?.role ?? "")); setPkgs(d.pkgs); setScope(d.scope); setEf(""); setEt("");
  };
  const toggle = (id: string) => setPkgs((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
  const save = async () => { if (sel && await post({ action: "set_live_permissions", email: sel, packages: pkgs, scope, effectiveFrom: ef, effectiveTo: et }, "Đã lưu quyền Live Rise.")) await load(); };
  const scopeLabels: Record<string, string> = { self: "Chỉ mình", assigned_channels: "Kênh được giao", unit: "Đơn vị", descendant_units: "Đơn vị + cấp dưới", company: "Toàn công ty", explicit_channels: "Kênh chỉ định" };
  return (
    <>
      {data && !data.perms2On && (
        <div style={{ marginBottom: 12, padding: "9px 13px", background: "var(--soft-amber,#fdf3e3)", border: "1px solid var(--line,#f0c98a)", borderRadius: 10, fontSize: 12.5, color: "var(--amber,#92500a)" }}>
          ⚠ Phân quyền chi tiết <b>đang TẮT</b> (an toàn). Gán gói ở đây được lưu sẵn nhưng <b>chưa có hiệu lực</b> cho tới khi quản trị bật chế độ phân quyền chi tiết. Ai chưa gán vẫn giữ quyền như hiện tại.
        </div>
      )}
      <Card title="🔐 Gán gói quyền cho người dùng">
        <p className="plain" style={{ marginTop: 0, fontSize: 13 }}>Gán <b>gói quyền</b> (không phải bật từng quyền lẻ). Cấp gói là người đó <b>vào được Live Rise</b> ngay (tự hiện menu). Gói sau bao gồm gói trước.</p>
        {data && data.canGrantAll === false && (
          <p className="plain" style={{ marginTop: -4, marginBottom: 8, fontSize: 12.5, color: "var(--rl,#0e8f84)", fontWeight: 600 }}>
            Bạn là Trưởng nhóm/phòng: chỉ cấp <b>Vận hành / Quản lý phạm vi</b> cho người <b>trong phạm vi mình quản lý</b>. Gói Kỹ thuật/Quản trị do Admin cấp.
          </p>
        )}
        {(() => {
          const cands: any[] = data?.candidates ?? [];
          const units = Array.from(new Set(cands.map((c) => c.unit).filter(Boolean))).sort((a: any, b: any) => String(a).localeCompare(String(b), "vi"));
          const ql = q.trim().toLowerCase();
          const filtered = cands.filter((c) => (!unitF || c.unit === unitF) && (!ql || String(c.name).toLowerCase().includes(ql) || String(c.email).toLowerCase().includes(ql)));
          const selName = cands.find((c) => c.email === sel)?.name;
          return (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <input placeholder="🔎 Tìm tên hoặc email…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 220px", padding: "8px 11px", border: "1px solid var(--border,#e2e7ee)", borderRadius: 8, fontSize: 13.5 }} />
                <select value={unitF} onChange={(e) => setUnitF(e.target.value)} style={{ flex: "0 1 210px", padding: "8px 11px", borderRadius: 8 }}>
                  <option value="">Tất cả đơn vị ({cands.length})</option>
                  {units.map((u: any) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--border,#eef2f7)", borderRadius: 10 }}>
                {filtered.length === 0 ? <p className="empty" style={{ margin: 0, padding: 14 }}>Không tìm thấy ai khớp.</p> : filtered.map((c: any) => {
                  const assigned = (data?.assignments ?? []).some((a: any) => a.email === c.email);
                  return (
                    <button key={c.email} onClick={() => pick(c.email)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", border: "none", borderTop: "1px solid var(--border,#f2f4f7)", background: sel === c.email ? "var(--rl-soft,#dcf1ef)" : "transparent", cursor: "pointer", padding: "8px 12px", fontSize: 13.5 }}>
                      <span style={{ flex: 1 }}><b>{c.name}</b> <small style={{ color: "var(--muted)" }}>· {c.role}{c.unit ? " · " + c.unit : ""}</small></span>
                      {assigned && <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--rl,#0e8f84)" }}>đã gán</span>}
                    </button>
                  );
                })}
              </div>
              {sel && (
                <div style={{ marginTop: 12, padding: "12px 14px", background: "var(--card,#f8fafc)", border: "1px solid var(--border,#eef2f7)", borderRadius: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>Gán cho: {selName} <small style={{ color: "var(--muted)", fontWeight: 400 }}>({sel})</small></div>
                  <div className="form">
                    <Field label="Phạm vi"><select value={scope} onChange={(e) => setScope(e.target.value)}>{(data?.scopes ?? []).map((s: string) => <option key={s} value={s}>{scopeLabels[s] ?? s}</option>)}</select></Field>
                    <Field label="Hiệu lực từ (tuỳ chọn)"><input type="date" value={ef ? String(ef).slice(0, 10) : ""} onChange={(e) => setEf(e.target.value)} /></Field>
                    <Field label="Hiệu lực đến (tuỳ chọn)"><input type="date" value={et ? String(et).slice(0, 10) : ""} onChange={(e) => setEt(e.target.value)} /></Field>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    {(data?.packages ?? []).map((p: any) => (
                      <label key={p.id} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "7px 0", borderTop: "1px solid var(--border,#f2f4f7)", cursor: "pointer", fontSize: 13.5 }}>
                        <input type="checkbox" checked={pkgs.includes(p.id)} onChange={() => toggle(p.id)} style={{ marginTop: 3 }} />
                        <span><b>{p.label}</b><br /><small style={{ color: "var(--muted)" }}>{p.desc}</small></span>
                      </label>
                    ))}
                    <button className="primary small" disabled={busy} onClick={save} style={{ marginTop: 12 }}>Lưu quyền</button>
                    {pkgs.length === 0 && <small style={{ color: "#d97706", marginLeft: 10 }}>(Bỏ hết gói = gỡ khỏi hệ mới → về mặc định tương thích cũ)</small>}
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </Card>

      <Card title="📋 Đang gán">
        {(data?.assignments ?? []).length === 0 ? <p className="empty" style={{ margin: 0 }}>Chưa gán ai (mọi người dùng mặc định tương thích cũ).</p> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Người</th><th>Gói</th><th>Phạm vi</th><th>Hiệu lực</th></tr></thead>
              <tbody>
                {(data?.assignments ?? []).map((a: any) => (
                  <tr key={a.email}>
                    <td><b>{a.email}</b></td>
                    <td>{(a.packages ?? []).map((id: string) => (data?.packages ?? []).find((p: any) => p.id === id)?.label ?? id).join(", ") || "—"}</td>
                    <td>{scopeLabels[a.scope] ?? a.scope}</td>
                    <td style={{ fontSize: 12 }}>{a.effectiveFrom ? `từ ${String(a.effectiveFrom).slice(0, 10)}` : ""}{a.effectiveTo ? ` đến ${String(a.effectiveTo).slice(0, 10)}` : (a.effectiveFrom ? "" : "không hạn")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ── TỔNG QUAN ────────────────────────────────────────────────────────────────
function Kpi({ label, value, tone, sub, onClick }: any) {
  return (
    <div onClick={onClick} style={{ flex: "1 1 150px", minWidth: 140, background: "var(--card,#f8fafc)", border: "1px solid var(--border,#eef2f7)", borderRadius: 12, padding: "12px 14px", cursor: onClick ? "pointer" : "default" }}
      onMouseEnter={onClick ? (e) => { (e.currentTarget as HTMLElement).style.borderColor = tone; } : undefined}
      onMouseLeave={onClick ? (e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border,#eef2f7)"; } : undefined}>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>{label}{onClick ? <span style={{ float: "right", opacity: .45 }}>›</span> : null}</div>
      <b style={{ fontSize: 24, color: tone }}>{value}</b>
      {sub ? <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{sub}</div> : null}
    </div>
  );
}
function OverviewPanel({ d, machines, presets, safety, onGo, locTheoCanhBao, post, busy, reload, streams = [], machineName }: any) {
  const [moCanhBao, setMoCanhBao] = useState(false); // xo het canh bao tai cho
  const o = d?.overview ?? {}; const alerts: any[] = d?.alerts ?? [];
  // preset "gọn nhất" (bandwidth thấp nhất) để ước lượng sức chứa còn lại tổng.
  const cheapest = [...presets].sort((a, b) => (a.bandwidthMbps || 0) - (b.bandwidthMbps || 0))[0];
  const crit = alerts.filter((a: any) => a.level === "critical"); const warns = alerts.filter((a: any) => a.level === "warn");
  return (
    <>
      {alerts.length > 0 && (
        <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 12, background: crit.length ? "var(--soft-red,#fef2f2)" : "var(--soft-amber,#fffbeb)", border: "1px solid " + (crit.length ? "var(--line,#fca5a5)" : "var(--line,#fcd34d)") }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15 }}>{crit.length ? "🚨" : "⚠️"}</span>
            <b style={{ color: crit.length ? "var(--red,#b91c1c)" : "var(--amber,#b45309)", fontSize: 14 }}>Cần chú ý ngay</b>
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{crit.length ? `${crit.length} nghiêm trọng` : ""}{crit.length && warns.length ? " · " : ""}{warns.length ? `${warns.length} cảnh báo` : ""}</span>
            {/* Lấy mã luồng từ chính các cảnh báo (dấu vân tay có dạng "loại:mã"), chỉ giữ mã
                khớp với luồng đang có → bấm là ra ĐÚNG những luồng đó. Cảnh báo cấp MÁY (tải
                chậm, công cụ hỏng…) không có luồng nào để mở nên nút đổi thành "Xem máy". */}
            {(() => {
              const idLuong = Array.from(new Set(alerts
                .map((a: any) => String(a?.fingerprint ?? "").split(":").slice(1).join(":"))
                .filter((id: string) => id && streams.some((s: any) => s.id === id))));
              return idLuong.length > 0
                ? <button className="rowbtn" onClick={() => locTheoCanhBao?.(idLuong)} style={{ marginLeft: "auto" }}>Xem {idLuong.length} luồng đang cảnh báo</button>
                : <button className="rowbtn" onClick={() => onGo(d?.canInfra ? "machines" : "streams")} style={{ marginLeft: "auto" }}>{d?.canInfra ? "Xem máy" : "Xem luồng"}</button>;
            })()}
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: crit.length ? "#7f1d1d" : "#78350f" }}>
            {/* Chu Rise 28/08: "26 su co nhung an vao khong doc duoc het" — dong
                "…va 24 muc nua" tro sang tab khac rat kho lan. Nay bam MOT phat
                xo het tai cho, nghiem trong xep truoc. */}
            {((): any => {
              const ds = [...crit, ...warns];
              const hien = moCanhBao ? ds : ds.slice(0, 2);
              return <>
                {hien.map((a: any, i: number) => <div key={i} style={{ marginBottom: 3 }}>• {a.text}</div>)}
                {ds.length > 2 ? (
                  <button onClick={() => setMoCanhBao((v: boolean) => !v)}
                    style={{ border: "none", background: "none", padding: 0, marginTop: 4, cursor: "pointer", fontWeight: 700, fontSize: 12.5, color: crit.length ? "#991b1b" : "#92400e", textDecoration: "underline" }}>
                    {moCanhBao ? "Thu gọn ↑" : `Xem đủ ${ds.length} cảnh báo ↓`}
                  </button>
                ) : null}
              </>;
            })()}
          </div>
        </div>
      )}
      {/* ── DẢI TRẠNG THÁI HỆ (30/08/2026 — Chủ Rise Group duyệt bản mẫu) ────────────────────────
          Trước đây 4 thẻ hộp rời: mỗi hộp một số nhỏ nằm sát trái, phần còn lại trắng trơn — và
          "0 đang chuẩn bị" / "0 cảnh báo" chiếm chỗ NGANG BẰNG "121/121". Số 0 hét to như số quan
          trọng. Nay một khối, các dòng ngăn bằng đường kẻ; thứ nào bằng 0 gộp vào MỘT dòng mờ.
          THÊM: mức băng thông toàn hệ + máy sát trần nhất — số duy nhất trong bảng máy mà người
          trực cần liếc mỗi ngày (cả bảng vẫn ở dưới, không dời lên).
          Dòng giải thích "kênh đã kết nối YouTube" xuống làm chân dải: nó KHÔNG BAO GIỜ đổi, không
          đáng chiếm chỗ ngay trên các con số. */}
      {(() => {
        const cc = d?.clusterCapacity;
        const tai = Number(cc?.clusterLoadPct);
        const caps: any[] = Array.isArray(cc?.machines) ? cc.machines : [];
        const nang = caps.filter((c: any) => c.online && !c.maintenance).sort((a: any, b: any) => (Number(b.loadPct) || 0) - (Number(a.loadPct) || 0))[0];
        const proc = o.assetsProcessing ?? 0, aErr = o.assetsError ?? 0;
        const cTong = (o.alertsCritical ?? 0) + (o.alertsWarn ?? 0);
        const yen = proc === 0 && aErr === 0 && cTong === 0;
        return (
          <div className="card" style={{ padding: "4px 16px", marginBottom: 12 }}>
            <Rail icon="📡" tone={(o.streamsDesiredLive ?? 0) > (o.streamsLive ?? 0) ? "amber" : "green"}
              value={`${o.streamsLive ?? 0}${o.streamsDesiredLive ? " / " + o.streamsDesiredLive : ""}`} label="luồng đang phát"
              desc={(o.streamsDesiredLive ?? 0) > (o.streamsLive ?? 0) ? `— thiếu ${(o.streamsDesiredLive ?? 0) - (o.streamsLive ?? 0)} luồng so với đặt phát` : "— đủ, không thiếu luồng nào"}
              onClick={() => onGo("streams")} />
            <Rail icon="🖥️" tone={(o.machinesOnline ?? 0) < (o.machinesTotal ?? 0) ? "amber" : "ink"}
              value={`${o.machinesOnline ?? 0} / ${o.machinesTotal ?? 0}`} label="máy phát online"
              desc={`— ${o.assetsReady ?? 0} video sẵn sàng`}
              onClick={d?.canInfra ? () => onGo("machines") : undefined} />
            {Number.isFinite(tai) && (
              <Rail icon="📶" tone={tai >= 0.85 ? "red" : tai >= 0.7 ? "amber" : "ink"}
                value={`${Math.round(tai * 100)}%`} label="băng thông toàn hệ"
                desc={nang ? `— máy sát nhất: ${nang.name ?? "?"} ${Math.round((Number(nang.loadPct) || 0) * 100)}%` : undefined}
                onClick={d?.canInfra ? () => onGo("machines") : undefined} />
            )}
            {proc > 0 && <Rail icon="⏳" tone="amber" value={`${proc}`} label="video đang chuẩn bị" desc="— đang tải hoặc nén" onClick={() => onGo("assets")} />}
            {aErr > 0 && <Rail icon="🎬" tone="amber" value={`${aErr}`} label="video lỗi" desc="— không dùng phát được" onClick={() => onGo("assets")} />}
            {yen && <RailQuiet text="Không có cảnh báo, không có video đang chuẩn bị, không có video lỗi" />}
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--muted)", padding: "9px 0 11px", marginTop: 2, borderTop: "1px dashed var(--line)" }}>
              <span>ℹ️</span><span>Kênh <b style={{ color: "var(--ink)" }}>đã kết nối YouTube</b> được xác minh trạng thái thật từ YouTube. Kênh chưa kết nối chỉ theo dõi máy phát và đường truyền.</span>
            </div>
          </div>
        );
      })()}

      {/* ③ + ④ — Chất lượng phát & Luồng theo đơn vị. Tính từ danh sách luồng ĐÃ TẢI SẴN,
          không thêm lượt đọc nào. Đặt trên cảnh báo vì đây là bức tranh tổng, cảnh báo là chi tiết. */}
      <LiveQuality streams={streams} machineName={machineName} scopeLabel={d?.scopeLabel} />

      {/* KHÔNG CÓ CẢNH BÁO THÌ KHÔNG CHIẾM CHỖ (30/08/2026 — Chủ Rise Group hỏi "ô cảnh báo nên đặt
          ở đâu"). Trước đây có HAI chỗ cùng tên "cảnh báo": một khối đỏ/vàng nhảy lên đầu khi có sự
          cố, và thẻ này nằm giữa trang chỉ để nói "không có cảnh báo". Nay gộp làm một: có cảnh báo
          thì hiện ở đầu trang; không có thì đã nói ở dòng mờ trong dải trạng thái, khỏi lặp lại. */}
      {alerts.length > 0 && (
      <Card title="⚠️ Cảnh báo & sự cố" action={<Pill tone="red">{alerts.length}</Pill>}>
        {(
          <div>
            {alerts.map((a: any, i: number) => {
              const sev = a.severity || (a.level === "critical" ? "CRITICAL" : "WARNING");
              const sevMap: Record<string, { t: string; tone: any }> = {
                EMERGENCY: { t: "KHẨN CẤP", tone: "red" }, CRITICAL: { t: "Nghiêm trọng", tone: "red" },
                WARNING: { t: "Cảnh báo", tone: "amber" }, INFO: { t: "Ghi nhận", tone: "gray" },
              };
              const sv = sevMap[sev] ?? sevMap.WARNING;
              return (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 0", borderTop: i ? "1px solid var(--border,#f2f4f7)" : "none", fontSize: 13, background: sev === "EMERGENCY" ? "rgba(220,38,38,.06)" : undefined }}>
                  <Pill tone={sv.tone}>{sev === "EMERGENCY" ? "🚨 " : ""}{sv.t}</Pill>
                  <span style={{ flex: 1 }}>{a.priority ? <b style={{ color: "#b45309" }}>⭐ </b> : null}{a.text}{a.code ? <small style={{ color: "var(--muted)", marginLeft: 6 }} title="Mã sự cố (tra Runbook)">{a.code}</small> : null}
                    {a.kind === "stream_black" && (
                      <button className="rowbtn" style={{ marginLeft: 8, fontSize: 11.5, padding: "2px 8px" }} disabled={busy} title="Xác nhận video này để nền tối/đen chủ ý → tắt cảnh báo màn đen cho luồng này" onClick={async () => { const sid = String(a.fingerprint || "").split(":")[1]; if (sid && await post({ action: "set_allow_black", id: sid, allow: true }, "Đã ghi nhận: nền đen chủ ý.")) void reload?.(); }}>✓ Nền đen chủ ý</button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      )}

      <Card title="🖥 Sức khoẻ & sức chứa máy" action={<button className="rowbtn" onClick={() => onGo("machines")}>Quản lý máy</button>}>
        {machines.length === 0 ? <p className="empty" style={{ margin: 0 }}>Chưa có máy. Sang "Máy live" để thêm.</p> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Máy</th><th>Tình trạng</th><th>Tải CPU</th><th>Ổ trống</th><th>Băng thông (dùng/tối đa)</th><th>Đang chạy</th><th>Sức chứa an toàn còn lại</th></tr></thead>
              <tbody>
                {machines.map((m: any) => {
                  const left = streamsLeft(m, cheapest, safety);
                  return (
                    <tr key={m.id}>
                      <td><b>{m.name}</b></td>
                      <td><Pill tone={m.maintenance ? "amber" : m.online ? "green" : "gray"}>{m.maintenance ? "🛠 Bảo trì" : m.online ? "🟢 Online" : "Offline"}</Pill></td>
                      <td>{m.loadAvg != null ? `${m.loadAvg}${m.vcpu ? "/" + m.vcpu : ""}` : "—"}</td>
                      <td>{m.diskFreeGb != null ? `${money(m.diskFreeGb)}GB` : "—"}</td>
                      <td>{m.uploadMbps ? <>{m.txMbps != null ? <b>{money(m.txMbps)}</b> : "?"}<span style={{ color: "var(--muted)" }}> / {money(m.uploadMbps)} Mbps</span></> : <span style={{ color: "#d97706" }}>chưa nhập</span>}</td>
                      <td>{m.liveCount ?? 0}</td>
                      <td>{left == null ? <small style={{ color: "var(--muted)" }}>nhập băng thông để tính</small> : left <= 0 ? <b style={{ color: "#dc2626" }}>đã đầy</b> : <b style={{ color: left > 5 ? "#16a34a" : "#d97706" }}>khoảng {left} luồng</b>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="plain" style={{ margin: "8px 0 0", fontSize: 11.5 }}>"Sức chứa an toàn còn lại" = số luồng có thể chạy THÊM ở mức chất lượng NHẸ NHẤT ({cheapest?.label}), đã chừa {Math.round((1 - safety) * 100)}% dự phòng. Mức cao hơn thì số luồng ít hơn (xem lúc chọn chất lượng).</p>
          </div>
        )}
      </Card>
    </>
  );
}

// ── LUỒNG PHÁT ───────────────────────────────────────────────────────────────
// Màn hình hẹp (điện thoại) → dùng THẺ thay bảng để khỏi vuốt ngang.
function useIsMobile(bp = 760) {
  const [m, setM] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const q = window.matchMedia(`(max-width:${bp}px)`);
    const on = () => setM(q.matches); on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, [bp]);
  return m;
}
// Một DÒNG luồng — giữ state riêng cho "hiện khoá" + "sửa link live" (mỗi dòng độc lập).
// Rút video ID YouTube từ link (watch?v= / youtu.be/ / /live/) — để khớp buổi phát của TỪNG luồng.
function ytVideoId(url: any): string {
  // NHẬN THÊM LINK YOUTUBE STUDIO (30/08/2026). Đo thật: 6/120 luồng đang phát dán link không đối
  // chiếu được, trong đó 3 luồng dán link Studio dạng studio.youtube.com/video/<mã>/livestreaming —
  // link đó CÓ mã buổi phát, chỉ là bộ đọc chưa nhận dạng → hệ báo "Chưa live" oan cho luồng đang
  // phát ngon. Đây là lỗi của hệ, không phải người dùng dán sai.
  const m = String(url ?? "").match(/(?:[?&]v=|youtu\.be\/|\/live\/|\/embed\/|\/video\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : "";
}
// Dự phòng nhiều VPS (Đợt 3): bảng đề xuất máy đích để chuyển luồng (CHỈ XEM TRƯỚC ở nhịp này).
function MovePreflightPanel({ pf, currentMachine, moveOn, onMove, busy, reDownloadable, dangPhat = true }: any) {
  const mm = (n: any) => `${money(n)} Mbps`;
  const cands: any[] = pf?.candidates ?? [];
  // Chuyển máy là BÀN GIAO HAI PHA (dừng nguồn → bật đích, canh để không bao giờ hai máy cùng phát).
  // Luồng CHƯA CHẠY thì chẳng có gì để bàn giao — máy chủ chặn thẳng ("Chỉ chuyển được luồng ĐANG
  // phát"). Trước đây bảng này vẫn hiện đủ nút cho luồng chờ chạy, bấm cái nào cũng ra lỗi
  // (Chủ Rise Group gặp 30/08/2026 với luồng hẹn 19:00). Nay chỉ đường ĐÚNG thay vì bày nút hỏng.
  return (
    <div style={{ marginTop: 6, padding: "8px 10px", background: "var(--card,#f8fafc)", border: "1px solid var(--line,#e7ecf2)", borderRadius: 9, fontSize: 12, maxWidth: 480 }}>
      <div style={{ color: "var(--muted)", marginBottom: 5 }}>Đang ở máy <b>{currentMachine}</b> · cần <b>{mm(pf?.streamBwMbps)}</b>. Máy đích đề xuất:</div>
      {cands.length === 0 ? <div style={{ color: "var(--muted)" }}>Chưa có máy nào khác để chuyển.</div> : cands.map((c: any) => (
        <div key={c.machineId} style={{ display: "flex", alignItems: "flex-start", flexWrap: "wrap", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line-soft,#eef2f6)" }}>
          <span style={{ fontSize: 14 }}>{c.eligible ? (c === pf.best ? "⭐" : "✓") : "⛔"}</span>
          <div style={{ flex: "1 1 150px", minWidth: 130 }}>
            <div><b>{c.name}</b>{c === pf.best ? <span style={{ color: "var(--green,#16a34a)", fontWeight: 700 }}> · đề xuất</span> : null}</div>
            <div style={{ color: "var(--muted)", fontSize: 11 }}>
              {c.eligible
                ? <>{c.hasVideo ? "🎬 có video sẵn" : "⬇ cần copy video"} · {c.differentFailureDomain ? "khác nhà cung cấp (an toàn hơn)" : "cùng nhà cung cấp"} · còn {mm(c.headroomMbps)}</>
                : <span style={{ color: "var(--red,#b3352c)" }}>Không dùng được: {(c.blockers || []).join(" · ")}</span>}
            </div>
            {/* Máy đích CHƯA có video + video TẢI THẲNG từ máy tính → không tự copy được, phải tải tay */}
            {moveOn && c.eligible && !c.hasVideo && !reDownloadable ? (
              <div style={{ color: "#b45309", fontSize: 10.5, marginTop: 3, lineHeight: 1.4 }}>⚠ Video này TẢI THẲNG từ máy tính — hệ thống không tự copy được. Muốn sao lưu/chuyển được sang máy này, hãy TẢI TAY video lên máy "{c.name}" trước (vào Kho video của máy đó).</div>
            ) : null}
          </div>
          {!dangPhat ? null : moveOn && c.eligible && c.hasVideo ? (
            <button disabled={busy} onClick={() => onMove?.(c.machineId, c.name, false)} style={{ border: "1px solid var(--rl,#0e8f84)", background: "var(--rl,#0e8f84)", color: "#fff", fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 7, cursor: "pointer", flex: "none" }}>Chuyển sang đây</button>
          ) : moveOn && c.eligible && !c.hasVideo && reDownloadable ? (
            <button disabled={busy} onClick={() => onMove?.(c.machineId, c.name, true)} title="Tự copy video sang máy này trước (luồng cũ VẪN phát), copy xong hệ thống tự chuyển" style={{ border: "1px solid var(--rl,#0e8f84)", background: "var(--card)", color: "var(--rl,#0e8f84)", fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 7, cursor: "pointer", flex: "none" }}>⬇ Chuyển (tự copy)</button>
          ) : null}
        </div>
      ))}
      {!dangPhat ? (
        <div style={{ marginTop: 6, padding: "7px 9px", background: "var(--card2,#eef6ff)", border: "1px solid var(--blue,#2563eb)", borderRadius: 8, fontSize: 11.5, lineHeight: 1.5 }}>
          <b>Luồng chưa chạy nên không dùng "Chuyển máy" được</b> — chuyển máy là bàn giao giữa hai máy khi đang phát.
          <div style={{ marginTop: 3, color: "var(--muted)" }}>Cách đổi máy cho luồng chờ chạy: <b>1.</b> Vào tab <b>Kho video</b>, bấm <b>“📋 Sao chép sang máy…”</b> để chép video sang máy đích, đợi <b>Sẵn sàng</b>. <b>2.</b> Quay lại đây bấm <b>Sửa</b>, đổi <b>Máy</b> rồi chọn lại video. (Phải chép trước, vì ô chọn video chỉ hiện video có trên đúng máy đang chọn.)</div>
        </div>
      ) : !moveOn ? <div style={{ color: "var(--muted)", fontSize: 10.5, marginTop: 5 }}>Đang XEM TRƯỚC. Nút "Chuyển sang đây" bật khi mở tính năng chuyển máy (thí điểm).</div>
        : <div style={{ color: "var(--muted)", fontSize: 10.5, marginTop: 5 }}>"⬇ Chuyển (tự copy)": hệ thống copy video sang máy đích TRƯỚC (luồng cũ vẫn phát, không cắt sóng), copy xong mới tự chuyển.</div>}
    </div>
  );
}

function StreamRow({ s, idx, uc, mobile, card, den, assetName, presetLabel, machineName, nccMay = () => "", machineOnline, post, rawPost, busy, onRename, onEdit, yt, flash, afterControl, thumbCacheSec, hoiNhap }: any) {
  const [open, setOpen] = useState(false);   // R-LAYOUT Đợt 2: bung chi tiết thẻ luồng
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState(false);
  const [showInc, setShowInc] = useState(false);   // xổ chi tiết nhật ký sự cố (bấm, không dựa hover)
  const [showMove, setShowMove] = useState(false); const [movePf, setMovePf] = useState<any>(null); const [moveLoading, setMoveLoading] = useState(false); const [moveOn, setMoveOn] = useState(false); const [moveReDl, setMoveReDl] = useState(false);
  const loadMove = async () => {
    if (showMove) { setShowMove(false); return; }
    setMoveLoading(true);
    const r = await rawPost({ action: "move_preflight", id: s.id });
    setMoveLoading(false);
    if (r?.preflight) { setMovePf(r.preflight); setMoveOn(!!r.moveEnabled); setMoveReDl(!!r.videoReDownloadable); setShowMove(true); } else flash?.(r?.error || "Không tải được đề xuất chuyển máy.");
  };
  const doMove = async (targetId: string, targetName: string, autoCopy: boolean) => {
    const msg = autoCopy
      ? `Chuyển luồng "${s.name}" sang máy "${targetName}" — TỰ COPY VIDEO TRƯỚC.\n\nLuồng cũ VẪN phát bình thường trong lúc copy (không cắt sóng). Copy xong hệ thống mới tự chuyển (lúc chuyển mất sóng ~30–40 giây, không phát trùng).`
      : `Chuyển luồng "${s.name}" sang máy "${targetName}"?\n\nMáy nguồn DỪNG trước, sau đó máy đích mới bật (mất sóng ~30–40 giây, TUYỆT ĐỐI không phát trùng).`;
    if (!window.confirm(msg)) return;
    const okMsg = autoCopy ? "Đang copy video sang máy đích — luồng cũ vẫn phát, copy xong tự chuyển." : "Đang chuyển máy — theo dõi trạng thái ở luồng.";
    if (await post({ action: "move_execute", id: s.id, targetId, autoCopy }, okMsg)) { setShowMove(false); afterControl?.(); }
  };
  const is247 = s.mode !== "live-pub";
  // "Đang phát THẬT" = worker báo live VÀ mình MUỐN phát. Sau khi Dừng, worker thôi báo nên status có
  // thể kẹt "live" — bám theo Ý ĐỊNH (desiredState/lịch) mới đúng, để hiện Sửa/Xoá + nhãn Đã dừng.
  const liveDesired = s.desiredState === "live" || (s.control === "schedule" && s.scheduleActive);
  const live = s.status === "live" && liveDesired;
  const st = (!liveDesired && s.status === "live") ? STATUS.stopped : (STATUS[s.status] ?? STATUS.queued);
  const h = HEALTH[s.health] ?? HEALTH.unknown;
  // "KHÔNG XANH GIẢ" (Gđ2): luồng ĐÁNG LẼ đang phát nhưng MÁY của nó đang mất kết nối → trạng thái hiển
  // thị là dữ liệu CŨ, không chắc còn phát. Hiện nhãn "mất tín hiệu — trạng thái cũ" thay vì để xanh sai.
  // Chỉ tính khi biết CHẮC máy offline (machineOnline===false); không rõ máy → bỏ qua (không gắn oan).
  const machStale = liveDesired && machineOnline && machineOnline(s.machineId) === false;
  // Live Pub hẹn giờ đã CHẠY HẾT khung giờ (không lặp) → "Đã phát xong", KHÔNG hiện như lỗi/dừng.
  const finishedPub = !live && s.control === "schedule" && s.mode === "live-pub" && !s.scheduleActive && !s.nextStartISO;
  const reveal = async () => {
    if (shownKey != null) { setShownKey(null); return; }   // bấm lại → ẩn
    setLoadingKey(true);
    const r = await rawPost({ action: "get_stream_key", id: s.id });
    setLoadingKey(false);
    if (r?.streamKey != null) setShownKey(String(r.streamKey));
  };
  // Dòng này nằm trong một <tr> nên KHÔNG đặt hộp ngay tại đây được (thẻ <div> trong <tr> là sai
  // chuẩn HTML). Nhờ thành phần CHA mở hộp hộ qua `hoiNhap` — cha vẽ hộp ở ngoài bảng.
  const editWatch = () => hoiNhap?.({
    tieuDe: "Link video live trên YouTube", nhan: "Dán URL", giaTriDau: s.watchUrl ?? "",
    moTa: "Dùng để mở xem / kiểm tra chất lượng. Để trống rồi lưu = gỡ link.",
    goiY: "https://www.youtube.com/watch?v=…", nutXacNhan: "Lưu link",
    kiemTra: (v: string) => (!v || /^https?:\/\//i.test(v) ? null : "Link phải bắt đầu bằng http:// hoặc https://"),
    xong: (n: string) => void post({ action: "set_watch_url", id: s.id, watchUrl: n }, n ? "Đã lưu link live." : "Đã gỡ link."),
  });
  // ── Các mảnh dùng chung cho bảng (desktop) lẫn thẻ (mobile) ──
  // Ảnh thật đang phát: lấy TỪ SERVER (agent đẩy ảnh về) → hiện được với MỌI VPS (không phụ thuộc
  // domain HTTPS riêng từng máy).
  // D-RL-06: `t` TRƯỚC ĐÂY bám theo heartbeat của luồng — mà heartbeat đổi liên tục, nên trình duyệt
  // coi như ảnh MỚI và tải lại mỗi lần làm mới danh sách (125 luồng = 125 lượt tải ảnh/lần). Nay `t`
  // đổi theo MỐC 45 GIÂY — đúng nhịp ảnh thật sự được cập nhật — nên trong 45 giây trình duyệt dùng
  // lại ảnh đã tải (server cũng cho phép giữ 40 giây). Ảnh vẫn tươi như cũ, chỉ hết tải thừa.
  // BÁM THEO nhịp máy chủ báo (nửa nhịp đẩy ảnh thật), KHÔNG gõ cứng.
  // Trước đây gõ cứng 45 giây vì tin dòng chú thích "cập nhật ~45s" — nhưng 45 giây là nhịp CHỤP,
  // còn nhịp ĐẨY lên máy chủ là 300 giây. Hậu quả: tải thừa gấp ~6 lần (Chủ Rise Group 29/08/2026).
  const thumbCache = Math.max(30, Number(thumbCacheSec) || 150);
  const thumbMoc = Math.floor(Date.now() / (thumbCache * 1000));
  const thumb = live ? (
    <img key={thumbMoc}
      src={`/api/live/thumb?streamId=${encodeURIComponent(s.id)}&t=${thumbMoc}`}
      alt="" title={`Ảnh thật đang phát (làm mới mỗi ~${thumbCache} giây)`} loading="lazy"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
      style={{ width: mobile ? 104 : 58, height: mobile ? 58 : 33, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border,#e2e7ee)", background: "#0e1420", flex: "0 0 auto" }} />
  ) : null;
  // MỨC ƯU TIÊN + dự phòng — TÁCH RA dùng chung cho cả bảng lẫn thẻ luồng.
  // (Trước đây nằm lẫn trong tên luồng nên chế độ thẻ không thấy — bro phát hiện đúng.)
  const priorityBlock = (() => {
        // Mức ƯU TIÊN + dự phòng nhiều VPS — CHỈ cho luồng 24/7 (chạy liên tục, rủi ro tích lũy cao).
        // LUỒNG PUB: KHÔNG dùng ưu tiên/dự phòng (Pub ít sự cố + cứu Pub không trọn vẹn vì video phát lại
        // từ đầu). Bảo vệ Pub bằng nút "🛡 Tắt tự-dừng" thủ công riêng bên dưới. Ẩn hẳn khối này cho Pub
        // để ĐỠ HIỂU NHẦM (Chủ Rise chốt 2026-08-19).
        if (s.mode === "live-pub") return null;
        const imp = s.importance || (s.priority ? "priority" : "normal");
        const bk = s.backup;
        const on = imp === "priority" || imp === "critical";
        return (
          <span style={{ marginLeft: 6, display: "inline-flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
            <select value={imp} title="Mức ưu tiên khi cứu luồng nếu máy gặp sự cố (dự phòng nhiều VPS)"
              onChange={(e) => { const v = e.target.value; post({ action: "set_stream_meta", id: s.id, importance: v }, (v === "priority" || v === "critical") ? "Đã đặt ưu tiên — luồng này sẽ LUÔN được tự động cứu." : "Đã đặt mức ưu tiên luồng."); }}
              style={{ fontSize: 10.5, padding: "1px 5px", borderRadius: 6, border: "1px solid var(--line,#e5e7eb)", background: imp === "critical" ? "var(--soft-red,#fee2e2)" : imp === "priority" ? "var(--soft-amber,#fef3c7)" : "transparent" }}>
              <option value="normal">Thường</option>
              <option value="priority">⭐ Ưu tiên</option>
              <option value="critical">🔺 Rất quan trọng</option>
            </select>
            {on && bk ? (
              bk.hasReplica && bk.differentFailureDomain
                ? <span title={bk.reason} style={{ fontSize: 10.5, fontWeight: 700, color: "var(--green,#16a34a)" }}>🛡 có dự phòng</span>
                : bk.hasReplica
                  ? <span title={bk.reason} style={{ fontSize: 10.5, fontWeight: 700, color: "var(--amber,#d97706)" }}>🟡 dự phòng cùng nhà cung cấp</span>
                  : <span title={bk.reason} style={{ fontSize: 10.5, fontWeight: 700, color: "var(--red,#b3352c)" }}>⚠ chưa có dự phòng</span>
            ) : null}
            {on ? (
              <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--rl,#0e8f84)" }} title="Luồng ưu tiên LUÔN được bảo vệ: hệ thống tự tải bản dự phòng sang máy khác và tự chuyển khi máy gặp sự cố. Muốn tắt thì hạ mức về 'Thường'.">
                🔁 tự động cứu · luôn bật
              </span>
            ) : null}
          </span>
        );
      })();
  const nameBlock = (
    <>
      <b>{s.name}</b>
      <button onClick={() => onRename(s)} title="Đổi tên luồng" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--muted)", marginLeft: 3, fontSize: 12 }}>✎</button>
      <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 999, background: is247 ? "var(--rl-soft,#dcf1ef)" : "var(--soft-amber,#fbeee0)", color: is247 ? "var(--rl,#0e8f84)" : "var(--amber,#b45309)" }}>{is247 ? "24/7" : "Pub"}</span>
      {String(s.moveState ?? "") === "copying_video" ? <span title="Đang tự copy video sang máy đích — luồng hiện tại VẪN phát bình thường, copy xong hệ thống mới chuyển" style={{ marginLeft: 5, fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 999, background: "var(--soft-amber,#fef3c7)", color: "var(--amber,#b45309)" }}>⬇ đang copy video (vẫn phát)</span> : null}
      {["stopping_source", "starting_target", "verifying"].includes(String(s.moveState ?? "")) ? <span title="Luồng đang được chuyển sang máy khác (bàn giao an toàn)" style={{ marginLeft: 5, fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 999, background: "var(--soft-blue,#dbeafe)", color: "var(--blue,#1e40af)" }}>🔄 đang chuyển máy</span> : null}
      {priorityBlock}
      {(s.restarts ?? 0) > 0 ? <small style={{ color: "var(--amber,#d97706)" }}> · restart {s.restarts}×</small> : null}
      {s.channelName ? <small style={{ display: "block", color: "var(--rl,#0e8f84)", fontWeight: 600, marginTop: 2 }}>📺 {s.channelName}</small> : null}
      <small style={{ display: "block", color: "var(--muted)", marginTop: 2, maxWidth: mobile ? "none" : 175, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${s.createdByName ?? s.createdBy ?? "—"}${s.createdByUnit ? " · " + s.createdByUnit : ""}`}>👤 {s.createdByName ?? s.createdBy ?? "—"}{s.createdByUnit ? <span style={{ color: "var(--rl,#0e8f84)" }}> · {s.createdByUnit}</span> : null}</small>
      {s.control === "schedule" ? <small style={{ display: "block", color: s.scheduleActive ? "var(--green,#16a34a)" : "var(--blue,#2563eb)" }}>⏰ {s.scheduleActive ? "đang trong khung giờ" : (s.nextStartISO ? `sắp phát ${fmtWhen(s.nextStartISO)}` : "đã qua lịch")}{s.schedule?.repeat === "daily" ? " · hằng ngày" : ""}</small> : null}
    </>
  );
  // Nguồn: 1 video → tên video; NHIỀU video → "📃 N video (nối tiếp/ngẫu nhiên)" + di chuột xem danh sách.
  const nAssets = Array.isArray(s.assetIds) && s.assetIds.length ? s.assetIds.length : 1;
  const isPlaylist = nAssets > 1;
  const assetNm = isPlaylist ? `📃 ${nAssets} video ${s.playMode === "random" ? "🔀 ngẫu nhiên" : "▶ nối tiếp"}` : assetName(s.assetId);
  const plTitle = isPlaylist ? s.assetIds.map((id: string, i: number) => `${i + 1}. ${assetName(id)}`).join("\n") : assetNm;
  // Desktop: cắt gọn tên video (… + di chuột thấy đủ) → cột không phình, khỏi kéo ngang.
  // Mobile (thẻ): cho tên xuống dòng vì có chỗ.
  const videoText = mobile ? (
    <span title={plTitle}>{assetNm} <small style={{ color: "var(--muted)" }}>· {presetLabel(s.presetId)} · {machineName(s.machineId)}</small></span>
  ) : (
    <span title={`${plTitle}\n· ${presetLabel(s.presetId)} · ${machineName(s.machineId)}`}>
      <span style={{ display: "inline-block", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }}>{assetNm}</span>
      <small style={{ color: "var(--muted)", whiteSpace: "nowrap" }}> · {presetLabel(s.presetId)} · 🖥️ {machineName(s.machineId)}</small>
    </span>
  );
  const linkBlock = (
    <>
      {s.watchUrl
        ? <a href={s.watchUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--rl,#0e8f84)", fontWeight: 600, textDecoration: "none", fontSize: 12.5 }}>▶ Mở live</a>
        : <span style={{ color: "var(--muted)", fontSize: 12 }}>—</span>}
      <button onClick={editWatch} title="Sửa link live" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--muted)", marginLeft: 4, fontSize: 12 }}>✎</button>
      {/* Bỏ nút "Báo lỗi YT" thủ công cho gọn (hệ thống tự phát hiện qua L3). CHỈ giữ nút bỏ cờ
          khi luồng ĐANG bị đánh dấu lỗi — để gỡ nhanh nếu báo nhầm. */}
      {s.ytIssue && <button onClick={() => { void post({ action: "clear_yt_issue", id: s.id }, "Đã bỏ đánh dấu sự cố YouTube."); }} title="Bỏ đánh dấu sự cố YouTube (nếu báo nhầm)" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--green,#16a34a)", marginLeft: 8, fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap" }}>✓ Bỏ cờ YT</button>}
    </>
  );
  const statusBlock = (
    <>
      {s.ytIssue ? <div style={{ marginBottom: 3 }}><span title={s.ytIssue.note || "Nghi bị YouTube chặn/đình chỉ — kiểm YouTube Studio"} style={{ fontSize: 11.5, fontWeight: 700, color: "var(--red,#b91c1c)", background: "var(--soft-red,#fef2f2)", border: "1px solid var(--line,#fca5a5)", borderRadius: 999, padding: "2px 9px", display: "inline-block" }}>⚠ NGHI YouTube chặn/đình chỉ{s.ytIssue.source === "manual" ? " (đánh dấu tay)" : ""}</span></div> : null}
      {finishedPub
        ? (yt
            ? <Pill tone="green">✅ Đã phát xong</Pill>
            : <Pill tone="amber" title="Kênh CHƯA nối YouTube (L3) → hệ thống KHÔNG xác minh được YouTube có phát đủ giờ hay không, chỉ biết MÁY đã chạy đủ thời gian cài đặt. Nối L3 để biết chắc buổi phát có đủ giờ không.">⏱ Chạy đủ giờ cài — chưa xác minh YouTube</Pill>)
        : machStale
          ? <Pill tone="gray" title={`Máy "${machineName(s.machineId)}" đang MẤT KẾT NỐI với hệ thống — trạng thái luồng bên dưới là dữ liệu CŨ (trước lúc mất tín hiệu), CHƯA chắc còn phát. Xem cảnh báo máy ở tab Tổng quan để xử lý.`}>⚠ Mất tín hiệu máy — trạng thái cũ</Pill>
          : <><Pill tone={st.tone}>{st.t}</Pill>{live ? <> <Pill tone={h.tone}>{h.t}</Pill></> : null}</>}
      {/* Batch 6 (B) — YouTube xác nhận (L3) THEO TỪNG LUỒNG: khớp buổi phát của luồng (link video)
          với danh sách buổi đang live của kênh → mỗi luồng có trạng thái + nút "Kết thúc" RIÊNG
          (đúng cho nhiều luồng/1 kênh, không còn dùng chung trạng thái kênh). */}
      {(() => {
        const myVid = ytVideoId(s.watchUrl);
        const bcs: any[] = yt?.youtubeState?.broadcasts ?? [];
        const myLive = !!myVid && bcs.some((b: any) => String(b.videoId) === myVid);   // buổi phát CỦA LUỒNG NÀY đang live
        const chanLive = yt?.youtubeState?.broadcastStatus === "live";
        let t = "Chưa xác minh", col = "var(--muted)";
        if (yt) {
          if (yt.connectionState === "REVOKED" || yt.connectionState === "REAUTH_REQUIRED") { t = "Mất kết nối OAuth"; col = "#dc2626"; }
          else if (myLive) { t = "Đang live"; col = "#16a34a"; }
          else if (myVid && chanLive) { t = "Chưa live (buổi khác đang phát)"; col = "#d97706"; }
          // KHÔNG ĐỌC ĐƯỢC MÃ BUỔI PHÁT TỪ LINK (30/08/2026 — Chủ Rise Group hỏi).
          // Hệ đối chiếu bằng MÃ BUỔI PHÁT lấy từ ô "Link live". Một kênh có thể có nhiều buổi cùng
          // lúc nên chỉ biết tên kênh là KHÔNG đủ để biết luồng này ứng với buổi nào. Dán link KÊNH
          // (youtube.com/@ten hoặc /channel/UC...) thì không có mã → không đối chiếu được.
          // Trước đây rơi vào đây là hiện "Chưa live" — người xem tưởng luồng CHƯA LÊN SÓNG, trong
          // khi nó đang phát bình thường. Nói đúng cái mình biết: chưa đối chiếu được, và thiếu gì.
          else if (!myVid) { t = "Chưa đối chiếu được — ô Link live chưa phải link buổi phát"; col = "var(--muted)"; }
          else { t = "Chưa live"; col = "#d97706"; }
        }
        return <small style={{ display: "block", marginTop: 2, fontSize: 11 }}><span style={{ color: "var(--muted)" }}>YouTube:</span> <b style={{ color: col }}>{t}</b>{!yt ? <span style={{ color: "var(--muted)" }}> (kênh chưa kết nối)</span> : null}</small>;
      })()}
      {/* ĐIỀU KHIỂN L3: nút KẾT THÚC HẲN buổi live trên YouTube (khác "Dừng" = tạm dừng). Hiện khi kênh
          nối L3 + buổi live của luồng này đang active trên YouTube — cả khi ĐANG live (kết thúc hẳn) lẫn
          khi đã dừng mà YouTube còn treo (đóng nốt). Nhãn/lời xác nhận đổi theo trạng thái. */}
      {yt?.hasControlScope && !!ytVideoId(s.watchUrl) && (yt?.youtubeState?.broadcasts ?? []).some((b: any) => String(b.videoId) === ytVideoId(s.watchUrl)) && (
        <button
          onClick={async () => {
            if (!window.confirm(live
              ? `KẾT THÚC HẲN buổi live của "${s.name}" trên YouTube?\n\nĐây là ĐÓNG HẲN buổi live trên kênh + dừng máy phát — KHÁC với "Dừng" (tạm dừng, giữ buổi live để sửa). Người xem sẽ kết thúc, muốn phát lại phải tạo buổi mới.`
              : `Đóng buổi phát còn treo trên YouTube của "${s.name}"?\n\nLuồng đã dừng nhưng YouTube vẫn hiện "đang live" — đóng NỐT buổi live còn kẹt (khỏi phải vào Studio).`)) return;
            try {
              const r = await fetch("/api/live/youtube/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "complete", streamId: s.id }) });
              const j = await r.json();
              flash?.(j.error ? "⚠ " + j.error : (j.already ? "Buổi phát đã kết thúc từ trước." : "✅ Đã kết thúc buổi phát YouTube + dừng máy phát."));
              if (!j.error) afterControl?.();   // làm mới NGAY: trạng thái YouTube hết "Đang live" + luồng thành đã dừng
            } catch { flash?.("⚠ Lỗi gọi điều khiển."); }
          }}
          style={{ marginTop: 3, fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 7, border: "1px solid #dc2626", background: "var(--card)", color: "#dc2626", cursor: "pointer", display: "inline-block" }}
          title={live ? "KẾT THÚC HẲN buổi live trên YouTube + dừng máy (khác Dừng = tạm dừng). Cần kênh nối API." : "Đóng buổi live còn treo trên YouTube (điều khiển thật — cần quyền điều khiển)"}
        >{live ? "🎛 Kết thúc buổi live" : "🎛 Kết thúc trên YouTube"}</button>
      )}
      {/* THÍ ĐIỂM bảo vệ Pub (bước 2): TẮT auto-stop trên YouTube để buổi phát TREO CHỜ khi mất tín hiệu
          (hệ mới cứu/chuyển máy được). Chỉ Pub + kênh đã bật điều khiển + buổi phát khớp. Tự động sẽ nối sau. */}
      {s.mode === "live-pub" && yt?.hasControlScope && !!ytVideoId(s.watchUrl) && (yt?.youtubeState?.broadcasts ?? []).some((b: any) => String(b.videoId) === ytVideoId(s.watchUrl)) && (
        s.youtubeAutoStop === false ? (
          <span style={{ marginTop: 3, marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: "var(--green,#16a34a)", display: "inline-flex", alignItems: "center", gap: 5 }} title="Auto-stop ĐÃ TẮT trên YouTube — sự cố sẽ không tự kết thúc buổi phát (cứu được). Nhớ bấm 'Kết thúc buổi live' khi phát xong.">
            🛡 Đã bảo vệ · tự-dừng tắt
            <button
              onClick={async () => {
                if (!window.confirm(`BẬT LẠI "tự-dừng" cho "${s.name}"?\n\nYouTube sẽ tự kết thúc buổi phát khi mất tín hiệu (KHÔNG cứu được nữa).`)) return;
                try { const r = await fetch("/api/live/youtube/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set_autostop", streamId: s.id, enable: true }) }); const j = await r.json(); flash?.(j.error ? "⚠ " + j.error : "Đã bật lại tự-dừng."); if (!j.error) afterControl?.(); } catch { flash?.("⚠ Lỗi."); }
              }}
              style={{ border: "none", background: "none", cursor: "pointer", color: "var(--muted)", fontSize: 10, textDecoration: "underline", padding: 0 }}
            >bật lại</button>
          </span>
        ) : (
          <button
            onClick={async () => {
              if (!window.confirm(`TẮT "tự-dừng" (auto-stop) cho buổi phát Pub "${s.name}" trên YouTube?\n\nĐể khi máy gặp sự cố, buổi phát KHÔNG tự kết thúc mà TREO CHỜ tín hiệu → hệ có thể chuyển máy cứu.\n\n⚠ Nhớ bấm "Kết thúc buổi live" khi phát xong (vì sẽ không tự dừng nữa).`)) return;
              try {
                const r = await fetch("/api/live/youtube/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set_autostop", streamId: s.id, enable: false }) });
                const j = await r.json();
                flash?.(j.error ? "⚠ " + j.error : `✅ Đã tắt tự-dừng (auto-stop=${j.enableAutoStop}). Buổi phát sẽ treo chờ khi mất tín hiệu.`);
                if (!j.error) afterControl?.();
              } catch { flash?.("⚠ Đổi auto-stop lỗi."); }
            }}
            style={{ marginTop: 3, marginLeft: 6, fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 7, border: "1px solid #0e8f84", background: "var(--card)", color: "var(--rl,#0e8f84)", cursor: "pointer", display: "inline-block" }}
            title="TẮT auto-stop cho buổi phát Pub (điều khiển thật trên YouTube) — để sự cố không tự đóng buổi phát."
          >🛡 Tắt tự-dừng (bảo vệ)</button>
        )
      )}
      {live ? (s.liveSince
        ? <small style={{ display: "block", color: "var(--muted)", marginTop: 2 }} title={`Live liên tục từ ${fmtWhen(s.liveSince)} (không reset khi tự khởi động lại)`}>🔴 Live từ <b>{fmtWhen(s.liveSince)}</b> · {fmtUptime((Date.now() - Date.parse(s.liveSince)) / 1000)}</small>
        : <small style={{ display: "block", color: "var(--muted)", marginTop: 2 }}>⏱ {fmtUptime(s.uptimeSec)}</small>) : null}
      {live && (s.bitrateKbps != null || s.speed != null) ? (() => {
        const slow = s.speed != null && s.speed < 0.95;    // <1x = ffmpeg đẩy chậm hơn thời gian thực → sẽ giật/rớt
        const low = s.bitrateKbps != null && s.bitrateKbps < 500;   // gần 0 = luồng gần như không có dữ liệu ra
        const bad = slow || low;
        return (
          <small style={{ display: "block", marginTop: 2 }} title="Bitrate đang đẩy lên YouTube + tốc độ thời gian thực (1x = bình thường). Số tụt/dưới 1x = đường truyền yếu, dễ giật.">
            📶 <b style={{ color: bad ? "#dc2626" : "#16a34a" }}>{s.bitrateKbps != null ? `${(s.bitrateKbps / 1000).toFixed(2)} Mbps` : "—"}</b>
            {s.speed != null ? <span style={{ color: slow ? "#dc2626" : "var(--muted)" }}> · {s.speed.toFixed(2)}×{slow ? " ⚠ đang tụt" : ""}</span> : null}
          </small>
        );
      })() : null}
      {(s.recentIncidents?.length) ? (() => {
        const last = s.recentIncidents[0]; const c = incidentCause(last.reason, nccMay(s.machineId));
        return (
          <div style={{ marginTop: 2 }}>
            <button onClick={() => setShowInc((v) => !v)} style={{ border: "none", background: "none", padding: 0, cursor: "pointer", color: "#d97706", fontSize: 12, textAlign: "left" }}>
              ⚡ tự phục hồi {last.downSec}s{c.label ? ` · ${c.label}` : ""}{s.recentIncidents.length > 1 ? ` · ${s.recentIncidents.length} lần` : ""} <span style={{ fontSize: 10 }}>{showInc ? "▾" : "▸ xem"}</span>
            </button>
            {showInc ? (
              <div style={{ marginTop: 4, padding: "6px 8px", background: "var(--soft-amber,#fff7ed)", border: "1px solid var(--line,#fed7aa)", borderRadius: 8, fontSize: 11.5, maxWidth: 320, whiteSpace: "normal" }}>
                {s.recentIncidents.map((e: any, i: number) => { const cc = incidentCause(e.reason, nccMay(s.machineId)); return (
                  <div key={i} style={{ marginBottom: 5, borderTop: i ? "1px solid var(--line,#fde3c4)" : "none", paddingTop: i ? 5 : 0 }}>
                    <div style={{ color: "#9a3412" }}>🕒 {fmtWhen(e.at)} · rớt → phục hồi <b>{e.downSec}s</b>{cc.label ? ` · ${cc.label}` : ""}</div>
                    {cc.fix ? <div style={{ color: "var(--muted)", marginTop: 1 }}>↳ {cc.fix}</div> : null}
                  </div>
                ); })}
              </div>
            ) : null}
          </div>
        );
      })() : null}
      <div style={{ marginTop: 4 }}>
        <button onClick={loadMove} disabled={moveLoading} style={{ border: "1px solid var(--line,#d0d7e2)", background: "var(--card)", cursor: "pointer", color: "var(--rl,#0e8f84)", fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 7 }} title="Xem đề xuất máy đích để chuyển luồng (dự phòng nhiều VPS)">🔀 Chuyển máy{moveLoading ? "…" : (showMove ? " ▾" : "")}</button>
        {s.mode === "live-pub" && s.youtubeAutoStop !== false ? <span style={{ marginLeft: 8, fontSize: 10.5, color: "#b45309" }} title="Luồng Pub: nếu auto-stop đang bật, việc dừng nguồn để chuyển sẽ khiến YouTube kết thúc buổi phát. Hãy TẮT auto-stop trên YouTube Studio TRƯỚC khi chuyển, chuyển xong bật lại.">⚠ Pub: tắt auto-stop trước khi chuyển</span> : null}
        {showMove && movePf ? <MovePreflightPanel pf={movePf} currentMachine={machineName(s.machineId)} moveOn={moveOn} onMove={doMove} busy={busy} reDownloadable={moveReDl} dangPhat={liveDesired} /> : null}
      </div>
    </>
  );
  const keyBlock = (
    <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 12 }}>
      <span style={{ letterSpacing: shownKey == null ? 1 : 0 }}>{shownKey != null ? shownKey : (s.streamKeyMasked || "—")}</span>
      <button onClick={reveal} disabled={loadingKey} title={shownKey == null ? "Hiện khoá" : "Ẩn khoá"} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--muted)", marginLeft: 5, fontSize: 13 }}>{loadingKey ? "…" : (shownKey == null ? "👁" : "🙈")}</button>
    </span>
  );
  const actionsBlock = (
    <>
      {/* Đã phát xong → KHÔNG hiện Theo lịch/Dừng (đã dừng cả VPS lẫn YouTube), chỉ còn Sửa/Xoá bên dưới. */}
      {finishedPub ? null
        : s.control === "schedule"
          ? <><Pill tone="blue">Theo lịch</Pill> <button className="rowbtn" disabled={busy} onClick={() => { if (window.confirm(`TẠM DỪNG luồng hẹn giờ “${s.name}”?\n\n• Dừng ngay + TẮT LỊCH tự động (chuyển sang bật/tắt tay, không tự bật lại theo giờ).\n• Buổi live trên YouTube KHÔNG bị kết thúc.\n\n➡ Muốn KẾT THÚC HẲN buổi live thì dùng nút “🎛 Kết thúc buổi live”.`)) void post({ action: "set_stream", id: s.id, desired: "stopped" }, "Đã tạm dừng + tắt lịch (buổi live YouTube giữ nguyên)."); }} style={{ marginLeft: 6 }}>Dừng</button></>
          : (s.desiredState === "live"
            ? <button className="rowbtn" disabled={busy} onClick={() => { if (window.confirm(`TẠM DỪNG luồng “${s.name}”?\n\n• Máy phát NGỪNG đẩy (khán giả tạm mất tín hiệu).\n• Buổi live trên YouTube KHÔNG bị kết thúc — bấm “Lên sóng” lại (cùng khoá, làm nhanh) là TIẾP TỤC.\n• Muốn SỬA luồng: Dừng ở đây rồi bấm “Sửa”.\n\n➡ Muốn KẾT THÚC HẲN buổi live trên kênh thì dùng nút “🎛 Kết thúc buổi live” (KHÔNG phải nút này).`)) void post({ action: "set_stream", id: s.id, desired: "stopped" }, "Đã tạm dừng (buổi live YouTube giữ nguyên)."); }}>Dừng</button>
            : <button className="rowbtn" disabled={busy} onClick={() => post({ action: "set_stream", id: s.id, desired: "live" }, "Đã yêu cầu lên sóng.")}>Lên sóng</button>)}
      {!is247 && <button className="rowbtn" disabled={busy} title="Chuyển luồng này sang Live 24/7 — phát LIÊN TỤC, không tự kết thúc theo thời lượng" onClick={() => { if (window.confirm(`Chuyển “${s.name}” sang Live 24/7?\n\nLuồng sẽ phát LIÊN TỤC (không tự kết thúc theo thời lượng).${s.control === "schedule" ? "\nLịch giữ giờ bắt đầu nhưng bỏ thời lượng/lặp — phát liên tục từ giờ đó." : ""}`)) void post({ action: "convert_to_247", id: s.id }, "Đã chuyển sang Live 24/7."); }} style={{ marginLeft: 6, color: "var(--rl,#0e8f84)", fontWeight: 700 }}>→ 24/7</button>}
      {!liveDesired && <button className="rowbtn" disabled={busy} onClick={() => onEdit(s)} title="Sửa lại luồng (video/máy/khoá/lịch)" style={{ marginLeft: 6 }}>Sửa</button>}
      {!liveDesired && <button className="rowbtn" disabled={busy} onClick={() => { if (window.confirm(`XOÁ luồng “${s.name}”?\n\nKhông khôi phục lại được. (Video trong Kho vẫn giữ nguyên.)`)) void post({ action: "delete_stream", id: s.id }, "Đã xoá."); }} style={{ marginLeft: 6, color: "#dc2626" }}>Xoá</button>}
    </>
  );

  // ── THẺ (mobile): xếp dọc, xem đủ không cần vuốt ngang ──
  if (mobile) {
    return (
      <div className="rl-card">
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          {thumb}
          <div style={{ flex: 1, minWidth: 0 }}>{nameBlock}</div>
          <span style={{ color: "var(--muted)", fontWeight: 700, fontSize: 12 }}>#{idx}</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 13 }}>{videoText}</div>
        <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{statusBlock}</div>
        <div style={{ marginTop: 6, display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5, alignItems: "center" }}>
          <span>{linkBlock}</span>
          <span style={{ color: "var(--muted)" }}>Khoá: {keyBlock}</span>
        </div>
        <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{actionsBlock}</div>
      </div>
    );
  }
  // ── THẺ LUỒNG (máy tính) — R-LAYOUT Đợt 2 ────────────────────────────────────
  // Vì sao đổi: bảng 7 cột, mỗi ô là một ĐOẠN (riêng cột trạng thái 7 dòng) → bảng phình
  // ngang, phải cuộn xuống đáy rồi kéo sang phải mới bấm được nút. Thẻ dùng lưới CO ĐƯỢC
  // TỚI 0: hết chỗ thì CẮT CHỮ, khung KHÔNG nở → không bao giờ tràn ngang, mọi bề rộng.
  // Phần BUNG ra dùng LẠI nguyên các khối cũ (statusBlock/linkBlock/keyBlock/actionsBlock)
  // — không viết lại logic điều khiển, nên không có rủi ro sai lệch hành vi.
  if (card) {
    const bad = st.tone === "red" || h.tone === "red" || machStale || s.needsHuman || s.restartHalted;
    const warn = st.tone === "amber" || h.tone === "amber" || s.ytIssue;
    const primary = finishedPub ? null
      : s.desiredState === "live"
        ? null                                   // đang phát → nút chính là "Mở live" (xem trên YouTube)
        : { label: "Lên sóng", act: () => post({ action: "set_stream", id: s.id, desired: "live" }, "Đã yêu cầu lên sóng.") };
    return (
      <div className={`rl-row${bad ? " bad" : warn ? " warn" : ""}${open ? " open" : ""}`}>
        <div className="rl-row-top" onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } }}
          title={open ? "Thu gọn" : "Bấm để xem chi tiết"}>
          <span className="rl-seq">{idx}</span>
          <span className="rl-th">{thumb}</span>
          <span className="rl-idn">
            <b title={s.name}>{s.name}</b>
            <small title={`${s.channelName ?? ""} · ${s.createdByName ?? s.createdBy ?? ""}${s.createdByUnit ? " · " + s.createdByUnit : ""} · ${machineName(s.machineId)}`}>
              {s.channelName ? `📺 ${s.channelName} · ` : ""}{s.createdByName ?? s.createdBy ?? "—"} · 🖥️ {machineName(s.machineId)}
            </small>
          </span>
          <span className="rl-stat">
            <span className="rl-chips">
              {(() => {
                // Nhìn lướt phải nhận ra ngay luồng ưu tiên (bro phát hiện thiếu ở bản thẻ đầu).
                const imp = s.importance || (s.priority ? "priority" : "normal");
                if (s.mode === "live-pub" || imp === "normal") return null;
                const crit = imp === "critical";
                return <span className="pill" title={crit ? "Rất quan trọng — luôn được tự động cứu khi máy gặp sự cố" : "Ưu tiên — luôn được tự động cứu khi máy gặp sự cố"}
                  style={{ background: crit ? "var(--soft-red,#fee2e2)" : "var(--soft-amber,#fef3c7)", color: crit ? "var(--red,#dc2626)" : "var(--amber,#b45309)" }}>{crit ? "🔺 Rất quan trọng" : "⭐ Ưu tiên"}</span>;
              })()}
              <span className={`pill ${st.tone}`}>{st.t}</span>
              <span className={`pill ${h.tone}`}>{machStale ? "Mất tín hiệu" : h.t}</span>
              <span className="pill" style={{ background: "var(--surface2,#eef2f6)", color: "var(--muted)" }}>{is247 ? "24/7" : "Pub"}</span>
            </span>
            <small className="rl-metrics">
              {live && s.bitrateKbps != null ? `${(s.bitrateKbps / 1000).toFixed(2)} Mbps` : "—"}
              {live && s.liveSince ? ` · ${fmtUptime((Date.now() - Date.parse(s.liveSince)) / 1000)}` : ""}
              {s.control === "schedule" ? (
                s.scheduleActive ? " · trong khung giờ"
                : s.nextStartISO ? ` · ⏰ ${fmtWhen(s.nextStartISO)}${s.schedule?.repeat === "daily" ? " · hằng ngày" : ""}`
                : " · đã qua lịch"
              ) : ""}
            </small>
            {den === "full" ? (
              <small className="rl-metrics rl-extra">
                {(s.recentIncidents?.length) ? `⚡ tự phục hồi ${s.recentIncidents[0].downSec}s · ${s.recentIncidents.length} lần` : "✓ chưa ghi nhận sự cố"}
              </small>
            ) : null}
          </span>
          <span className="rl-acts" onClick={(e) => e.stopPropagation()}>
            {s.watchUrl
              ? <a className="rl-go" href={s.watchUrl} target="_blank" rel="noopener noreferrer" title="Mở buổi live trên YouTube">▶ Mở live</a>
              : primary
                ? <button className="rl-go" disabled={busy} onClick={() => primary.act()}>{primary.label}</button>
                : <span className="rl-go rl-go-off">—</span>}
            <button className="rl-more" aria-expanded={open} title="Chuyển máy · Sửa · Dừng · Khoá · Xoá" onClick={() => setOpen((v) => !v)}>⋯</button>
          </span>
        </div>
        {open ? (
          <div className="rl-row-detail">
            <div className="rl-dl">
              <span className="k">Kênh / Link live</span><span className="v">{linkBlock}</span>
              <span className="k">Khoá luồng</span><span className="v">{keyBlock}</span>
              <span className="k">Video · Máy</span><span className="v">{videoText}</span>
              {s.mode !== "live-pub" ? <><span className="k">Mức ưu tiên</span><span className="v">{priorityBlock}</span></> : null}
              <span className="k">Trạng thái · Live</span><span className="v">{statusBlock}</span>
            </div>
            <div className="rl-dbtn">{actionsBlock}</div>
          </div>
        ) : null}
      </div>
    );
  }
  // ── HÀNG BẢNG (desktop, chế độ "Bảng" — giữ cho ai quen) ──
  return (
    <tr>
      <td style={{ color: "var(--muted)", fontWeight: 700, textAlign: "center", whiteSpace: "nowrap" }}>{idx}</td>
      <td>{nameBlock}</td>
      <td><div style={{ display: "flex", gap: 8, alignItems: "center" }}>{thumb}<div>{videoText}</div></div></td>
      <td style={{ minWidth: 130, whiteSpace: "normal" }}>{linkBlock}</td>
      <td style={{ minWidth: 200, whiteSpace: "normal" }}>{statusBlock}</td>
      <td style={{ whiteSpace: "nowrap" }}>{keyBlock}</td>
      <td style={{ minWidth: 150, whiteSpace: "normal" }}>{actionsBlock}</td>
    </tr>
  );
}

// Ô CHỌN KÊNH có TÌM THEO TÊN — thay select thường (danh sách kênh dài + kênh mới thêm khó tìm).
// Gõ tên → hiện danh sách bấm chọn; focus → tự tải lại danh sách (kênh vừa thêm cũng xuất hiện).
function ChannelPicker({ channels, value, onPick, onFocusReload }: any) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const low = (s: any) => String(s ?? "").toLowerCase();
  const sel = (channels ?? []).find((c: any) => c.id === value);
  const matches = (channels ?? []).filter((c: any) => !q.trim() || low(`${c.name} ${c.unit ?? ""}`).includes(low(q.trim()))).slice(0, 60);
  return (
    <div style={{ position: "relative" }}>
      <input
        value={open ? q : (sel ? `${sel.name}${sel.unit ? ` · ${sel.unit}` : ""}` : "")}
        onChange={(e) => { setQ(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => { setQ(""); setOpen(true); onFocusReload?.(); }}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
        placeholder="🔎 Gõ tên kênh… (để trống = không gắn)"
        style={{ width: "100%", padding: "8px 11px", borderRadius: 8, border: `1px solid ${sel ? "var(--green,#2f9e44)" : "var(--line,#e5e7eb)"}`, boxSizing: "border-box", fontSize: 13 }}
      />
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0, zIndex: 80, background: "var(--card)", border: "1px solid #e4e7ec", borderRadius: 10, boxShadow: "0 12px 28px rgba(16,24,40,.16)", maxHeight: 260, overflowY: "auto", padding: 4 }}>
          <div onMouseDown={(e) => { e.preventDefault(); onPick(""); setOpen(false); }} style={{ padding: "8px 10px", cursor: "pointer", color: "var(--muted,#7a8697)", borderRadius: 6 }}>— Không gắn kênh —</div>
          {matches.map((c: any) => (
            <div key={c.id} onMouseDown={(e) => { e.preventDefault(); onPick(c.id); setOpen(false); }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface2,#f2f4f7)")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{ padding: "8px 10px", cursor: "pointer", borderRadius: 6, fontSize: 13 }}>
              {c.name}{c.unit ? <span style={{ color: "var(--muted,#7a8697)" }}> · {c.unit}</span> : null}
            </div>
          ))}
          {matches.length === 0 && <div style={{ padding: "8px 10px", color: "var(--muted,#7a8697)", fontSize: 12.5 }}>Không tìm thấy kênh “{q}”.</div>}
        </div>
      )}
    </div>
  );
}

// GIAI ĐOẠN 1 — BẢNG CHI PHÍ & TẢI (ước tính, CHỈ ĐỌC). Tính từ số luồng/VPS/asset đang có + nhịp
// hiện tại (heartbeat 20s, thumbnail 45s, dashboard 12s). Phóng chiếu lên 300 luồng để thấy vách chi phí.
// Giá Firestore thô: ghi ~$1.8/triệu, đọc ~$0.6/triệu (thay đổi theo vùng — chỉ để ước lượng).
function LiveCostEstimate({ streams, machines, assets, cadence }: any) {
  // NHỊP LẤY TỪ MÁY CHỦ, KHÔNG CHÉP CỨNG (30/08/2026 — Chủ Rise Group hỏi "các nhịp ở đó có đúng
  // thực tế vận hành không?"). Đo ra là SAI: chỗ này từng ghi đẩy ảnh 45 giây (thực tế 300, giãn từ
  // worker r2.31) và màn hình 12 giây (thực tế 20). Vì chép cứng nên hệ đổi mà nó không đổi theo —
  // con số thổi phồng chi phí suốt nhiều tuần mà không ai biết. Nay đọc từ `cadence` máy chủ gửi
  // xuống (nguồn: lib/live-cadence.ts + lib/live-thumb-store.ts). Ai chỉnh nhịp thì số tự đúng theo.
  const POLL = Number(cadence?.pollSec) || 20;
  const THUMB = Number(cadence?.thumbPushSec) || 300;
  const DASH = Math.round((Number(cadence?.dashMs) || 20000) / 1000);
  const WOC = cadence?.writeOnChange === true;            // ghi-khi-đổi đang bật?
  const WOC_SEC = Number(cadence?.wocRefreshSec) || 120;
  const RC = cadence?.readConsolidate === true;           // gộp lượt đọc đang bật?
  const W = 1.8 / 1e6, R = 0.6 / 1e6;                       // $/thao tác
  const calc = (nAll: number, nLive: number, nVPS: number, nAssets: number, viewers: number) => {
    const perDay = 86400;
    // GHI-KHI-ĐỔI: luồng ổn định KHÔNG ghi mỗi nhịp, chỉ "điểm danh" lại mỗi WOC_SEC giây. Trước đây
    // phép tính này bỏ qua hẳn cơ chế đó nên tính thừa gấp ~6 lần phần ghi của luồng.
    const nhipGhiLuong = WOC ? WOC_SEC : POLL;
    const writes = nAll * (perDay / nhipGhiLuong) + nVPS * (perDay / POLL) + nLive * (perDay / THUMB);
    // GỘP LƯỢT ĐỌC: mỗi nhịp máy phát chỉ đọc MỘT lần danh sách của nó (trước là hai lần).
    const heSoDoc = RC ? 1 : 2;
    const reads = heSoDoc * (nAll + nAssets) * (perDay / POLL) + viewers * (nAll + nAssets + nVPS) * (perDay / DASH);
    const mW = writes * 30, mR = reads * 30;
    return { mW, mR, cost: mW * W + mR * R };
  };
  const nAll = streams.length, nLive = streams.filter((s: any) => s.status === "live").length, nVPS = Math.max(1, machines.length), nAssets = assets.length;
  const now = calc(nAll, nLive, nVPS, nAssets, 1);
  const proj = calc(300, 300, 10, Math.max(nAssets, 300), 3);   // phóng chiếu 300 luồng / 10 VPS / 3 người xem
  const fmtN = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(1) + " triệu" : Math.round(n).toLocaleString("vi-VN");
  // TÁCH SỐ RA KHỎI VĂN, BỎ MÀU ĐỎ (30/08/2026 — Chủ Rise Group).
  // Trước đây mấy con số nằm lẫn trong câu và tô ĐỎ → nhìn tưởng đang có sự cố, trong khi đây chỉ
  // là TIỀN ĐỌC/GHI DỮ LIỆU dự kiến (không phải tiền thuê VPS), và là con số để CÂN NHẮC MỞ RỘNG.
  // Đỏ là màu dành cho "đang hỏng"; dùng nó cho một ước tính là nói sai mức độ.
  const oCot = (nhan: string, phu: string, d: any) => (
    <div style={{ minWidth: 150 }}>
      <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)" }}>{nhan}</span>
      <b className="tnum" style={{ display: "block", fontSize: 17, fontWeight: 800, margin: "2px 0 1px" }}>~${d.cost.toFixed(0)} / tháng</b>
      <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>{phu} · ghi {fmtN(d.mW)} · đọc {fmtN(d.mR)}</span>
    </div>
  );
  // ── TIỀN THUÊ MÁY (30/08/2026 — Chủ Rise Group yêu cầu) ───────────────────────────────────
  // Trước đây màn này chỉ thấy MỘT NỬA chi phí. Nay cộng cả tiền thuê từng máy để ra TỔNG THẬT.
  // Máy chưa nhập giá thì bỏ qua — và NÓI RÕ còn mấy máy chưa nhập, để tổng không bị hiểu nhầm là đủ.
  const quyThang = (m: any): number => {
    const v = Number(m?.costAmount); if (!Number.isFinite(v) || v <= 0) return 0;
    return String(m?.costPeriod) === "year" ? v / 12 : v;
  };
  const tienMay = machines.reduce((s: number, m: any) => s + quyThang(m), 0);
  const chuaNhap = machines.filter((m: any) => !(Number(m?.costAmount) > 0)).length;
  const tong = tienMay + now.cost;
  // HẠN GIA HẠN — quên gia hạn là mất sóng CẢ MÁY. Sắp xếp máy gần hết hạn lên trước.
  const homNay = new Date().toISOString().slice(0, 10);
  const conNgay = (d: string) => Math.round((Date.parse(d + "T00:00:00Z") - Date.parse(homNay + "T00:00:00Z")) / 86400000);
  const hetHan = machines.filter((m: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(m?.costRenewAt ?? "")))
    .map((m: any) => ({ ten: m.name, ngay: String(m.costRenewAt), con: conNgay(String(m.costRenewAt)) }))
    .sort((a: any, b: any) => a.con - b.con);
  const gap = hetHan.filter((x: any) => x.con <= 7);
  const money2 = (n: number) => "$" + (Math.round(n * 10) / 10).toLocaleString("en-US");
  return (
    <Card title="💰 Chi phí vận hành Live Rise (ước tính)" action={<span style={{ fontSize: 12, color: "var(--muted)" }}>chỉ Quản trị hạ tầng thấy</span>}>
      {gap.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, background: "var(--soft-amber)", color: "var(--amber)", borderRadius: 10, padding: "10px 12px", fontSize: 13, fontWeight: 600, marginBottom: 12, flexWrap: "wrap" }}>
          <span>⏰</span>
          <span>Sắp hết hạn thuê: {gap.map((x: any) => `${x.ten} (${x.con <= 0 ? "ĐÃ HẾT HẠN" : `còn ${x.con} ngày`})`).join(" · ")} — quên gia hạn là mất sóng cả máy.</span>
        </div>
      )}
      <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ minWidth: 150 }}>
          <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)" }}>Tổng mỗi tháng</span>
          <b className="tnum" style={{ display: "block", fontSize: 21, fontWeight: 800, margin: "2px 0 1px" }}>{money2(tong)}</b>
          <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>thuê máy + đọc/ghi dữ liệu</span>
        </div>
        <div style={{ minWidth: 150 }}>
          <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)" }}>Thuê máy</span>
          <b className="tnum" style={{ display: "block", fontSize: 17, fontWeight: 800, margin: "2px 0 1px" }}>{money2(tienMay)} / tháng</b>
          <span style={{ display: "block", fontSize: 11, color: chuaNhap > 0 ? "var(--amber)" : "var(--muted)" }}>
            {chuaNhap > 0 ? `${chuaNhap}/${machines.length} máy CHƯA nhập giá — tổng còn thiếu` : `đủ ${machines.length} máy`}
          </span>
        </div>
        {oCot("Đọc/ghi dữ liệu — hiện tại", `${nAll} luồng (${nLive} đang phát) · ${nVPS} máy`, now)}
        {oCot("Đọc/ghi — nếu lên 300 luồng", "300 luồng · 10 máy · 3 người xem", proj)}
      </div>
      {hetHan.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 12, paddingTop: 11, borderTop: "1px solid var(--line)" }}>
          <b style={{ color: "var(--ink)" }}>Hạn gia hạn:</b> {hetHan.map((x: any) => `${x.ten} ${x.ngay}${x.con >= 0 ? ` (còn ${x.con} ngày)` : " (đã hết hạn)"}`).join(" · ")}
        </div>
      )}
      <p className="plain" style={{ fontSize: 12, color: "var(--muted)", marginTop: 12, paddingTop: 11, borderTop: "1px solid var(--line)" }}>
        <b>Ước tính để cân nhắc mở rộng, không phải cảnh báo.</b> Tiền thuê máy do người nhập ở tab Máy live (bỏ trống thì không tính).
        Phần đọc/ghi tính từ <b>nhịp thật đang chạy</b>: máy báo về mỗi {POLL} giây · ảnh xem trước mỗi {THUMB} giây · màn hình làm mới mỗi {DASH} giây
        {WOC ? <> · <b>ghi-khi-đổi</b> đang bật (luồng ổn định chỉ ghi lại mỗi {WOC_SEC} giây)</> : null}
        {RC ? <> · <b>gộp lượt đọc</b> đang bật</> : null}. Giá Firestore đổi theo vùng nên con số chỉ để định hướng.
      </p>
    </Card>
  );
}

// Màu chip theo NHÓM NGUYÊN NHÂN (phân loại thông minh từ lý do kỹ thuật).
function causeColor(label: string): { bg: string; fg: string } {
  const l = String(label ?? "").toLowerCase();
  if (/file|video lỗi/.test(l)) return { bg: "var(--soft-red,#fdeaea)", fg: "var(--red,#b91c1c)" };
  if (/chặn|đình chỉ|từ chối|khoá/.test(l)) return { bg: "var(--soft-red,#fdeaea)", fg: "var(--red,#b91c1c)" };
  if (/chờ người|dừng chờ/.test(l)) return { bg: "var(--soft-red,#fdeaea)", fg: "var(--red,#b91c1c)" };
  if (/mạng|ngắt kết nối|gián đoạn/.test(l)) return { bg: "var(--soft-amber,#fff3dd)", fg: "var(--amber,#b45309)" };
  return { bg: "var(--surface2,#eef2f6)", fg: "var(--muted,#4b5563)" };
}
const fmtIncTime = (iso?: string): string => {
  const t = iso ? Date.parse(iso) : NaN;
  if (isNaN(t)) return "—";
  const d = new Date(t + 7 * 3600e3); // giờ VN
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} · ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`;
};

// NHẬT KÝ SỰ CỐ THEO VỤ VIỆC (Gđ3) — gom nhiều lần rớt LIÊN TIẾP của CÙNG luồng (cách nhau <15') thành
// 1 VỤ (mở→đóng): số lần rớt, tổng thời gian gián đoạn, khoảng thời gian, nguyên nhân. Sự cố đang treo
// (cần người / YouTube chặn / đang tụt-đen) = vụ ĐANG MỞ. Đọc thuần từ recentIncidents + cờ hiện tại,
// KHÔNG ghi gì. Bộ lọc: nhóm nguyên nhân · VPS · thời gian · tìm tên.
function IncidentLogPanel({ streams, machineName, nccMay = () => "", incidentLog = [] }: any) {
  const [cat, setCat] = useState("all");
  const [mch, setMch] = useState("all");
  const [range, setRange] = useState("48h");
  const [q, setQ] = useState("");
  // Danh sach nay gom CA vu DA QUA lan vu DANG MO -> rat dai (Chu Rise Group bao). Phai phan trang.
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(20);
  const [openOnly, setOpenOnly] = useState("all");   // all | open | closed
  useEffect(() => { setPage(1); }, [cat, mch, range, q, openOnly]);   // doi bo loc -> ve trang 1
  const GAP = 15 * 60 * 1000;   // <15 phút giữa 2 lần rớt = CÙNG một vụ việc
  const cases: any[] = [];
  for (const s of streams || []) {
    // `machineId` của một VỤ = máy ĐÓNG DẤU trên chính bản ghi sự cố, KHÔNG phải máy hiện tại của
    // luồng. Bản ghi cũ (trước 30/08/2026) chưa có dấu → để TRỐNG và hiện "không rõ máy", chứ KHÔNG
    // đổ cho máy đang chạy: luồng chuyển 03→05 mà gán hết lịch sử cho 05 thì bộ lọc theo máy đếm
    // nhầm, nhìn tưởng máy mới hay hỏng (Chủ Rise Group phát hiện). Kho chỉ giữ 10 sự cố gần nhất
    // mỗi luồng nên bản ghi cũ tự trôi hết sau một hai ngày.
    const base = { name: s.name, channel: s.channelName, machineId: "" };
    // 1) VỤ ĐANG MỞ (chưa đóng) từ cờ hiện tại — mỗi loại 1 vụ.
    if (s.ytIssue) cases.push({ ...base, machineId: s.machineId, open: true, at: s.ytIssue.at, endAt: null, cause: "YouTube chặn/đình chỉ", count: 1, downSec: null, reason: s.ytIssue.note || s.ytIssue.type || "Nghi YouTube chặn/đình chỉ", fix: "Kiểm tra YouTube Studio kênh này." });
    if (s.needsHuman || s.restartHalted) { const c = incidentCause(s.haltReason, nccMay(s.machineId)); cases.push({ ...base, machineId: s.machineId, open: true, at: s.lastHeartbeatAt, endAt: null, cause: c.label || "Dừng chờ người", count: 1, downSec: null, reason: s.haltReason || "Đã dừng, chờ người xử lý", fix: c.fix || "Kiểm tra nguồn/khoá rồi Lên sóng lại." }); }
    // 2) LỊCH SỬ rớt→tự phục hồi → gom liên tiếp thành VỤ.
    const evs = [...(s.recentIncidents ?? [])].filter((e: any) => e?.at).sort((a: any, b: any) => String(a.at).localeCompare(String(b.at)));
    let cur: any = null;
    for (const e of evs) {
      const t = Date.parse(e.at) || 0;
      if (cur && t - cur._last <= GAP) {
        cur.count++; cur.downSec = (cur.downSec || 0) + (Number(e.downSec) || 0); cur.endAt = e.at; cur._last = t; cur.reason = e.reason || cur.reason;
        const c = incidentCause(e.reason, nccMay(String(e.machineId ?? s.machineId))); if (c.label && c.label !== "Lỗi phát" && cur.cause === "Lỗi phát") { cur.cause = c.label; cur.fix = c.fix; }
      } else {
        if (cur) cases.push(cur);
        const c = incidentCause(e.reason);
        cur = { ...base, machineId: String(e.machineId ?? ""), open: false, at: e.at, endAt: e.at, cause: c.label || "Lỗi phát", fix: c.fix, count: 1, downSec: Number(e.downSec) || 0, reason: e.reason, _last: t };
      }
    }
    if (cur) {
      // Vụ gần nhất còn MỞ nếu luồng HIỆN đang có vấn đề (đang tụt / màn đen / sức khoẻ lỗi).
      if ((s.status === "live" && (s.slow || (s.black && !s.allowBlack))) || s.health === "error") { cur.open = true; cur.endAt = null; }
      cases.push(cur);
    }
  }
  const cats = Array.from(new Set(cases.map((r) => r.cause)));
  const mchIds = Array.from(new Set(cases.map((r) => r.machineId).filter(Boolean)));
  const now = Date.now(); const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const keyTime = (r: any) => Date.parse(r.endAt || r.at);   // xếp/lọc theo mốc mới nhất của vụ
  const filtered = cases.filter((r) => {
    if (cat !== "all" && r.cause !== cat) return false;
    if (mch !== "all" && r.machineId !== mch) return false;
    if (openOnly === "open" && !r.open) return false;      // chỉ vụ ĐANG MỞ (luồng hiện còn vấn đề)
    if (openOnly === "closed" && r.open) return false;     // chỉ vụ ĐÃ QUA (đã tự phục hồi / đã xử xong)
    if (q.trim() && !`${r.name} ${r.channel ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())) return false;
    const t = keyTime(r); if (isNaN(t)) return range === "all";
    if (range === "today") return t >= startToday.getTime();
    if (range === "48h") return now - t <= 48 * 3600e3;
    if (range === "7d") return now - t <= 7 * 86400e3;
    return true;
  }).sort((a, b) => (isNaN(keyTime(b)) ? 0 : keyTime(b)) - (isNaN(keyTime(a)) ? 0 : keyTime(a)));
  const openCount = cases.filter((r) => r.open).length;
  // Nhãn khoảng thời gian của 1 vụ. QUAN TRỌNG — 2 con số KHÁC NHAU, dễ hiểu lầm (Chủ Rise Group hỏi):
  //   • "rải trong 14 phút" = từ lần rớt ĐẦU tới lần rớt CUỐI của cùng vụ việc (các lần rớt cách nhau
  //     dưới 15 phút được gom làm 1 vụ). ĐÂY KHÔNG PHẢI thời gian luồng tắt sóng!
  //   • "mất sóng tổng 8s" (downSec) = CỘNG thời gian luồng THẬT SỰ tắt của từng lần rớt.
  // VD: rớt 2 lần, mỗi lần ~4s, cách nhau 14 phút → rải trong 14 phút nhưng chỉ mất sóng 8 giây.
  const spanLabel = (r: any) => {
    const a = fmtIncTime(r.at);
    if (r.open) return `${a} → đang tiếp`;
    if (!r.endAt || r.endAt === r.at) return a;
    const mins = Math.round((Date.parse(r.endAt) - Date.parse(r.at)) / 60000);
    return `${a} → ${fmtIncTime(r.endAt)}${mins > 0 ? ` (rải trong ${mins < 60 ? mins + " phút" : Math.round(mins / 6) / 10 + " giờ"})` : ""}`;
  };

  return (
    <Card title="🛠 Nhật ký sự cố (theo vụ việc)" action={openCount > 0 ? <span style={pillStyle("#fdeaea", "#b91c1c")}>⚠ {openCount} vụ đang mở</span> : <span style={pillStyle("#e7f6ee", "#15803d")}>Không có vụ đang mở</span>}>
      {/* Bộ lọc thông minh */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10, alignItems: "center" }}>
        <button onClick={() => setCat("all")} style={chip(cat === "all")}>Tất cả ({cases.length})</button>
        {cats.map((c) => { const col = causeColor(c); const n = cases.filter((r) => r.cause === c).length; return (
          <button key={c} onClick={() => setCat(c)} style={{ ...chip(cat === c), color: cat === c ? "#fff" : col.fg, borderColor: col.fg }}>{c} ({n})</button>
        ); })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <select value={range} onChange={(e) => setRange(e.target.value)} style={selStyle}><option value="today">Hôm nay</option><option value="48h">48 giờ</option><option value="7d">7 ngày</option><option value="all">Tất cả</option></select>
        <select value={mch} onChange={(e) => setMch(e.target.value)} style={selStyle}><option value="all">Mọi VPS</option>{mchIds.map((m) => <option key={m} value={m}>{machineName(m)}</option>)}</select>
        <select value={openOnly} onChange={(e) => setOpenOnly(e.target.value)} style={selStyle} title="Vụ ĐANG MỞ = luồng hiện còn vấn đề; ĐÃ QUA = đã tự phục hồi hoặc đã xử xong">
          <option value="all">Mọi trạng thái</option>
          <option value="open">⚠ Chỉ vụ đang mở</option>
          <option value="closed">✓ Chỉ vụ đã qua</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm tên luồng / kênh…" style={{ ...selStyle, minWidth: 190 }} />
      </div>

      {filtered.length === 0
        ? <div className="empty">Không có vụ sự cố nào khớp bộ lọc. 🎉</div>
        : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.slice((Math.min(page, Math.max(1, Math.ceil(filtered.length / perPage))) - 1) * perPage, Math.min(page, Math.max(1, Math.ceil(filtered.length / perPage))) * perPage).map((r, i) => { const col = causeColor(r.cause); return (
              <div key={i} style={{ border: "1px solid var(--line)", borderLeft: `3px solid ${col.fg}`, borderRadius: 10, padding: "9px 12px", background: r.open ? "var(--soft-amber,#fffaf5)" : "var(--card,#fff)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={pillStyle(col.bg, col.fg)}>{r.cause}</span>
                    {r.open ? <span style={pillStyle("#fdeaea", "#b91c1c")}>ĐANG mở</span> : <span style={pillStyle("#e7f6ee", "#15803d")}>đã qua</span>}
                    <b style={{ fontSize: 12.5 }}>{r.name}</b>
                    {r.channel && <small style={{ color: "var(--muted)" }}>· {r.channel}</small>}
                  </span>
                  <small style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{spanLabel(r)} · 🖥 {r.machineId ? machineName(r.machineId) : <span title="Bản ghi cũ (trước 30/08/2026) chưa đóng dấu máy. Thà nói không biết còn hơn đổ cho máy đang chạy tốt — luồng có thể đã chuyển máy sau sự cố.">không rõ máy</span>}</small>
                </div>
                <div style={{ fontSize: 11, color: "#627184", marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {r.count > 1 && <span>↺ rớt <b>{r.count}</b> lần</span>}
                  {r.downSec != null && r.downSec > 0 && <span title="Cộng thời gian luồng THẬT SỰ tắt sóng của từng lần rớt — khác với khoảng thời gian vụ việc trải dài">⏱ <b style={{ color: r.downSec >= 60 ? "var(--red,#b91c1c)" : "inherit" }}>mất sóng tổng {r.downSec >= 60 ? Math.round(r.downSec / 6) / 10 + " phút" : r.downSec + "s"}</b></span>}
                </div>
                {r.reason && <div style={{ fontSize: 11, color: "#627184", marginTop: 4, wordBreak: "break-word" }} title={r.reason}>{String(r.reason).slice(0, 160)}</div>}
                {r.fix && <div style={{ fontSize: 10.5, color: "#8a6a1e", marginTop: 3 }}>💡 {r.fix}</div>}
              </div>
            ); })}
          </div>}
      {filtered.length > perPage && (
        <Pager total={filtered.length} page={page} perPage={perPage} onPage={setPage} onPerPage={(n) => { setPerPage(n); setPage(1); }} />
      )}
      <p className="plain" style={{ fontSize: 11, color: "var(--muted)", marginTop: 12 }}>Mỗi luồng giữ ~10 lần rớt gần nhất; nhiều lần rớt liên tiếp (cách nhau dưới 15 phút) được gom thành <b>1 vụ việc</b>. Vụ "đang mở" = luồng hiện còn vấn đề (chờ người / YouTube chặn / đang tụt-đen).
        <br /><b>Đọc 2 con số cho đúng:</b> “<i>rải trong 14 phút</i>” = từ lần rớt đầu tới lần rớt cuối của vụ đó — <b>KHÔNG phải</b> luồng tắt 14 phút. “<i>mất sóng tổng 8s</i>” mới là thời gian khán giả thật sự bị gián đoạn (cộng từng lần rớt). Ví dụ: rớt 2 lần × 4 giây, cách nhau 14 phút → rải trong 14 phút nhưng chỉ mất sóng 8 giây.</p>

      {incidentLog.length > 0 && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "var(--ink,#0b1c35)", marginBottom: 4 }}>📜 Lịch sử sự cố đã xử lý ({incidentLog.length})</div>
          <p className="plain" style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px" }}>Giữ lại kể cả khi luồng ĐÃ DỪNG / đã bỏ cờ — ghi lúc bấm Dừng luồng đang lỗi hoặc Bỏ cờ YouTube (mốc giờ · người xử · lý do).</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {incidentLog.map((e: any) => { const col = causeColor(e.cause); return (
              <div key={e.id} style={{ border: "1px solid var(--line)", borderLeft: `3px solid ${col.fg}`, borderRadius: 10, padding: "8px 12px", background: "var(--surface2,#fbfcfe)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={pillStyle(col.bg, col.fg)}>{e.cause}</span>
                    <span style={pillStyle("#eef1f4", "#556677")}>{e.resolution === "cleared_yt_flag" ? "đã bỏ cờ YT" : "đã dừng"}</span>
                    <b style={{ fontSize: 12.5 }}>{e.streamName}</b>
                  </span>
                  <small style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{String(e.resolvedAt ?? "").slice(0, 16).replace("T", " ")} · 🖥 {machineName(e.machineId)}</small>
                </div>
                {e.reason && <div style={{ fontSize: 11, color: "#627184", marginTop: 3, wordBreak: "break-word" }} title={e.reason}>{String(e.reason).slice(0, 160)}</div>}
                <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 3 }}>Người xử: {e.resolvedByName || e.resolvedBy || "—"}</div>
              </div>
            ); })}
          </div>
        </div>
      )}
    </Card>
  );
}
const pillStyle = (bg: string, fg: string): React.CSSProperties => ({ background: bg, color: fg, borderRadius: 99, padding: "2px 9px", fontSize: 10.5, fontWeight: 700, whiteSpace: "nowrap" });
const chip = (on: boolean): React.CSSProperties => ({ border: "1px solid var(--line)", background: on ? "var(--sel,#17375f)" : "var(--card,#fff)", color: on ? "var(--sel-ink,#fff)" : "var(--ink)", borderRadius: 99, padding: "5px 11px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" });
const selStyle: React.CSSProperties = { border: "1px solid var(--line)", borderRadius: 8, padding: "7px 10px", fontSize: 12, background: "var(--bg,#fafbfd)" };

function StreamsPanel({ locCanhBao = [], boLocCanhBao, d, streams, readyAssets, machines, presets, machineName, assetName, presetLabel, safety, post, rawPost, busy, flash, ytByCh = {}, afterControl }: any) {
  const [hoi, setHoi] = useState<YeuCauNhap | null>(null);   // hộp hỏi/nhập dùng chung
  const uc = d?.uploadConfig;   // {httpsUrl, token} để tải ảnh thật đang phát từ máy live
  // "Không xanh giả": máy của luồng còn kết nối không (máy vẫn báo ~20s/lần). Máy offline → không tin
  // trạng thái luồng cũ (có thể vẫn hiện "live"). Trả undefined nếu không rõ máy (đừng gắn cờ oan).
  const machineOnline = (id: string): boolean | undefined => { const m = machines.find((x: any) => x.id === id); return m ? m.online !== false : undefined; };
  const mob = useIsMobile();    // điện thoại → dùng thẻ thay bảng
  const empty = { name: "", channelId: "", assetIds: [] as string[], playMode: "sequence", machineId: "", streamKey: "", watchUrl: "", mode: "stream-247", control: "manual", scheduleStart: "", scheduleDurationMin: "", scheduleRepeat: "none", allowBlack: false, priority: false };
  const addAsset = (aid: string) => setF((p: any) => p.assetIds.includes(aid) ? p : ({ ...p, assetIds: [...p.assetIds, aid] }));
  const removeAsset = (aid: string) => setF((p: any) => ({ ...p, assetIds: p.assetIds.filter((x: string) => x !== aid) }));
  const moveAsset = (i: number, dir: number) => setF((p: any) => { const arr = [...p.assetIds]; const j = i + dir; if (j < 0 || j >= arr.length) return p; [arr[i], arr[j]] = [arr[j], arr[i]]; return { ...p, assetIds: arr }; });
  const [f, setF] = useState<any>(empty);
  const [vidQ, setVidQ] = useState("");   // tìm nhanh video khi chọn (kho nhiều video)
  const shortNm = (n: any) => { const s = String(n || "(video)"); return s.length > 52 ? s.slice(0, 50) + "…" : s; };
  // Chuẩn hoá để TÌM: bỏ dấu tiếng Việt + gộp khoảng trắng (kể cả nbsp/zero-width) + thường hoá →
  // paste NGUYÊN tên vẫn khớp dù tên gốc có dấu/khoảng trắng đặc biệt (sửa bug "10 ký tự mới thấy").
  const searchNorm = (s: any) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const [editId, setEditId] = useState<string | null>(null);
  const [flt, setFlt] = useState("all"); const [q, setQ] = useState(""); const [pageNum, setPageNum] = useState(1); const [perPage, setPerPage] = useState(30);
  const [fltMachine, setFltMachine] = useState(""); const [fltUnit, setFltUnit] = useState(""); const [fltCreator, setFltCreator] = useState(""); const [fltRecon, setFltRecon] = useState("");
  const clearFilters = () => { setFlt("all"); setQ(""); setFltMachine(""); setFltUnit(""); setFltCreator(""); setFltRecon(""); setPageNum(1); };
  const [channels, setChannels] = useState<any[]>([]);
  const [grpByCh, setGrpByCh] = useState(false); const [openG, setOpenG] = useState<Record<string, boolean>>({});
  // R-LAYOUT Đợt 2 — MẬT ĐỘ hiển thị luồng. Mặc định "Gọn" (thẻ) vì việc chính ở đây là QUÉT
  // 110 luồng tìm cái đang lỗi. Giữ "Bảng" cho ai quen cách cũ (đã bỏ luật cấm xuống dòng).
  const [den, setDen] = useState<"tight" | "full" | "table">("tight");
  useEffect(() => { try { const v = localStorage.getItem("riseLiveDen"); if (v === "tight" || v === "full" || v === "table") setDen(v); } catch { /* bỏ qua */ } }, []);
  const pickDen = (v: "tight" | "full" | "table") => { setDen(v); try { localStorage.setItem("riseLiveDen", v); } catch { /* bỏ qua */ } };
  // Số thứ tự luồng theo THỨ TỰ TẠO (cũ nhất = 1, luồng mới = số LỚN hơn). streams đã sắp mới-nhất-đầu
  // nên rank = tổng - vị trí. Số này gắn với luồng, không đổi theo lọc/phân trang/gom nhóm.
  const seqOf: Record<string, number> = {}; streams.forEach((s: any, i: number) => { seqOf[s.id] = streams.length - i; });
  const reloadChannels = () => rawPost({ action: "list_channels" }).then((r: any) => { if (r?.channels) setChannels(r.channels); }).catch(() => {});
  useEffect(() => { void reloadChannels(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Khi chọn kênh: tự điền link live từ URL kênh nếu đang trống.
  const pickChannel = (cid: string) => {
    const ch = channels.find((c) => c.id === cid);
    const live = ch?.liveUrl ?? "";   // LINK VIDEO LIVE THẬT (từ L3, nếu kênh đang phát) — KHÔNG dùng link @handle của kênh.
    // CHỐNG TRÙNG luồng: link live này (1 video YouTube) đã có luồng KHÁC đang dùng → tạo luồng THỨ 2
    // trên cùng kênh phải là 1 video KHÁC, KHÔNG tự điền lại link cũ (trùng → 2 luồng lẫn trạng thái nhau).
    const vid = ytVideoId(live);
    const usedByOther = !!vid && streams.some((s: any) => s.id !== editId && ytVideoId(s.watchUrl) === vid);
    const willFill = !f.watchUrl && !!live && !usedByOther;
    setF((prev: any) => ({ ...prev, channelId: cid, watchUrl: prev.watchUrl || (usedByOther ? "" : live) }));
    if (cid && willFill) flash?.("✅ Đã tự điền link video LIVE của kênh (đang phát).");
    else if (cid && usedByOther) flash?.("⚠ Kênh đang có luồng phát rồi. Tạo luồng THỨ 2 → để TRỐNG link video (mỗi luồng 1 video khác) — hệ thống tự nhận diện khi lên sóng, hoặc dán ĐÚNG link video mới.");
    else if (cid && !live && !f.watchUrl) flash?.("Đã gắn kênh. Kênh chưa đang live → dán LINK VIDEO live thủ công (không phải link kênh).");
  };
  const submit = async () => {
    // BẮT BUỘC link video live (dùng API theo dõi luồng). Nếu gắn kênh có sẵn link thì máy chủ tự mượn.
    if (!String(f.watchUrl || "").trim() && !f.channelId) { flash?.("Cần dán LINK VIDEO LIVE (YouTube) — hệ thống dùng để tự theo dõi luồng bằng API. (Hoặc gắn kênh đã có link.)"); return; }
    // Batch 2: chỉ CHẶN gán luồng mới vào máy offline/bảo trì/đã đầy (luồng đang chạy không đụng).
    if (!editId && selBlocked && selM) { flash?.(`⛔ Không gán được luồng mới vào máy "${selM.name}" (${!mUsable(selM) ? (selM.maintenance ? "đang bảo trì" : "offline") : "đã đầy"}). Chọn máy khác.`); return; }
    if (editId) { if (await post({ action: "edit_stream", id: editId, ...f }, "Đã lưu thay đổi. Bấm “Lên sóng” khi muốn phát.")) { setEditId(null); setF(empty); } }
    else if (await post({ action: "create_stream", ...f }, f.control === "schedule" ? "Đã tạo luồng — sẽ tự lên sóng đúng giờ." : "Đã tạo luồng — đang lên sóng.")) setF(empty);
  };
  // Sửa luồng CHƯA chạy: nạp lại thông số vào form (lấy khoá thật vì chủ luồng — có audit).
  const startEdit = async (s: any) => {
    const kr = await rawPost({ action: "get_stream_key", id: s.id }); const sch = s.schedule ?? {};
    setF({
      name: s.name ?? "", channelId: s.channelId ?? "",
      assetIds: (Array.isArray(s.assetIds) && s.assetIds.length ? s.assetIds : (s.assetId ? [s.assetId] : [])), playMode: s.playMode === "random" ? "random" : "sequence",
      machineId: s.machineId ?? "", streamKey: kr?.streamKey ?? "", watchUrl: s.watchUrl ?? "",
      mode: s.mode === "live-pub" ? "live-pub" : "stream-247",
      control: s.control === "schedule" ? "schedule" : "manual",
      scheduleStart: sch.start ?? "", scheduleDurationMin: sch.durationMin ? String(sch.durationMin) : "", scheduleRepeat: sch.repeat ?? "none",
      allowBlack: s.allowBlack === true, priority: s.priority === true,
    });
    setEditId(s.id);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const cancelEdit = () => { setEditId(null); setF(empty); };
  const rename = (s: any) => setHoi({
    tieuDe: "Đổi tên luồng", nhan: "Tên luồng", batBuoc: true, giaTriDau: s.name,
    moTa: "Chỉ đổi tên hiển thị để dễ tìm — KHÔNG ảnh hưởng gì tới luồng đang phát.",
    nutXacNhan: "Đổi tên",
    xong: (n: string) => { if (n && n !== s.name) void post({ action: "rename_stream", id: s.id, name: n }, "Đã đổi tên."); },
  });
  const selA = readyAssets.find((a: any) => a.id === f.assetIds[0]); const selM = machines.find((m: any) => m.id === f.machineId);
  const selP = selA ? presets.find((p: any) => p.id === selA.presetId) : null;
  const left = selM && selP ? streamsLeft(selM, selP, safety) : null;
  // ── Chọn VPS thông minh (Batch 2): gợi ý/sắp xếp/cảnh báo — NHÂN SỰ vẫn tự chọn ──
  const cheapestPreset = [...presets].sort((a: any, b: any) => (Number(a.bandwidthMbps) || 0) - (Number(b.bandwidthMbps) || 0))[0];
  const estPreset = selP ?? cheapestPreset;
  const mRoleLabel = (r: string) => r === "live-pub" ? "Live Pub" : r === "shared" ? "Dùng chung" : "Live 24/7";
  const mStatus = (m: any) => m?.maintenance ? "Bảo trì" : (m?.online ? "Online" : "Offline");
  const mUsable = (m: any) => !!m?.online && !m?.maintenance;
  const mLeft = (m: any) => estPreset ? streamsLeft(m, estPreset, safety) : null;
  const mRoleMatch = (m: any) => !f.mode || !m?.role || m.role === f.mode || m.role === "shared";
  const mRank = (m: any) => (mUsable(m) ? 0 : 100) + (((mLeft(m) ?? 1) > 0) ? 0 : 50) + (m.role === f.mode ? 0 : m.role === "shared" ? 5 : 10);
  const sortedMachines = [...machines].sort((a: any, b: any) => mRank(a) - mRank(b));
  const selLeft = selM ? mLeft(selM) : null;
  const selBlocked = !!selM && (!mUsable(selM) || (selLeft != null && selLeft <= 0));
  return (
    <>
      <HopNhapChu yeuCau={hoi} dong={() => setHoi(null)} />
      <Card title={editId ? "✏️ Sửa luồng (chưa chạy)" : "🔴 Tạo luồng phát mới"} action={editId ? <Pill tone="amber">đang sửa</Pill> : undefined}>
        {readyAssets.length === 0 && !editId ? (
          <p className="plain">Chưa có video <b>sẵn sàng</b>. Vào <b>Kho video</b> thêm video + chờ nén xong đã.</p>
        ) : (
          <>
            <div className="form" style={{ alignItems: "start" }}>
              <Field label="Tên luồng (để nhận biết)"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="VD: Nhạc thư giãn 24/7 — Kênh A" /></Field>
              <Field label="Kênh (gắn để dễ quản lý — tuỳ chọn)"><ChannelPicker channels={channels} value={f.channelId} onPick={pickChannel} onFocusReload={reloadChannels} /></Field>
              <Field label={f.assetIds.length ? `Video — đã chọn ${f.assetIds.length}${f.assetIds.length > 1 ? " (danh sách phát)" : ""}` : "Video (chọn 1; muốn phát nhiều thì thêm tiếp)"}>
                {readyAssets.length > 6 && (
                  <input value={vidQ} onChange={(e) => setVidQ(e.target.value)} placeholder="🔍 Tìm video theo tên…" style={{ marginBottom: 6, padding: "7px 11px", borderRadius: 8, border: "1px solid var(--line,#e5e7eb)", width: "100%", fontSize: 13, boxSizing: "border-box" }} />
                )}
                <select value="" onChange={(e) => { if (e.target.value) { addAsset(e.target.value); setVidQ(""); } }}>
                  <option value="">{!f.machineId ? "— Chọn MÁY PHÁT trước —" : f.assetIds.length ? "＋ Thêm video vào danh sách…" : "— Chọn video —"}</option>
                  {/* CHỈ hiện video ĐÃ TẢI LÊN đúng MÁY PHÁT đang chọn — video lưu cục bộ từng VPS,
                      chọn video của máy khác → luồng đứng "queued" (máy không có file). */}
                  {readyAssets.filter((a: any) => f.machineId && a.machineId === f.machineId).filter((a: any) => !f.assetIds.includes(a.id)).filter((a: any) => !vidQ.trim() || searchNorm(a.name).includes(searchNorm(vidQ))).map((a: any) => <option key={a.id} value={a.id}>{shortNm(a.name)} · {presetLabel(a.presetId)}</option>)}
                </select>
                {f.machineId && readyAssets.filter((a: any) => a.machineId === f.machineId).length === 0 && (
                  <p className="plain" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--amber,#c98617)" }}>⚠ Máy này chưa có video nào — hãy tải video LÊN ĐÚNG MÁY này (công cụ Cài worker → IP của máy) rồi chọn lại.</p>
                )}
                {f.assetIds.some((id: string) => { const a = readyAssets.find((x: any) => x.id === id); return a && f.machineId && a.machineId !== f.machineId; }) && (
                  <p className="plain" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--red,#c95050)", fontWeight: 700 }}>⛔ Có video đã chọn KHÔNG thuộc máy phát này → luồng sẽ đứng "queued". Bỏ chọn hoặc đổi máy cho khớp.</p>
                )}
              </Field>
              {f.assetIds.length > 0 && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <div style={{ border: "1px solid var(--border,#e2e7ee)", borderRadius: 8, padding: 4 }}>
                    {f.assetIds.map((id: string, i: number) => { const a = readyAssets.find((x: any) => x.id === id);
                      return (
                        <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderTop: i ? "1px solid var(--border,#f0f3f7)" : "none", fontSize: 13 }}>
                          {f.assetIds.length > 1 ? <b style={{ color: "var(--rl,#0e8f84)", flex: "0 0 auto" }}>{i + 1}.</b> : null}
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a?.name || "(video)"} <small style={{ color: "var(--muted)" }}>· {presetLabel(a?.presetId)}</small></span>
                          {f.assetIds.length > 1 ? <>
                            <button type="button" onClick={() => moveAsset(i, -1)} disabled={i === 0} title="Lên" style={{ border: "none", background: "none", cursor: "pointer", opacity: i === 0 ? .3 : 1 }}>↑</button>
                            <button type="button" onClick={() => moveAsset(i, 1)} disabled={i === f.assetIds.length - 1} title="Xuống" style={{ border: "none", background: "none", cursor: "pointer", opacity: i === f.assetIds.length - 1 ? .3 : 1 }}>↓</button>
                          </> : null}
                          <button type="button" onClick={() => removeAsset(id)} title="Bỏ" style={{ border: "none", background: "none", cursor: "pointer", color: "#dc2626", fontSize: 14 }}>✕</button>
                        </div>
                      );
                    })}
                  </div>
                  {f.assetIds.length > 1 && (
                    <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Kiểu phát:</span>
                      <select value={f.playMode} onChange={(e) => setF({ ...f, playMode: e.target.value })} style={{ padding: "4px 8px", borderRadius: 6 }}><option value="sequence">▶ Nối tiếp</option><option value="random">🔀 Ngẫu nhiên</option></select>
                    </div>
                  )}
                </div>
              )}
              <Field label="Máy phát (VPS) — máy phù hợp xếp trên"><select value={f.machineId} onChange={(e) => setF({ ...f, machineId: e.target.value })}><option value="">— Chọn máy —</option>{sortedMachines.map((m: any) => { const l = mLeft(m); const cap = l == null ? "" : l <= 0 ? " · đã đầy" : ` · còn ~${l}`; const full = bwFull(m) && f.mode !== "live-pub"; return <option key={m.id} value={m.id} disabled={full}>{m.name} · {mRoleLabel(m.role)} · {m.liveCount ?? 0} luồng{cap}{bwLabel(m)} · {mStatus(m)}</option>; })}</select></Field>
              <Field label="Khoá luồng YouTube"><input value={f.streamKey} onChange={(e) => setF({ ...f, streamKey: e.target.value })} placeholder="Dán mã khoá lấy từ YouTube Studio" /></Field>
              <Field label="Link video live (YouTube) — BẮT BUỘC"><input value={f.watchUrl} onChange={(e) => setF({ ...f, watchUrl: e.target.value })} placeholder="https://youtube.com/watch?v=… (dán link phát trực tiếp)" style={{ borderColor: (!String(f.watchUrl || "").trim() && !f.channelId) ? "#e0a34a" : undefined }} /></Field>
              <Field label="Loại"><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value, priority: e.target.value === "live-pub" ? false : f.priority })}><option value="stream-247">Live 24/7</option><option value="live-pub">Live Pub</option></select></Field>
              <Field label="Điều khiển"><select value={f.control} onChange={(e) => setF({ ...f, control: e.target.value })}><option value="manual">Bật/tắt bằng tay</option><option value="schedule">Hẹn giờ (tự bật/tắt)</option></select></Field>
              {f.mode === "live-pub" ? (
                <Field label="Kênh ưu tiên" wide>
                  <div style={{ fontSize: 12, color: "var(--muted)" }} title="Luồng Pub bật auto-stop: khi sự cố, YouTube tự kết thúc buổi phát nên dự phòng/tự cứu vô nghĩa. Muốn được bảo vệ tự động, chọn Loại = Live 24/7.">🔒 <b>Luồng Pub</b> không dùng dự phòng/tự cứu — YouTube tự đóng buổi phát khi sự cố. Muốn được bảo vệ, chọn <b>Loại = Live 24/7</b>.</div>
                </Field>
              ) : (
                <Field label="Kênh ưu tiên" wide>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, cursor: "pointer", color: "var(--muted)" }} title="Khi luồng gặp sự cố sẽ CẢNH BÁO MẠNH HƠN (nâng mức) và được ƯU TIÊN xử lý/phục hồi trước. Dùng cho kênh không được phép chết lâu.">
                    <input type="checkbox" checked={!!f.priority} onChange={(e) => setF({ ...f, priority: e.target.checked })} />
                    <span><b>⭐ Kênh quan trọng</b> — cảnh báo mạnh hơn, ưu tiên phục hồi <span style={{ opacity: .55 }}>ⓘ</span></span>
                  </label>
                </Field>
              )}
            </div>
            {f.control === "schedule" && (
              <div className="form" style={{ marginTop: 8, background: "var(--card,#f8fafc)", border: "1px solid var(--border,#eef2f7)", borderRadius: 10, padding: 12 }}>
                <Field label="Bắt đầu (giờ Việt Nam)"><input type="datetime-local" value={f.scheduleStart} onChange={(e) => setF({ ...f, scheduleStart: e.target.value })} /></Field>
                {f.mode === "live-pub" ? (
                  <>
                    <Field label="Thời lượng">
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <input style={{ width: 62 }} inputMode="numeric" placeholder="giờ" aria-label="Số giờ"
                          value={f.scheduleDurationMin === "" ? "" : Math.floor((Number(f.scheduleDurationMin) || 0) / 60)}
                          onChange={(e) => { const h = Math.max(0, parseInt(e.target.value || "0", 10) || 0); const cur = Number(f.scheduleDurationMin) || 0; const m = cur % 60; setF({ ...f, scheduleDurationMin: String(h * 60 + m) }); }} />
                        <span style={{ color: "var(--muted)", fontSize: 13 }}>giờ</span>
                        <input style={{ width: 62 }} inputMode="numeric" placeholder="phút" aria-label="Số phút"
                          value={f.scheduleDurationMin === "" ? "" : (Number(f.scheduleDurationMin) || 0) % 60}
                          onChange={(e) => { const m = Math.max(0, parseInt(e.target.value || "0", 10) || 0); const cur = Number(f.scheduleDurationMin) || 0; const h = Math.floor(cur / 60); setF({ ...f, scheduleDurationMin: String(h * 60 + m) }); }} />
                        <span style={{ color: "var(--muted)", fontSize: 13 }}>phút</span>
                        {f.scheduleDurationMin !== "" && (Number(f.scheduleDurationMin) || 0) > 0 ? <span style={{ fontSize: 12, color: "var(--muted)" }}>= {f.scheduleDurationMin} phút</span> : null}
                      </div>
                    </Field>
                    <Field label="Lặp lại"><select value={f.scheduleRepeat} onChange={(e) => setF({ ...f, scheduleRepeat: e.target.value })}><option value="none">1 lần</option><option value="daily">Hằng ngày (cùng giờ)</option></select></Field>
                    <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--muted)", marginTop: -2 }}>Hết thời lượng buổi phát tự kết thúc. <b>Lặp lại “Hằng ngày”</b> = mỗi ngày tự lên sóng lại đúng khung giờ này; <b>“1 lần”</b> = chỉ phát một buổi.</div>
                  </>
                ) : (
                  <div style={{ gridColumn: "1 / -1", fontSize: 12.5, color: "var(--muted)", alignSelf: "center" }}>
                    ▶️ <b>Live 24/7</b> sẽ phát <b>liên tục</b> từ giờ bắt đầu (video tự lặp lại vô hạn) — không cần thời lượng hay số lần lặp. Dừng bằng nút khi cần.
                  </div>
                )}
              </div>
            )}
            {selM && (
              <div style={{ marginTop: 8, fontSize: 12.5 }}>
                {!mUsable(selM)
                  ? <span style={{ color: "var(--red,#dc2626)" }}>⛔ Máy "{selM.name}" đang <b>{selM.maintenance ? "bảo trì" : "offline"}</b> — không thể gán luồng mới. Hãy chọn máy khác.</span>
                  : (selLeft != null && selLeft <= 0)
                    ? <span style={{ color: "var(--red,#dc2626)" }}>⛔ Máy "{selM.name}" đã <b>đầy</b> ở mức này — chọn máy khác hoặc chất lượng nhẹ hơn.</span>
                    : <>
                        {!mRoleMatch(selM) && <div style={{ color: "var(--amber,#b45309)" }}>⚠ Máy "{selM.name}" được ưu tiên cho <b>{mRoleLabel(selM.role)}</b>. Bạn vẫn dùng được, nhưng hệ thống khuyến nghị chọn máy <b>{mRoleLabel(f.mode)}</b>.</div>}
                        {selLeft != null && <div style={{ color: "var(--green,#16a34a)" }}>📶 Máy "{selM.name}" còn chạy thêm được <b>khoảng {selLeft} luồng</b> ở mức này — an toàn.</div>}
                      </>}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
              <button className="primary small" disabled={busy} onClick={submit}>{editId ? "Lưu thay đổi" : "Tạo & lên sóng"}</button>
              {editId && <button className="rowbtn" disabled={busy} onClick={cancelEdit}>Huỷ sửa</button>}
              {editId && <span style={{ fontSize: 12, color: "var(--muted)" }}>Sửa xong luồng vẫn ở trạng thái <b>dừng</b> — bấm “Lên sóng” khi muốn phát.</span>}
            </div>
          </>
        )}
      </Card>

      {locCanhBao.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", marginBottom: 10, padding: "9px 12px", borderRadius: 10,
          background: "var(--soft-amber)", color: "var(--amber)", fontSize: 13, fontWeight: 600 }}>
          <span>⚠️</span>
          <span>Đang chỉ hiện <b>{locCanhBao.length} luồng đang có cảnh báo</b> — các luồng khác tạm ẩn.</span>
          <button className="rowbtn" style={{ marginLeft: "auto" }} onClick={() => boLocCanhBao?.()}>Hiện tất cả luồng</button>
        </div>
      )}
      <Card title="🔴 Luồng & Lịch phát" action={<Pill tone="blue">{streams.filter((s: any) => s.status === "live").length} đang phát</Pill>}>
        {streams.length === 0 ? <p className="empty" style={{ margin: 0 }}>Chưa có luồng nào.</p> : (() => {
          const tabs: [string, string][] = [["all", "Tất cả"], ["247", "Live 24/7"], ["pub", "Live Pub"], ["live", "Đang phát"], ["upcoming", "Sắp phát"], ["stopped", "Đã dừng / xong"], ["error", "Lỗi"], ["priority", "⭐ Ưu tiên"], ["nobackup", "⚠ Thiếu dự phòng"]];
          const ql = q.trim().toLowerCase();
          // "Có vấn đề" = lỗi/sập · NGHI YouTube chặn (ytIssue) · chớp tắt đã ngừng (restartHalted) ·
          // đang tụt tốc độ (slow) · màn đen kéo dài (không phải chủ ý). Bo gom cho tab "Lỗi".
          const hasIssue = (s: any) => s.status === "error" || s.health === "error" || !!s.ytIssue || !!s.restartHalted
            || (s.status === "live" && (!!s.slow || (!!s.black && !s.allowBlack)));
          const machineOpts = machines.filter((m: any) => streams.some((s: any) => s.machineId === m.id)).map((m: any) => ({ id: m.id, name: m.name }));
          const unitOpts = Array.from(new Set(streams.map((s: any) => s.createdByUnit).filter(Boolean))) as string[];
          // Người phụ trách CHỈ liệt kê người của đơn vị đang lọc (nếu có chọn đơn vị).
          const creatorOpts = Array.from(new Set(streams.filter((s: any) => !fltUnit || (s.createdByUnit ?? "") === fltUnit).map((s: any) => s.createdByName).filter(Boolean))) as string[];
          const kept = streams.filter((s: any) => {
            if (flt === "247" && s.mode === "live-pub") return false;
            if (flt === "pub" && s.mode !== "live-pub") return false;
            if (flt === "live" && s.status !== "live") return false;
            if (flt === "upcoming" && !(s.control === "schedule" && !s.scheduleActive && s.nextStartISO)) return false;
            // "Đã dừng / xong" = KHÔNG đang phát + KHÔNG phải lịch sắp tới (đã dừng tay / đã phát xong).
            if (flt === "stopped" && (s.status === "live" || (s.control === "schedule" && !s.scheduleActive && s.nextStartISO))) return false;
            if (flt === "error" && !hasIssue(s)) return false;
            // Chu Rise 28/08: can loc nhanh "luong uu tien nao dang THIEU du phong"
            // de kiem tra dinh ky — truoc phai cuon tay qua tung the.
            // Tinh "uu tien" GIONG HET cach the hien thi va cach may tu-cuu doc:
            // importance moi THANG; chi khi chua dat moi suy tu co priority CU.
            // (Truoc day OR ca hai -> luong da chuyen ve "Thuong" nhung con co cu
            //  van bi loc vao "Thieu du phong" trong khi the ghi "Thuong".)
            const impHD = String(s.importance || (s.priority ? "priority" : "normal"));
            const uuTien = impHD === "priority" || impHD === "critical";
            if (flt === "priority" && !uuTien) return false;
            if (flt === "nobackup" && !(uuTien && s.backup && !s.backup.hasReplica)) return false;
            // Đang xem "luồng đang cảnh báo" (bấm từ ô Cần chú ý ngay) → chỉ hiện đúng những luồng đó.
            if (locCanhBao.length > 0 && !locCanhBao.includes(s.id)) return false;
            if (fltMachine && s.machineId !== fltMachine) return false;
            if (fltUnit && (s.createdByUnit ?? "") !== fltUnit) return false;
            if (fltCreator && (s.createdByName ?? "") !== fltCreator) return false;
            if (fltRecon) {
              const y: any = ytByCh?.[s.channelId]; const liveM = s.status === "live";
              const ytLive = y?.youtubeState?.broadcastStatus === "live"; const ytNone = y?.youtubeState?.broadcastStatus === "none";
              const oauthLost = y?.connectionState === "REVOKED" || y?.connectionState === "REAUTH_REQUIRED";
              if (fltRecon === "ok" && !(liveM && ytLive)) return false;
              if (fltRecon === "mismatch" && !(liveM && ytNone)) return false;
              if (fltRecon === "unverified" && (ytLive || ytNone)) return false;
              if (fltRecon === "oauth" && !oauthLost) return false;
            }
            if (ql && !(String(s.name).toLowerCase().includes(ql) || String(assetName(s.assetId)).toLowerCase().includes(ql) || String(s.createdByName ?? "").toLowerCase().includes(ql) || String(s.createdByUnit ?? "").toLowerCase().includes(ql) || String(s.channelName ?? "").toLowerCase().includes(ql))) return false;
            return true;
          });
          const per = perPage; const totalPages = Math.max(1, Math.ceil(kept.length / per)); const cur = Math.min(pageNum, totalPages);
          const page = kept.slice((cur - 1) * per, cur * per);
          const fromN = kept.length === 0 ? 0 : (cur - 1) * per + 1; const toN = Math.min(cur * per, kept.length);
          return (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {tabs.map(([id, lb]) => (
                    <button key={id} onClick={() => { setFlt(id); setPageNum(1); }} style={{ border: "1px solid " + (flt === id ? "var(--rl,#0e8f84)" : "var(--border,#e2e7ee)"), background: flt === id ? "var(--rl,#0e8f84)" : "transparent", color: flt === id ? "#fff" : "var(--ink)", borderRadius: 999, padding: "4px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>{lb}</button>
                  ))}
                </div>
                <input placeholder="🔎 Tìm luồng / video / người tạo / kênh…" value={q} onChange={(e) => { setQ(e.target.value); setPageNum(1); }} style={{ flex: "1 1 170px", minWidth: 140, padding: "6px 10px", border: "1px solid var(--border,#e2e7ee)", borderRadius: 8, fontSize: 13 }} />
                <div style={{ display: "flex", gap: 0, border: "1px solid var(--border,#e2e7ee)", borderRadius: 8, overflow: "hidden" }}>
                  {([["list", "Danh sách"], ["ch", "Theo kênh"]] as [string, string][]).map(([id, lb]) => (
                    <button key={id} onClick={() => setGrpByCh(id === "ch")} style={{ border: "none", background: (grpByCh === (id === "ch")) ? "var(--rl,#0e8f84)" : "transparent", color: (grpByCh === (id === "ch")) ? "#fff" : "var(--ink)", padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>{lb}</button>
                  ))}
                </div>
                {/* R-LAYOUT Đợt 2 — mật độ: Gọn (mặc định) · Đầy đủ · Bảng (cách cũ) */}
                {!mob && (
                  <div style={{ display: "flex", gap: 0, border: "1px solid var(--border,#e2e7ee)", borderRadius: 8, overflow: "hidden" }} title="Cách hiển thị danh sách luồng">
                    {([["tight", "Gọn"], ["full", "Đầy đủ"], ["table", "Bảng"]] as ["tight" | "full" | "table", string][]).map(([id, lb]) => (
                      <button key={id} onClick={() => pickDen(id)} style={{ border: "none", background: den === id ? "var(--rl,#0e8f84)" : "transparent", color: den === id ? "#fff" : "var(--ink)", padding: "6px 11px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>{lb}</button>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10, fontSize: 12.5 }}>
                {(() => { const ss: any = { padding: "5px 9px", borderRadius: 8, border: "1px solid var(--border,#e2e7ee)", background: "var(--card)", fontSize: 12.5, color: "var(--ink)" }; return <>
                  <select value={fltMachine} onChange={(e) => { setFltMachine(e.target.value); setPageNum(1); }} style={ss}><option value="">VPS: tất cả</option>{machineOpts.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
                  {unitOpts.length > 1 && <select value={fltUnit} onChange={(e) => { setFltUnit(e.target.value); setFltCreator(""); setPageNum(1); }} style={ss}><option value="">Đơn vị: tất cả</option>{unitOpts.map((u) => <option key={u} value={u}>{u}</option>)}</select>}
                  {creatorOpts.length > 1 && <select value={fltCreator} onChange={(e) => { setFltCreator(e.target.value); setPageNum(1); }} style={ss}><option value="">Người phụ trách: tất cả</option>{creatorOpts.map((u) => <option key={u} value={u}>{u}</option>)}</select>}
                  <select value={fltRecon} onChange={(e) => { setFltRecon(e.target.value); setPageNum(1); }} style={ss} title="Đối soát tín hiệu máy chủ ↔ YouTube">
                    <option value="">Đối soát: tất cả</option>
                    <option value="ok">Máy truyền + YouTube live</option>
                    <option value="mismatch">Máy truyền nhưng YouTube chưa live</option>
                    <option value="unverified">Chưa xác minh phía YouTube</option>
                    <option value="oauth">Mất kết nối OAuth</option>
                  </select>
                </>; })()}
                <span style={{ color: "var(--muted)" }}><b style={{ color: "var(--ink)" }}>{kept.length}</b> kết quả</span>
                {(flt !== "all" || q || fltMachine || fltUnit || fltCreator || fltRecon) && <button className="rowbtn" onClick={clearFilters} style={{ color: "#dc2626" }}>✕ Xoá lọc</button>}
              </div>
              {!grpByCh ? (
                <>
                  {mob ? (
                    <div className="rl-cards">
                      {page.map((s: any) => (
                        <StreamRow hoiNhap={setHoi} key={s.id} mobile s={s} idx={seqOf[s.id]} uc={uc} assetName={assetName} presetLabel={presetLabel} machineName={machineName} machineOnline={machineOnline} post={post} rawPost={rawPost} busy={busy} onRename={rename} onEdit={startEdit} yt={ytByCh?.[s.channelId]} flash={flash} afterControl={afterControl} thumbCacheSec={d?.thumbCacheSec} />
                      ))}
                    </div>
                  ) : den !== "table" ? (
                    /* R-LAYOUT Đợt 2 — THẺ LUỒNG: không cuộn ngang ở mọi bề rộng */
                    <div className="rl-rows">
                      {page.map((s: any) => (
                        <StreamRow hoiNhap={setHoi} key={s.id} card den={den} s={s} idx={seqOf[s.id]} uc={uc} assetName={assetName} presetLabel={presetLabel} machineName={machineName} machineOnline={machineOnline} post={post} rawPost={rawPost} busy={busy} onRename={rename} onEdit={startEdit} yt={ytByCh?.[s.channelId]} flash={flash} afterControl={afterControl} thumbCacheSec={d?.thumbCacheSec} />
                      ))}
                    </div>
                  ) : (
                    <div className="scroll">
                      <table>
                        <thead><tr><th>#</th><th>Luồng · Người tạo</th><th>Video · Máy</th><th>Kênh / Link live</th><th>Trạng thái · Live</th><th>Khoá luồng</th><th></th></tr></thead>
                        <tbody>
                          {page.map((s: any) => (
                            <StreamRow hoiNhap={setHoi} key={s.id} s={s} idx={seqOf[s.id]} uc={uc} assetName={assetName} presetLabel={presetLabel} machineName={machineName} machineOnline={machineOnline} post={post} rawPost={rawPost} busy={busy} onRename={rename} onEdit={startEdit} yt={ytByCh?.[s.channelId]} flash={flash} afterControl={afterControl} thumbCacheSec={d?.thumbCacheSec} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, fontSize: 12, color: "var(--muted)", flexWrap: "wrap", gap: 10 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Số hàng mỗi trang:
                      <select value={perPage} onChange={(e) => { setPerPage(Number(e.target.value)); setPageNum(1); }} style={{ padding: "3px 6px", borderRadius: 6, border: "1px solid var(--border,#e2e7ee)", fontSize: 12 }}>
                        {[10, 20, 30, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontWeight: 600 }}>{fromN}–{toN}/{kept.length}{(flt !== "all" || ql) ? " (đã lọc)" : ""}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <button className="rowbtn" disabled={cur <= 1} onClick={() => setPageNum(1)} style={{ opacity: cur <= 1 ? .4 : 1 }} title="Trang đầu">|‹</button>
                        <button className="rowbtn" disabled={cur <= 1} onClick={() => setPageNum(cur - 1)} style={{ opacity: cur <= 1 ? .4 : 1 }} title="Trước">‹</button>
                        <span style={{ fontWeight: 600, minWidth: 44, textAlign: "center" }}>{cur}/{totalPages}</span>
                        <button className="rowbtn" disabled={cur >= totalPages} onClick={() => setPageNum(cur + 1)} style={{ opacity: cur >= totalPages ? .4 : 1 }} title="Sau">›</button>
                        <button className="rowbtn" disabled={cur >= totalPages} onClick={() => setPageNum(totalPages)} style={{ opacity: cur >= totalPages ? .4 : 1 }} title="Trang cuối">›|</button>
                      </div>
                    </div>
                  </div>
                </>
              ) : (() => {
                // Gom nhóm theo KÊNH (khóa ổn định = channelId). Mỗi kênh gấp/mở; "Chưa gắn kênh" xuống cuối.
                const gm: Record<string, any> = {};
                for (const s of kept) { const k = s.channelId || "__none__"; (gm[k] ??= { id: k, name: s.channelName || (s.channelId ? "Kênh" : "Chưa gắn kênh"), items: [] }).items.push(s); }
                const gl = Object.values(gm).sort((a: any, b: any) => a.id === "__none__" ? 1 : b.id === "__none__" ? -1 : a.name.localeCompare(b.name, "vi"));
                const groupHead = (g: any, open: boolean) => {
                  const liveN = g.items.filter((s: any) => s.status === "live").length;
                  const errN = g.items.filter((s: any) => s.status === "error" || s.health === "error").length;
                  return (<>
                    <span style={{ color: "var(--rl,#0e8f84)" }}>{open ? "▾" : "▸"}</span> {g.id === "__none__" ? "—" : "📺"} {g.name}
                    <span style={{ fontWeight: 500, color: "var(--muted)", marginLeft: 8, fontSize: 12 }}>{g.items.length} luồng{liveN > 0 ? ` · ${liveN} đang phát` : ""}</span>
                    {errN > 0 ? <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 700, color: "#dc2626" }}>⚠ {errN} lỗi</span> : null}
                  </>);
                };
                return mob ? (
                  <div className="rl-cards">
                    {gl.map((g: any) => { const open = openG[g.id] ?? false; return (
                      <Fragment key={g.id}>
                        <div onClick={() => setOpenG((o) => ({ ...o, [g.id]: !open }))} style={{ cursor: "pointer", background: "var(--rl-soft,#eef7f6)", borderRadius: 8, padding: "8px 12px", fontWeight: 700 }}>{groupHead(g, open)}</div>
                        {open && g.items.map((s: any) => (
                          <StreamRow hoiNhap={setHoi} key={s.id} mobile s={s} idx={seqOf[s.id]} uc={uc} assetName={assetName} presetLabel={presetLabel} machineName={machineName} machineOnline={machineOnline} post={post} rawPost={rawPost} busy={busy} onRename={rename} onEdit={startEdit} yt={ytByCh?.[s.channelId]} flash={flash} afterControl={afterControl} thumbCacheSec={d?.thumbCacheSec} />
                        ))}
                      </Fragment>
                    ); })}
                  </div>
                ) : den !== "table" ? (
                  /* R-LAYOUT Đợt 2 — nhóm theo kênh, dạng thẻ */
                  <div className="rl-rows">
                    {gl.map((g: any) => { const open = openG[g.id] ?? false; return (
                      <Fragment key={g.id}>
                        <div className="rl-grouphead" onClick={() => setOpenG((o) => ({ ...o, [g.id]: !open }))}>{groupHead(g, open)}</div>
                        {open && g.items.map((s: any) => (
                          <StreamRow hoiNhap={setHoi} key={s.id} card den={den} s={s} idx={seqOf[s.id]} uc={uc} assetName={assetName} presetLabel={presetLabel} machineName={machineName} machineOnline={machineOnline} post={post} rawPost={rawPost} busy={busy} onRename={rename} onEdit={startEdit} yt={ytByCh?.[s.channelId]} flash={flash} afterControl={afterControl} thumbCacheSec={d?.thumbCacheSec} />
                        ))}
                      </Fragment>
                    ); })}
                  </div>
                ) : (
                  <div className="scroll">
                    <table>
                      <thead><tr><th>#</th><th>Luồng · Người tạo</th><th>Video · Máy</th><th>Kênh / Link live</th><th>Trạng thái · Live</th><th>Khoá luồng</th><th></th></tr></thead>
                      <tbody>
                        {gl.map((g: any) => { const open = openG[g.id] ?? false; return (
                          <Fragment key={g.id}>
                            <tr onClick={() => setOpenG((o) => ({ ...o, [g.id]: !open }))} style={{ cursor: "pointer", background: "var(--rl-soft,#eef7f6)" }}>
                              <td colSpan={7} style={{ fontWeight: 700 }}>{groupHead(g, open)}</td>
                            </tr>
                            {open && g.items.map((s: any) => (
                              <StreamRow hoiNhap={setHoi} key={s.id} s={s} idx={seqOf[s.id]} uc={uc} assetName={assetName} presetLabel={presetLabel} machineName={machineName} machineOnline={machineOnline} post={post} rawPost={rawPost} busy={busy} onRename={rename} onEdit={startEdit} yt={ytByCh?.[s.channelId]} flash={flash} afterControl={afterControl} thumbCacheSec={d?.thumbCacheSec} />
                            ))}
                          </Fragment>
                        ); })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </>
          );
        })()}
      </Card>
    </>
  );
}

// ── KHO VIDEO ────────────────────────────────────────────────────────────────
// Đo nhanh video NGAY TRÊN TRÌNH DUYỆT (không tải lên): độ phân giải + ước tính bitrate (dung lượng ÷ thời lượng).
function measureVideo(file: File): Promise<{ width: number; height: number; durationSec: number; mbps: number } | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => {
        const durationSec = v.duration || 0, width = v.videoWidth || 0, height = v.videoHeight || 0;
        URL.revokeObjectURL(url);
        const mbps = durationSec > 0 ? (file.size * 8) / durationSec / 1e6 : 0;
        resolve({ width, height, durationSec, mbps: Math.round(mbps * 10) / 10 });
      };
      v.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      v.src = url;
    } catch { resolve(null); }
  });
}

function WebUpload({ presets, uploadFile, assets = [], uploadTargets = [], defaultUrl = null }: any) {
  // Batch 4 — cảnh báo TRÙNG TÊN (chỉ cảnh báo, không tự kết luận trùng nội dung).
  const normName = (s: any) => String(s || "").replace(/\.[^.]+$/, "").trim().toLowerCase();
  const findDup = (fname: string) => assets.find((a: any) => normName(a.name) === normName(fname));
  // Đích tải: "Mặc định" (env) + các máy đã gắn địa chỉ nhận file HTTPS riêng → cho CHỌN VPS khi kéo-thả.
  const targetOpts: any[] = [...(defaultUrl ? [{ id: "__default", name: "Mặc định", httpsUrl: defaultUrl }] : []), ...uploadTargets];
  const [targetUrl, setTargetUrl] = useState<string>(defaultUrl || (uploadTargets[0]?.httpsUrl ?? ""));
  const [drag, setDrag] = useState(false);
  const [presetId, setPresetId] = useState<string>(presets.find((p: any) => p.id === "livepreset:original")?.id ?? presets[0]?.id ?? "");
  const [checking, setChecking] = useState(false);
  const [review, setReview] = useState<any[]>([]);   // file lệch nhãn — chờ bạn quyết
  const idc = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Gợi ý nhãn KHỚP file thật: nhãn nhỏ nhất mà độ phân giải + băng thông vẫn đủ chứa file (không tính thiếu).
  const suggestPreset = (real: { height: number; mbps: number }) => {
    const cands = presets.filter((p: any) => !p.keepOriginal && (p.height || 0) >= real.height * 0.9 && (p.bandwidthMbps || 0) >= real.mbps * 0.9)
      .sort((a: any, b: any) => (a.bandwidthMbps || 0) - (b.bandwidthMbps || 0));
    return cands[0]?.id ?? presets.find((p: any) => p.keepOriginal)?.id ?? "";
  };
  // MAY DAY -> chan NGAY tai day, khong de nguoi dung tai xong roi moi bao hong.
  // Cung luat voi may chu (intakeBlock trong app/api/live/route.ts): bang thong
  // cham 70% HOAC o cung con duoi muc toi thieu.
  const mayDich = (): any => targetOpts.find((t: any) => t.httpsUrl === targetUrl);
  const vuongMac = (): string | null => {
    const t: any = mayDich();
    if (!t || t.id === "__default") return null;         // khong biet may nao -> de may chu gac
    const up = Number(t.uploadMbps) || 0, tx = Number(t.txMbps);
    if (up > 0 && Number.isFinite(tx) && tx <= up * 1.05 && tx / up >= 0.70)
      return `Máy "${t.name}" đã chạm ngưỡng an toàn 70% băng thông (${Math.round(tx)}/${Math.round(up)} Mbps) — không nhận thêm video mới. Chọn máy khác còn trống nhé.`;
    const free = Number(t.diskFreeGb);
    if (Number.isFinite(free) && free < 20)
      return `Máy "${t.name}" chỉ còn ${Math.round(free)} GB trống — không nhận thêm video. Xoá bớt video không dùng hoặc chọn máy khác.`;
    return null;
  };

  const handle = async (files: FileList | null) => {
    if (!files) return;
    const chan = vuongMac();
    if (chan) { window.alert("⚠ " + chan); return; }
    const sel = presets.find((p: any) => p.id === presetId);
    const arr = Array.from(files);
    setChecking(true);
    try {
      for (const file of arr) {
        // Batch 4 — TRÙNG TÊN: cảnh báo + thông tin file cũ; người dùng vẫn có thể tải (bản khác/đã sửa).
        const dup = findDup(file.name);
        if (dup) {
          const when = dup.createdAt ? new Date(dup.createdAt).toLocaleString("vi-VN") : "";
          const info = [dup.createdByName || dup.createdBy, when].filter(Boolean).join(" · ");
          if (!window.confirm(`⚠ Đã có video tên "${dup.name}" trong kho${info ? `\n(${info})` : ""}.\n\nĐây CHỈ là trùng TÊN — có thể là bản khác/đã sửa/chất lượng khác. Vẫn muốn tải lên?`)) continue;
        }
        // "Giữ nguyên gốc" = nhận đúng file bạn tải (không hứa mức nào) → tải thẳng, khỏi kiểm.
        if (!sel || sel.keepOriginal) { uploadFile(file, presetId, targetUrl); continue; }
        const m = await measureVideo(file);
        if (!m || !m.height || !m.durationSec) { uploadFile(file, presetId, targetUrl); continue; }  // đọc không được → cứ tải (nhẹ, an toàn)
        const targetH = sel.height || 0;
        const resBad = targetH > 0 && Math.abs(m.height - targetH) / targetH > 0.15;       // lệch độ phân giải >15%
        const bitBad = (sel.bandwidthMbps || 0) > 0 && m.mbps > sel.bandwidthMbps * 1.5;   // file NẶNG hơn nhãn nhiều → tính sức chứa sai
        if (resBad || bitBad) setReview((r) => [...r, { id: String(++idc.current), file, real: m, chosen: presetId, suggested: suggestPreset(m) }]);
        else uploadFile(file, presetId, targetUrl);
      }
    } finally { setChecking(false); }
  };
  const drop = (id: string) => setReview((r) => r.filter((x) => x.id !== id));
  return (
    <Card title="📤 Tải video lên">
      <p className="plain" style={{ marginTop: 0 }}>Chuẩn bị sẵn video <b>đã xử lý</b> ở máy bạn rồi <b>kéo-thả thẳng vào đây</b>. Video giữ nguyên chất lượng bạn đã làm, hệ thống không xử lý lại. <b>Tải chạy nền — bạn có thể chuyển sang việc khác</b>, tiến độ hiện ở góc dưới màn hình.</p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <Field label="Chất lượng (chọn nhãn hiển thị)"><select value={presetId} onChange={(e) => setPresetId(e.target.value)}>{presets.map((p: any) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
        {targetOpts.length > 1 && (
          <Field label="Tải lên máy (VPS)"><select value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)}>{targetOpts.map((t: any) => <option key={t.id} value={t.httpsUrl}>{t.name}</option>)}</select></Field>
        )}
      </div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void handle(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        style={{ border: `2px dashed ${drag ? "var(--rl,#0e8f84)" : "var(--line,#c7d2e0)"}`, background: drag ? "var(--rl-soft,#eff4ff)" : "var(--surface2,#f8fafc)", borderRadius: 10, padding: "28px 16px", textAlign: "center", cursor: "pointer", color: "var(--muted)" }}
      >{checking ? "⏳ Đang kiểm video khớp nhãn…" : "📁 Kéo-thả video vào đây (hoặc bấm để chọn) — có thể nhiều file"}</div>
      <input ref={inputRef} type="file" accept="video/*" multiple style={{ display: "none" }} onChange={(e) => { void handle(e.target.files); e.target.value = ""; }} />
      {review.map((rv) => {
        const sug = presets.find((p: any) => p.id === rv.suggested); const cho = presets.find((p: any) => p.id === rv.chosen);
        return (
          <div key={rv.id} style={{ marginTop: 10, padding: 10, border: "1px solid var(--amber, #d97706)", borderRadius: 8, background: "rgba(217,119,6,.06)", fontSize: 13 }}>
            <b style={{ color: "#b45309" }}>⚠ "{rv.file.name}" không khớp nhãn đã chọn</b>
            <div style={{ marginTop: 4 }}>File thật: <b>{rv.real.width}×{rv.real.height}</b> · ~<b>{rv.real.mbps} Mbps</b>{rv.real.durationSec ? ` · ${Math.round(rv.real.durationSec / 60)}′` : ""}</div>
            <div style={{ color: "var(--muted)", marginTop: 2 }}>Nhãn đã chọn: <b>{cho?.label}</b> (~{cho?.bandwidthMbps} Mbps). Nếu tải nguyên mà giữ nhãn này, số <b>"sức chứa an toàn còn lại"</b> sẽ tính sai theo nhãn (thực tế nặng hơn).</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {sug && rv.suggested !== rv.chosen && <button className="primary small" onClick={() => { uploadFile(rv.file, rv.suggested, targetUrl); drop(rv.id); }}>Đổi nhãn sang "{sug.label}" & tải (khuyên dùng)</button>}
              <button className="rowbtn" onClick={() => { uploadFile(rv.file, rv.chosen, targetUrl); drop(rv.id); }}>Tải nguyên, giữ nhãn "{cho?.label}"</button>
              <button className="rowbtn" onClick={() => drop(rv.id)} style={{ color: "#dc2626" }}>Huỷ (tôi chuẩn hoá lại ở máy)</button>
            </div>
          </div>
        );
      })}
      <p className="plain" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--muted)" }}>💡 <b>Live 24/7 phát mượt:</b> video “giữ nguyên gốc” cần <b>keyframe mỗi 2 giây</b> để YouTube không cắt sóng. Khi xuất video (Adobe Premiere) bật <b>“Set Key Frame Distance”</b> = <b>60</b> (30fps) · 48 (24fps) · 50 (25fps) — công thức: <b>số hình/giây × 2</b>. <i>(Render “chuẩn để đăng video” KHÁC với live — Premiere mặc định không phải lúc nào cũng đặt 2 giây.)</i> Ngại để ý keyframe? Chọn <b>nhãn NÉN</b> (không phải “Giữ nguyên gốc”) — hệ thống tự đặt keyframe 2 giây. Khi chọn nhãn cụ thể, hệ thống còn <b>soi nhanh video khớp nhãn</b> trước khi tải.</p>
    </Card>
  );
}

function AssetsPanel({ d, assets, machines, presets, machineName, presetLabel, safety, post, rawPost, busy, flash, reload, uploadFile, uploadTok, ensureUploadTok, streams = [], canInfra = false }: any) {
  const [hoi, setHoi] = useState<YeuCauNhap | null>(null);   // hộp hỏi/nhập dùng chung
  // Batch 5 (A) — mức độ sử dụng của 1 video: đang phát / có lịch tương lai → KHÓA xóa (chống xóa nhầm gãy luồng).
  const assetUse = (aid: string) => {
    const using = streams.filter((s: any) => (Array.isArray(s.assetIds) && s.assetIds.includes(aid)) || s.assetId === aid);
    const live = using.filter((s: any) => s.status === "live" || s.desiredState === "live");
    const scheduled = using.filter((s: any) => s.control === "schedule" && (s.scheduleActive || s.nextStartISO));
    const activeCount = new Set([...live, ...scheduled].map((s: any) => s.id)).size;
    return { total: using.length, live: live.length, scheduled: scheduled.length, active: activeCount, names: using.slice(0, 8).map((s: any) => s.name) };
  };
  const [f, setF] = useState<any>({ name: "", sourceUrl: "", presetId: presets.find((p: any) => p.id === "livepreset:original")?.id ?? presets[0]?.id ?? "", machineId: "" });
  const [q, setQ] = useState(""); const [upF, setUpF] = useState(""); const [machineF, setMachineF] = useState("");   // tìm theo tên + lọc theo người tải + lọc theo MÁY
  // LỌC LOẠI VIDEO (Chủ Rise Group 29/08/2026): kho trộn lẫn video gốc với bản dự phòng do hệ tự
  // tạo — mở ra là nửa màn hình toàn bản dự phòng, không phải thứ người dùng đang tìm.
  // MẶC ĐỊNH chỉ hiện VIDEO GỐC: bản dự phòng là việc của hệ thống (còn bị khoá không xoá được),
  // người dùng gần như không bao giờ cần đụng tới. Muốn xem thì chọn trong ô lọc.
  const [loaiF, setLoaiF] = useState<"goc" | "duphong" | "">("goc");
  const laBanDuPhong = (a: any) => String(a?.source ?? "") === "auto-backup" || String(a?.createdBy ?? "").toLowerCase() === "system";
  // "system" khong noi len dieu gi voi nguoi dung — goi dung ten viec cua no.
  const nguoiTaiHien = (a: any) => laBanDuPhong(a) ? "Bản dự phòng" : (a?.createdBy ? String(a.createdBy).split("@")[0] : "—");
  const [page, setPage] = useState(1); const [perPage, setPerPage] = useState(30);   // phân trang Kho video
  // Danh sách người tải (để lọc — chỉ hiện khi có >1 người). Kho đã sắp mới nhất lên đầu (API).
  const uploaders = Array.from(new Set(assets.map((a: any) => String(a.createdBy || "")).filter(Boolean))).sort() as string[];
  const ql = q.trim().toLowerCase();
  const shown = assets.filter((a: any) => (!ql || String(a.name || "").toLowerCase().includes(ql)) && (!upF || String(a.createdBy || "") === upF) && (!machineF || String(a.machineId || "") === machineF)
    && (!loaiF || (loaiF === "duphong" ? laBanDuPhong(a) : !laBanDuPhong(a))));
  const curPage = Math.min(page, Math.max(1, Math.ceil(shown.length / perPage)));
  const pageShown = shown.length > perPage ? shown.slice((curPage - 1) * perPage, curPage * perPage) : shown;
  const add = async () => { if (await post({ action: "add_asset", ...f }, "Đã thêm — máy sẽ tự tải về (giữ nguyên gốc, không nén).")) setF({ name: "", sourceUrl: "", presetId: presets.find((p: any) => p.id === "livepreset:original")?.id ?? presets[0]?.id ?? "", machineId: "" }); };
  const selM = machines.find((m: any) => m.id === f.machineId); const selP = presets.find((p: any) => p.id === f.presetId);
  const left = selM && selP ? streamsLeft(selM, selP, safety) : null;
  return (
    <>
      <HopNhapChu yeuCau={hoi} dong={() => setHoi(null)} />
      <Card title="🎞 Thêm video">
        <div className="form">
          <Field label="Tên video"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="VD: Piano thư giãn 1 tiếng" /></Field>
          <Field label="Link Google Drive (chia sẻ 'ai có link', mp4)"><input value={f.sourceUrl} onChange={(e) => setF({ ...f, sourceUrl: e.target.value })} placeholder="https://drive.google.com/file/d/.../view" /></Field>
          <Field label="Chất lượng"><div style={{ padding: "7px 10px", border: "1px solid var(--line,#e5e7eb)", borderRadius: 8, background: "var(--soft-green,#f0fdf4)", color: "var(--green,#166534)", fontSize: 13, fontWeight: 600 }}>🎬 Giữ nguyên gốc — không nén lại (chuẩn hoá video sẵn ở máy tính trước khi tải lên)</div></Field>
          <Field label="Máy (tải & xử lý trên máy này)"><select value={f.machineId} onChange={(e) => setF({ ...f, machineId: e.target.value })}><option value="">— Chọn máy —</option>{machines.map((m: any) => { const full = bwFull(m); return <option key={m.id} value={m.id} disabled={full}>{m.name} {m.online ? "🟢" : "🔴"}{bwLabel(m)}</option>; })}</select></Field>
        </div>
        {/* NHẮC KHI MÁY ĐÃ CHẠM NGƯỠNG — Pub thì chỉ nhắc (không khoá), luồng thường đã bị khoá ở trên. */}
        {selM && bwFull(selM) && (
          <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.6, padding: "8px 10px", borderRadius: 8,
            background: "var(--soft-amber,#fffbeb)", border: "1px solid var(--amber,#f59e0b)", color: "var(--ink)" }}>
            {f.mode === "live-pub"
              ? <>⚠ Máy "{selM.name}" đã chạm ngưỡng an toàn 70%. Luồng Pub vẫn tạo được, nhưng nên <b>cân nhắc sao chép video sang máy khác còn trống</b> rồi tạo luồng ở đó — vào <b>Kho video → “📋 Sao chép sang máy…”</b>.</>
              : <>⛔ Máy "{selM.name}" đã chạm ngưỡng an toàn 70% nên không nhận thêm luồng live. Chọn máy khác trong danh sách, hoặc sao chép video sang máy còn trống (<b>Kho video → “📋 Sao chép sang máy…”</b>).</>}
          </div>
        )}
        {selM && selP && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: left == null ? "#d97706" : (left > 5 ? "#16a34a" : "#d97706") }}>
            {left == null
              ? <>⚠ Máy "{selM.name}" chưa có băng thông — vào "Máy live" nhập tốc độ đẩy để tính sức chứa an toàn.</>
              : <>📶 Ở mức <b>{selP.label}</b> ({selP.keepOriginal ? "không nén — băng thông tùy video gốc, tạm tính" : "~"}{selP.keepOriginal ? "" : `${selP.bandwidthMbps} Mbps`}/luồng), máy "{selM.name}" còn chạy thêm được <b>khoảng {left} luồng</b> an toàn.{selP.keepOriginal ? " Giữ nguyên gốc = tải xong là gần như sẵn sàng ngay (không nén lại hình)." : ""}</>}
          </div>
        )}
        <button className="primary small" disabled={busy} onClick={add} style={{ marginTop: 10 }}>Thêm video</button>
      </Card>

      {d?.uploadConfig?.httpsUrl ? (
        <WebUpload presets={presets} uploadFile={uploadFile} assets={assets} uploadTargets={d?.uploadTargets ?? []} defaultUrl={d?.uploadConfig?.httpsUrl ?? null} />
      ) : (
      <Card title="📤 Tải thẳng từ máy (đã nén sẵn — không tốn CPU máy chủ)">
        <p className="plain" style={{ marginTop: 0 }}>Chuẩn bị video <b>ngay tại máy của bạn</b> (kéo-thả) rồi tải thẳng lên máy chủ live → Live Rise nhận là <b>"Sẵn sàng"</b> luôn, máy chủ <b>không xử lý lại</b> (để dành sức phát cho mượt). Hợp khi nhiều người cùng làm.</p>
        {!d?.uploadEnabled ? (
          <p className="plain" style={{ margin: 0, color: "#d97706" }}>⚠ Chưa bật. Admin đặt biến <code>RISE_LIVE_UPLOAD_TOKEN</code> (Cloud Run + trên VPS) và cập nhật worker (bản mới), mở cổng tải lên trên VPS.</p>
        ) : d?.uploadConfig ? (
          <div>
            <p className="plain" style={{ margin: "0 0 6px" }}><b>Bước 1:</b> tải công cụ (1 file): <a href="/RiseLiveTool.bat" download><b>RiseLiveTool.bat</b></a> — double-click là chạy (không cần cài gì). Cấu hình + ffmpeg chỉ nhập/tải 1 lần (nhớ sẵn cho lần sau). <small style={{ color: "var(--muted)" }}>(Nếu diệt virus chặn: chuột phải file → Properties → Unblock, hoặc thêm ngoại lệ. Bản 2 file: <a href="/RiseLiveUploader.bat" download>.bat</a> + <a href="/RiseLiveUploader.ps1" download>.ps1</a>)</small></p>
            <p className="plain" style={{ margin: "0 0 6px" }}><b>Bước 2:</b> double-click file → lần đầu nhập cấu hình dưới → chọn chất lượng + kéo video vào là xong.</p>
            {!uploadTok ? (
              <button className="rowbtn" disabled={busy} onClick={() => ensureUploadTok(true)} style={{ margin: "2px 0 6px" }}>🔑 Xem token tải lên</button>
            ) : null}
            <pre style={{ background: "#0e1420", color: "#d5deea", padding: 12, borderRadius: 8, overflowX: "auto", fontSize: 12 }}>{`IP VPS: (chọn theo máy, VD ${machines[0]?.ip ?? "203.0.113.10"})
Cổng tải lên: ${d.uploadConfig.port}
Token tải lên: ${uploadTok ? uploadTok.token : "(bấm 'Xem token tải lên' ở trên)"}
Email: (email của người dùng)`}</pre>
            <p className="plain" style={{ margin: 0, fontSize: 12 }}>⚠ Nhớ <b>mở cổng {d.uploadConfig.port}</b> trên tường lửa VPS (trang quản trị của nhà cung cấp → Firewall) để máy nhân viên tải lên được.</p>
          </div>
        ) : (
          <p className="plain" style={{ margin: 0 }}>Dùng <b>công cụ Admin đã cấp</b> cho bạn (kéo-thả video). Video nén ở máy bạn rồi tự lên đây thành "Sẵn sàng".</p>
        )}
      </Card>
      )}

      <Card title="🎞 Kho video">
        {assets.length === 0 ? <p className="empty" style={{ margin: 0 }}>Chưa có video nào.</p> : (
          <>
          {(assets.length > 6 || uploaders.length > 1 || machines.length > 1) && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
              <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="🔍 Tìm video theo tên…" style={{ flex: "1 1 200px", minWidth: 0, padding: "8px 11px", borderRadius: 8, border: "1px solid var(--line,#e5e7eb)", fontSize: 13 }} />
              {machines.length > 1 && (
                <select value={machineF} onChange={(e) => { setMachineF(e.target.value); setPage(1); }} title="Lọc video theo máy (video lưu cục bộ từng máy)" style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line,#e5e7eb)", fontSize: 13 }}>
                  <option value="">🖥 Mọi máy</option>
                  {machines.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              )}
              {uploaders.length > 1 && (
                <select value={upF} onChange={(e) => { setUpF(e.target.value); setPage(1); }} style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line,#e5e7eb)", fontSize: 13 }}>
                  <option value="">Mọi người tải</option>
                  {uploaders.map((u) => <option key={u} value={u}>{u.split("@")[0]}</option>)}
                </select>
              )}
              <select value={loaiF} onChange={(e) => { setLoaiF(e.target.value as any); setPage(1); }} title="Bản dự phòng là video hệ thống tự nhân ra để cứu luồng khi máy hỏng — thường không cần đụng tới" style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line,#e5e7eb)", fontSize: 13 }}>
                <option value="goc">🎬 Video gốc</option>
                <option value="duphong">🛡 Bản dự phòng</option>
                <option value="">Tất cả</option>
              </select>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>{shown.length}/{assets.length}</span>
            </div>
          )}
          {/* Dọn bản dự phòng hệ tự nhân ra mà luồng đã dừng/xoá — tránh âm thầm đầy ổ */}
          <OrphanBackups post={post} rawPost={rawPost} flash={flash} />
          {(() => {
            // VIDEO MỒ CÔI: bản ghi trỏ tới máy KHÔNG CÒN TỒN TẠI (do những lần xoá máy trước bản
            // 30/08/2026 — lúc đó xoá máy không dọn video). Cột Máy hiện "—", không dùng được vào
            // việc gì, và làm hệ tính nhầm tình trạng dự phòng. Chỉ Admin hạ tầng mới thấy nút dọn.
            const moCoi = assets.filter((a: any) => a.machineId && !machines.some((m: any) => m.id === a.machineId));
            if (!canInfra || moCoi.length === 0) return null;
            return (
              <div style={{ marginBottom: 10, padding: "8px 10px", background: "var(--card2)", border: "1px solid var(--amber,#d97706)", borderRadius: 9, fontSize: 12.5, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ flex: "1 1 240px" }}><b>{moCoi.length} video mồ côi</b> — thuộc về máy đã xoá khỏi hệ nên không dùng được nữa (cột Máy hiện “—”). File thật đã mất theo máy.</span>
                <button className="rowbtn" disabled={busy} onClick={() => { if (confirm(`Dọn ${moCoi.length} bản ghi video mồ côi?

Đây là video của máy đã bị xoá — file thật không còn. Bản ghi nào còn được một luồng dùng thì hệ GIỮ LẠI, không xoá.`)) void post({ action: "clean_orphan_assets" }, "Đã dọn video mồ côi."); }} style={{ flex: "none", fontWeight: 700 }}>🧹 Dọn ngay</button>
              </div>);
          })()}
          {shown.length === 0 ? <p className="empty" style={{ margin: 0 }}>Không có video khớp tìm kiếm.</p> : (
          <div className="scroll">
            <table className="rl-assets">
              <thead><tr><th>Tên</th><th>Người tải</th><th>Thời gian</th><th>Độ phân giải</th><th>Chất lượng</th><th>Máy</th><th>Trạng thái</th><th>Dung lượng</th><th></th></tr></thead>
              <tbody>
                {pageShown.map((a: any) => {
                  const keepOrig = !!presets.find((p: any) => p.id === a.presetId)?.keepOriginal;
                  let s = ASSET_STATUS[a.status] ?? ASSET_STATUS.pending;
                  // "Giữ nguyên gốc" chỉ COPY hình (không nén) → không dùng chữ "nén" gây hiểu nhầm.
                  if (keepOrig && a.status === "queued") s = { t: "Đang chờ xử lý", tone: "gray" };
                  if (keepOrig && a.status === "normalizing") s = { t: "Đang chuẩn (giữ gốc, không nén)", tone: "amber" };
                  const res = resLabel(a.width, a.height);
                  const use = assetUse(a.id);
                  return (
                    <tr key={a.id}>
                      <td><b title={a.name} style={{ display: "inline-block", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }}>{a.name}</b><button onClick={() => setHoi({ tieuDe: "Đổi tên video", nhan: "Tên video", batBuoc: true, giaTriDau: a.name, moTa: "Chỉ đổi tên hiển thị trong kho video — KHÔNG ảnh hưởng luồng đang dùng video này.", nutXacNhan: "Đổi tên", xong: (n: string) => { if (n && n !== a.name) void post({ action: "rename_asset", id: a.id, name: n }, "Đã đổi tên."); } })} title="Đổi tên video" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--muted)", marginLeft: 3, fontSize: 12 }}>✎</button>{a.source === "upload" ? <small style={{ color: "var(--green,#16a34a)" }}> · 📤 tải lên</small> : null}{a.error && a.status !== "ready" ? <small style={{ color: "var(--red,#dc2626)", display: "block" }}>⚠ {friendlyAssetError(a.error)}<span style={{ display: "block", color: "var(--muted)", fontSize: 10.5, fontWeight: 400, marginTop: 2, whiteSpace: "normal", wordBreak: "break-word" }}>Chi tiết lỗi: {String(a.error).slice(0, 240)}</span></small> : null}<small className="rl-sub">{nguoiTaiHien(a)}{res?.t && res.t !== "—" ? " · " + res.t : ""}{a.machineId ? " · " + machineName(a.machineId) : ""}</small></td>
                      <td title={a.createdBy || ""}>{nguoiTaiHien(a)}</td>
                      <td style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>{a.createdAt ? fmtWhen(a.createdAt) : "—"}</td>
                      <td><b style={{ color: res.t === "—" ? "var(--muted)" : (res.low ? "var(--amber,#d97706)" : "var(--green,#16a34a)") }}>{res.t}</b>{res.low ? <small style={{ color: "var(--amber,#d97706)", display: "block" }}>dưới 1080p</small> : null}</td>
                      <td style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>{keepOrig ? <span style={{ color: "var(--green,#16a34a)", fontWeight: 600 }}>Giữ nguyên gốc</span> : <span style={{ color: "var(--muted)" }}>{a.presetId ? presetLabel(a.presetId) : "—"}</span>}</td>
                      <td>{machineName(a.machineId)}</td>
                      <td><Pill tone={s.tone}>{s.t}</Pill>{(() => { const td = tienDoTai(a); if (!td) return null; const pct = a.status === "downloading" && a.progressPct != null ? Math.max(0, Math.min(100, Number(a.progressPct))) : null; return (
                        <div style={{ marginTop: 3 }}>
                          {pct != null ? <div aria-hidden style={{ height: 4, borderRadius: 3, background: "var(--line,#e5e7eb)", overflow: "hidden", marginBottom: 2 }}><div style={{ width: `${pct}%`, height: "100%", background: "var(--amber,#d97706)" }} /></div> : null}
                          <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{td}</div>
                        </div>); })()}{use.total > 0 ? <div title={use.names.join(", ")} style={{ marginTop: 3, fontSize: 10.5, fontWeight: 700, color: use.active > 0 ? "var(--amber,#b45309)" : "var(--muted)" }}>{use.active > 0 ? "🔒 " : ""}đang dùng bởi {use.total} luồng{use.scheduled > 0 ? ` · ${use.scheduled} lịch` : ""}</div> : <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--muted)" }}>chưa dùng</div>}</td>
                      <td>{a.sizeMb ? `${money(a.sizeMb)} MB` : "—"}{a.durationSec ? ` · ${Math.round(a.durationSec / 60)}′` : ""}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {a.status === "ready" && (machines.find((m: any) => m.id === a.machineId)?.ip || (a.sourceUrl && /^https?:/i.test(String(a.sourceUrl)))) && machines.filter((m: any) => m.id !== a.machineId).length > 0 && (
                          <select disabled={busy} value="" title="Sao chép video này sang VPS khác — máy đích KÉO THẲNG file từ máy nguồn (giữ nguyên chất lượng gốc, KHÔNG qua Drive)"
                            onChange={(e) => { const mid = e.target.value; e.currentTarget.value = ""; if (!mid) return;
                              if (confirm(`Sao chép "${a.name}" sang máy "${machineName(mid)}"?\n\nMáy đích sẽ KÉO THẲNG file từ máy nguồn (giữ nguyên chất lượng gốc). Vài phút sẽ "Sẵn sàng".`))
                                void post({ action: "copy_asset", assetId: a.id, targetMachineId: mid }, "Đang sao chép sang máy khác — vài phút sẽ Sẵn sàng."); }}
                            style={{ marginRight: 6, fontSize: 12, padding: "3px 7px", borderRadius: 7, border: "1px solid var(--rl,#0e8f84)", color: "var(--rl,#0e8f84)", fontWeight: 600 }}>
                            <option value="">📋 Sao chép sang máy…</option>
                            {machines.filter((m: any) => m.id !== a.machineId).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
                          </select>
                        )}
                        {use.total > 0
                          ? <button className="rowbtn" disabled title={`Không thể xoá — đang được ${use.total} luồng sử dụng${use.scheduled > 0 ? ` (${use.scheduled} lịch sắp tới)` : ""}. Gỡ/xoá các luồng đó trước.`} style={{ color: "var(--muted)", cursor: "not-allowed", opacity: .6 }}>🔒 Không xoá được ({use.total})</button>
                          : a.locked
                            ? <span title={a.lockReason || "Đang phục vụ luồng ưu tiên"} style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap" }}>🔒 khoá (dự phòng)</span>
                            : <button className="rowbtn" disabled={busy} onClick={() => { if (confirm(`Xoá video "${a.name}"?\n\nFile trên máy "${machineName(a.machineId)}" cũng bị xoá để dọn ổ. Bản ở máy khác KHÔNG bị ảnh hưởng.${String(a.sourceUrl ?? "").trim() ? "" : "\n\n⚠ Video này TẢI TAY (không có link Drive) — xoá rồi không tải lại được."}`)) void post({ action: "delete_asset", id: a.id }, "Đã xoá — máy sẽ dọn file."); }} style={{ color: "#dc2626" }}>Xoá</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
          {shown.length > perPage && <Pager total={shown.length} page={curPage} perPage={perPage} onPage={setPage} onPerPage={(n) => { setPerPage(n); setPage(1); }} />}
          </>
        )}
      </Card>
    </>
  );
}

// Ô sửa băng thông nhanh trong bảng máy (bấm để nhập Mbps đo tay).
function MachineBw({ m, post, busy }: any) {
  const [edit, setEdit] = useState(false); const [v, setV] = useState(String(m.uploadMbps || ""));
  if (!edit) return <span onClick={() => { setV(String(m.uploadMbps || "")); setEdit(true); }} style={{ cursor: "pointer", borderBottom: "1px dashed var(--muted,#98a2b3)" }} title="Bấm để sửa băng thông">{m.uploadMbps ? `${money(m.uploadMbps)} Mbps` : "nhập…"}</span>;
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <input value={v} onChange={(e) => setV(e.target.value)} inputMode="numeric" style={{ width: 64, padding: "2px 5px", border: "1px solid var(--border,#d0d7e2)", borderRadius: 6 }} />
      <button className="rowbtn" disabled={busy} onClick={async () => { if (await post({ action: "update_machine", id: m.id, uploadMbps: Number(v) || 0 }, "Đã cập nhật băng thông.")) setEdit(false); }}>OK</button>
      <button className="rowbtn" onClick={() => setEdit(false)}>×</button>
    </span>
  );
}

// Sửa tên máy nhanh (bấm tên để đổi).
// GIÁ THUÊ + HẠN GIA HẠN (sửa nhanh ngay trên dòng máy) — 30/08/2026, Chủ Rise Group yêu cầu.
// Bỏ trống được: máy chưa nhập thì không tính vào tổng chi phí và không nhắc gia hạn (không ép ai
// phải điền). Hạn gia hạn là thứ quan trọng nhất ở đây — quên gia hạn là mất sóng CẢ MÁY.
function MachineCost({ m, post, busy }: any) {
  const [edit, setEdit] = useState(false);
  const [gia, setGia] = useState(String(m.costAmount ?? ""));
  const [ky, setKy] = useState(String(m.costPeriod || "month"));
  const [han, setHan] = useState(String(m.costRenewAt || ""));
  const conNgay = /^\d{4}-\d{2}-\d{2}$/.test(String(m.costRenewAt ?? ""))
    ? Math.round((Date.parse(m.costRenewAt + "T00:00:00Z") - Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z")) / 86400000)
    : null;
  if (!edit) {
    const co = Number(m.costAmount) > 0;
    const mau = conNgay == null ? "var(--muted)" : conNgay <= 7 ? "var(--amber)" : "var(--muted)";
    return (
      <span onClick={() => { setGia(String(m.costAmount ?? "")); setKy(String(m.costPeriod || "month")); setHan(String(m.costRenewAt || "")); setEdit(true); }}
        style={{ cursor: "pointer", borderBottom: "1px dashed var(--muted,#98a2b3)", fontSize: 11.5, color: mau, whiteSpace: "nowrap" }}
        title="Bấm để nhập giá thuê và ngày hết hạn">
        {co ? `$${m.costAmount}/${m.costPeriod === "year" ? "năm" : "tháng"}` : "chưa nhập giá"}
        {conNgay != null ? ` · ${conNgay <= 0 ? "ĐÃ HẾT HẠN" : `còn ${conNgay} ngày`}` : ""}
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      <input value={gia} onChange={(e) => setGia(e.target.value)} placeholder="$" inputMode="decimal" style={{ width: 62, padding: "2px 5px", border: "1px solid var(--border,#d0d7e2)", borderRadius: 6 }} />
      <select value={ky} onChange={(e) => setKy(e.target.value)} style={{ padding: "2px 4px", border: "1px solid var(--border,#d0d7e2)", borderRadius: 6 }}>
        <option value="month">/tháng</option><option value="year">/năm</option>
      </select>
      <input type="date" value={han} onChange={(e) => setHan(e.target.value)} style={{ padding: "2px 5px", border: "1px solid var(--border,#d0d7e2)", borderRadius: 6 }} />
      <button className="rowbtn" disabled={busy} onClick={async () => {
        if (await post({ action: "update_machine", id: m.id, costAmount: gia.trim() === "" ? null : Number(gia), costPeriod: ky, costRenewAt: han.trim() }, "Đã lưu giá thuê.")) setEdit(false);
      }}>OK</button>
      <button className="rowbtn" onClick={() => setEdit(false)}>×</button>
    </span>
  );
}

// Nhà cung cấp + Khu vực (sửa nhanh) — dùng cho dự phòng: chọn máy cứu KHÁC điểm chết.
function MachinePlace({ m, post, busy }: any) {
  const [edit, setEdit] = useState(false);
  const [prov, setProv] = useState(m.provider || ""); const [reg, setReg] = useState(m.region || "");
  if (!edit) {
    const txt = [m.provider, m.region].filter(Boolean).join(" · ");
    return <span onClick={() => { setProv(m.provider || ""); setReg(m.region || ""); setEdit(true); }} style={{ cursor: "pointer", borderBottom: "1px dashed var(--muted,#98a2b3)" }} title="Bấm để sửa nhà cung cấp / khu vực">{txt || "nhập…"}</span>;
  }
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      <input value={prov} onChange={(e) => setProv(e.target.value)} placeholder="NCC" style={{ width: 90, padding: "2px 5px", border: "1px solid var(--border,#d0d7e2)", borderRadius: 6 }} />
      <input value={reg} onChange={(e) => setReg(e.target.value)} placeholder="Khu vực" style={{ width: 90, padding: "2px 5px", border: "1px solid var(--border,#d0d7e2)", borderRadius: 6 }} />
      <button className="rowbtn" disabled={busy} onClick={async () => { if (await post({ action: "update_machine", id: m.id, provider: prov.trim(), region: reg.trim() }, "Đã cập nhật nhà cung cấp / khu vực.")) setEdit(false); }}>OK</button>
      <button className="rowbtn" onClick={() => setEdit(false)}>×</button>
    </span>
  );
}

// Địa chỉ nhận file HTTPS riêng của máy — để tải-thẳng-từ-máy-tính chọn được VPS này (bỏ trống = chỉ tải-từ-link).
function MachineUpload({ m, post, busy }: any) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(m.uploadHttpsUrl || "");
  if (!edit) return <span onClick={() => { setV(m.uploadHttpsUrl || ""); setEdit(true); }} style={{ cursor: "pointer", fontSize: 11.5, color: m.uploadHttpsUrl ? "#0e8f84" : "var(--muted,#98a2b3)", borderBottom: "1px dashed var(--muted,#98a2b3)" }} title="Địa chỉ nhận file HTTPS để tải-thẳng lên máy này (bấm để sửa)">{m.uploadHttpsUrl ? "📤 tải-thẳng: bật" : "📤 tải-thẳng: chưa gắn"}</span>;
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="https://live2.<TEN-MIEN-CUA-BAN>" style={{ width: 180, padding: "2px 5px", border: "1px solid var(--border,#d0d7e2)", borderRadius: 6 }} />
      <button className="rowbtn" disabled={busy} onClick={async () => { if (await post({ action: "update_machine", id: m.id, uploadHttpsUrl: v.trim() }, "Đã cập nhật địa chỉ nhận file.")) setEdit(false); }}>OK</button>
      <button className="rowbtn" onClick={() => setEdit(false)}>×</button>
    </span>
  );
}

// Tab TRA CỨU: bảng mã lỗi Rise Live — mã · triệu chứng · hệ tự làm gì · người làm gì. Lọc theo "ai xử".
function CodesPanel() {
  const [flt, setFlt] = useState<"all" | HandledBy>("all");
  const [q, setQ] = useState("");
  const SEV_TONE: Record<string, { bg: string; fg: string }> = {
    EMERGENCY: { bg: "var(--soft-red,#fee2e2)", fg: "var(--red,#991b1b)" }, CRITICAL: { bg: "var(--soft-red,#fef2f2)", fg: "var(--red,#b91c1c)" },
    WARNING: { bg: "var(--soft-amber,#fffbeb)", fg: "var(--amber,#b45309)" }, INFO: { bg: "var(--soft-blue,#eff6ff)", fg: "var(--blue,#1d4ed8)" },
  };
  const HB_TONE: Record<HandledBy, string> = { auto: "#0e8f84", human: "#b45309", both: "#6d28d9" };
  const ql = q.trim().toLowerCase();
  const rows = INCIDENT_CATALOG.filter((r) => (flt === "all" || r.handledBy === flt) &&
    (!ql || [r.code, r.title, r.symptom, r.group].some((s) => s.toLowerCase().includes(ql))));
  const groups = Array.from(new Set(rows.map((r) => r.group)));
  return (
    <Card title="📖 Mã lỗi & quy trình xử lý Rise Live" action={`${INCIDENT_CATALOG.length} mã`}>
      <p className="plain" style={{ marginTop: 0, fontSize: 13 }}>Mỗi cảnh báo trong hệ thống có <b>mã RL-XXX</b>. Tra ở đây để biết <b>triệu chứng</b>, <b>hệ thống tự xử gì</b> và <b>bạn cần làm gì</b>. <span style={{ color: HB_TONE.auto, fontWeight: 700 }}>🤖 Hệ tự xử</span> · <span style={{ color: HB_TONE.human, fontWeight: 700 }}>🧑 Người xử</span> · <span style={{ color: HB_TONE.both, fontWeight: 700 }}>🤝 Hệ + Người</span>.</p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm mã / triệu chứng…" style={{ flex: "1 1 200px", padding: "6px 10px", border: "1px solid var(--border,#d0d7e2)", borderRadius: 8 }} />
        {([["all", "Tất cả"], ["auto", "🤖 Hệ tự xử"], ["human", "🧑 Người xử"], ["both", "🤝 Cả hai"]] as const).map(([k, lb]) => (
          <button key={k} className="rowbtn" onClick={() => setFlt(k)} style={flt === k ? { background: "var(--rl,#0e8f84)", color: "#fff", fontWeight: 700 } : undefined}>{lb}</button>
        ))}
      </div>
      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 13, color: "var(--muted)", margin: "6px 0", textTransform: "uppercase", letterSpacing: 0.4 }}>{g}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.filter((r) => r.group === g).map((r) => {
              const st = SEV_TONE[r.severity];
              return (
                <div key={r.code} style={{ border: "1px solid var(--border,#e7ecf2)", borderRadius: 10, padding: "10px 12px", background: "var(--surface,#fff)" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                    <code style={{ fontWeight: 800, fontSize: 12.5 }}>{r.code}</code>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 999, background: st.bg, color: st.fg }}>{r.severity}</span>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: HB_TONE[r.handledBy] }}>{HANDLED_BY_LABEL[r.handledBy]}</span>
                    <b style={{ fontSize: 13.5 }}>{r.title}</b>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--ink,#1a2230)", marginBottom: 4 }}><b>Triệu chứng:</b> {r.symptom}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12.5 }}>
                    <div style={{ background: "rgba(14,143,132,.06)", borderRadius: 8, padding: "6px 9px" }}><b style={{ color: HB_TONE.auto }}>🤖 Hệ tự làm:</b> {r.autoAction}</div>
                    <div style={{ background: "rgba(180,83,9,.06)", borderRadius: 8, padding: "6px 9px" }}><b style={{ color: HB_TONE.human }}>🧑 Bạn cần làm:</b> {r.humanAction}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {rows.length === 0 && <p className="empty">Không có mã nào khớp bộ lọc.</p>}
    </Card>
  );
}

function MachineName({ m, post, busy }: any) {
  const [edit, setEdit] = useState(false); const [v, setV] = useState(m.name || "");
  if (!edit) return <b onClick={() => { setV(m.name || ""); setEdit(true); }} style={{ cursor: "pointer" }} title="Bấm để đổi tên">{m.name} <span style={{ fontSize: 10, color: "var(--muted)" }}>✎</span></b>;
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <input value={v} onChange={(e) => setV(e.target.value)} style={{ width: 130, padding: "2px 5px", border: "1px solid var(--border,#d0d7e2)", borderRadius: 6 }} />
      <button className="rowbtn" disabled={busy} onClick={async () => { if (v.trim() && await post({ action: "update_machine", id: m.id, name: v.trim() }, "Đã đổi tên máy.")) setEdit(false); }}>OK</button>
      <button className="rowbtn" onClick={() => setEdit(false)}>×</button>
    </span>
  );
}

// ── MÁY LIVE ─────────────────────────────────────────────────────────────────
// ĐỢT 1 (dự phòng nhiều VPS) — bảng CHỈ ĐỌC: sức chứa từng máy + đánh giá N+1 của cả cụm.
function ClusterCapacityCard({ cluster }: any) {
  if (!cluster) return null;
  const mm = (n: any) => `${money(n)} Mbps`;
  const barColor = (pct: number) => pct >= 0.85 ? "#dc2626" : pct >= 0.70 ? "#d97706" : "#16a34a";
  // Trạng thái N+1 tổng: đủ mọi luồng > chỉ đủ luồng ưu tiên > chưa đạt > chưa đủ máy.
  const few = (cluster.onlineCount ?? 0) < 2;
  const nplus = few ? { tone: "gray", txt: "Cần ≥2 máy online để có dự phòng" }
    : cluster.nPlusOneFull ? { tone: "green", txt: "✅ Đạt N+1 — mất 1 máy vẫn gánh hết" }
    : cluster.nPlusOnePriority ? { tone: "amber", txt: "⚠ Chỉ đủ cứu luồng ƯU TIÊN khi mất 1 máy" }
    : { tone: "red", txt: "⛔ Chưa đạt N+1 — mất 1 máy sẽ có luồng phải chờ" };
  const clusterPct = cluster.clusterLoadPct ?? 0;
  return (
    <Card title="📊 Sức chứa cụm & Dự phòng (N+1)">
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center", marginBottom: 10 }}>
        <Pill tone={nplus.tone as any}>{nplus.txt}</Pill>
        <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
          Cụm đang dùng <b style={{ color: "var(--ink,#111)" }}>{mm(cluster.totalUsedMbps)}</b> / {mm(cluster.totalMaxMbps)} ({Math.round(clusterPct * 100)}%) · {cluster.onlineCount}/{cluster.machinesTotal} máy online
        </span>
      </div>
      <p className="plain" style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 0 }}>
        Ngưỡng bình thường ~70%, ngưỡng khẩn cấp 85%. Bảng CHỈ ĐỌC, ước tính theo băng thông (ưu tiên số đo thực). Chưa có thao tác chuyển máy — đó là các đợt sau.
      </p>
      <div className="scroll">
        <table>
          <thead><tr><th>Máy</th><th>Tình trạng</th><th>Đang dùng</th><th>Còn nhận (khẩn cấp)</th><th>Luồng</th></tr></thead>
          <tbody>
            {(cluster.machines ?? []).map((c: any) => (
              <tr key={c.machineId}>
                <td><b>{c.name}</b></td>
                <td><Pill tone={c.maintenance ? "amber" : c.online ? "green" : "gray"}>{c.maintenance ? "🛠 Bảo trì" : c.online ? "🟢 Online" : "Offline"}</Pill></td>
                <td style={{ minWidth: 150 }}>
                  <div style={{ fontSize: 12 }}>{mm(c.usedMbps)} / {mm(c.maxMbps)} <span style={{ color: "var(--muted)" }}>({Math.round((c.loadPct ?? 0) * 100)}%{c.usedIsReal ? " thực" : " ước tính"})</span></div>
                  <div style={{ height: 6, borderRadius: 4, background: "var(--line,#eee)", overflow: "hidden", marginTop: 3 }}>
                    <div style={{ width: `${Math.min(100, (c.loadPct ?? 0) * 100)}%`, height: "100%", background: barColor(c.loadPct ?? 0) }} />
                  </div>
                </td>
                <td style={{ fontSize: 12 }}>{mm(c.emergencyHeadroomMbps)}</td>
                <td style={{ fontSize: 12 }}>{c.streamCount}{c.priorityStreamCount ? ` (${c.priorityStreamCount} ưu tiên)` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!few && (cluster.losses ?? []).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 5 }}>Mô phỏng: nếu mất 1 máy</div>
          <div className="scroll">
            <table>
              <thead><tr><th>Mất máy</th><th>Cần chuyển đi</th><th>Máy còn lại gánh nổi?</th><th>Máy đề xuất nhận</th></tr></thead>
              <tbody>
                {(cluster.losses ?? []).map((l: any) => (
                  <tr key={l.lostMachineId}>
                    <td><b>{l.lostMachineName}</b></td>
                    <td style={{ fontSize: 12 }}>{mm(l.movedMbps)}{l.priorityMbps ? ` (ưu tiên ${mm(l.priorityMbps)})` : ""}</td>
                    <td style={{ fontSize: 12 }}>
                      {l.fullAbsorbable
                        ? <Pill tone="green">Gánh hết</Pill>
                        : l.priorityAbsorbable
                          ? <Pill tone="amber">Chỉ cứu ưu tiên (thiếu {mm(l.fullShortfallMbps)} cho luồng thường)</Pill>
                          : <Pill tone="red">Không đủ (thiếu {mm(l.priorityShortfallMbps)} cả luồng ưu tiên)</Pill>}
                    </td>
                    <td style={{ fontSize: 12 }}>{l.suggestedTargetName ? <><b>{l.suggestedTargetName}</b><div style={{ fontSize: 11, color: "var(--muted)" }}>{l.suggestedTargetReason}</div></> : <span style={{ color: "var(--muted)" }}>{l.suggestedTargetReason || "—"}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

// Dự phòng nhiều VPS (Đợt 3): lịch sử các lần chuyển máy (audit — CHỈ ĐỌC).
function MoveHistoryCard({ history, machines }: any) {
  if (!history || !history.length) return null;
  const mN: any = {}; (machines || []).forEach((m: any) => { mN[m.id] = m.name; });
  const typeLabel: any = { manual_safe_move: "Chuyển tay", manual_emergency_move: "Khẩn cấp (tay)", automatic_failover: "🔁 Tự động cứu", drain_move: "Rút máy", rebalance_move: "Cân bằng tải" };
  const badge = (h: any) => {
    if (h.result === "success") return <Pill tone="green">✅ Xong</Pill>;
    if (h.result === "rolled_back") return <Pill tone="amber">↩ Hoàn tác</Pill>;
    if (h.result === "failover_failed") return <Pill tone="red">⚠ Không cứu được</Pill>;
    if (["stopping_source", "starting_target", "verifying"].includes(h.state)) return <Pill tone="blue">⏳ đang chuyển</Pill>;
    return <Pill tone="gray">{h.state || "—"}</Pill>;
  };
  return (
    <Card title="🕘 Lịch sử chuyển máy">
      <div className="scroll">
        <table>
          <thead><tr><th>Thời gian</th><th>Luồng</th><th>Nguồn → Đích</th><th>Loại</th><th>Kết quả</th><th>Người</th></tr></thead>
          <tbody>
            {history.map((h: any) => (
              <tr key={h.id}>
                <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>{fmtWhen(h.startedAt)}</td>
                <td style={{ fontSize: 12 }}>{h.streamName || "—"}</td>
                <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>{mN[h.sourceMachineId] || "?"} → <b>{mN[h.targetMachineId] || "?"}</b></td>
                <td style={{ fontSize: 11.5 }}>{typeLabel[h.moveType] || h.moveType}</td>
                <td>{badge(h)}</td>
                <td style={{ fontSize: 11.5, color: "var(--muted)" }}>{h.trigger === "auto" ? "hệ thống" : (h.initiatedByName || h.initiatedBy || "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function MachinesPanel({ machines, streams, post, busy, canInfra, uploadToken, ensureUploadTok, cluster, history, assets = [] }: any) {
  const [f, setF] = useState<any>({ name: "", ip: "", role: "stream-247", uploadMbps: "", provider: "", region: "", uploadHttpsUrl: "", costAmount: "", costPeriod: "month", costRenewAt: "" });
  const [showSetup, setShowSetup] = useState<string>("");
  const add = async () => { if (await post({ action: "add_machine", ...f, uploadMbps: Number(f.uploadMbps) || 0 }, "Đã thêm máy.")) setF({ name: "", ip: "", role: "stream-247", uploadMbps: "", provider: "", region: "", uploadHttpsUrl: "", costAmount: "", costPeriod: "month", costRenewAt: "" }); };
  return (
    <>
      {!canInfra && <p className="plain" style={{ marginTop: 0 }}>Bạn xem được danh sách máy (để chọn khi tạo luồng). Quản lý máy/khoá do Admin/Ban lãnh đạo.</p>}
      {canInfra && <ClusterCapacityCard cluster={cluster} />}
      {canInfra && <MoveHistoryCard history={history} machines={machines} />}
      {canInfra && <Card title="🖥 Thêm máy (VPS)">
        <div className="form">
          <Field label="Tên máy"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="VD: Máy 24/7 số 1" /></Field>
          <Field label="Địa chỉ IP"><input value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value })} placeholder="203.0.113.10" /></Field>
          <Field label="Vai trò"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="stream-247">Live 24/7</option><option value="live-pub">Live Pub</option><option value="shared">Dùng chung</option></select></Field>
          <Field label="Tốc độ đẩy — upload (Mbps, để tính sức chứa)"><input value={f.uploadMbps} onChange={(e) => setF({ ...f, uploadMbps: e.target.value })} placeholder="VD: 740 (đo bằng speedtest)" inputMode="numeric" /></Field>
          <Field label="Nhà cung cấp (để chọn máy cứu ở nhà cung cấp khác)"><input value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} placeholder="VD: Netcup, LowendViet…" /></Field>
          <Field label="Địa chỉ nhận file HTTPS (để tải-thẳng lên máy này — tùy chọn)"><input value={f.uploadHttpsUrl} onChange={(e) => setF({ ...f, uploadHttpsUrl: e.target.value })} placeholder="VD: https://live2.<TEN-MIEN-CUA-BAN> (bỏ trống nếu chưa gắn HTTPS)" /></Field>
          <Field label="Khu vực"><input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} placeholder="VD: Đức, Việt Nam, Singapore…" /></Field>
          {/* GIÁ THUÊ + HẠN GIA HẠN (30/08/2026 — Chủ Rise Group yêu cầu). Bỏ trống được: máy chưa
              nhập thì không tính vào tổng và không nhắc gia hạn. Chu kỳ tháng/năm vì mỗi nhà cung
              cấp một kiểu — hệ tự quy về mỗi tháng khi cộng tổng. */}
          <Field label="Giá thuê (bỏ trống nếu chưa biết)"><input value={f.costAmount} onChange={(e) => setF({ ...f, costAmount: e.target.value })} placeholder="VD: 29 (đơn vị $)" inputMode="decimal" /></Field>
          <Field label="Chu kỳ trả tiền"><select value={f.costPeriod} onChange={(e) => setF({ ...f, costPeriod: e.target.value })}><option value="month">Mỗi tháng</option><option value="year">Mỗi năm</option></select></Field>
          <Field label="Ngày hết hạn thuê (để nhắc gia hạn)"><input type="date" value={f.costRenewAt} onChange={(e) => setF({ ...f, costRenewAt: e.target.value })} /></Field>
        </div>
        <button className="primary small" disabled={busy} onClick={add} style={{ marginTop: 10 }}>Thêm máy</button>
      </Card>}

      <Card title="🖥 Máy live">
        {machines.length === 0 ? <p className="empty" style={{ margin: 0 }}>Chưa có máy nào. Thêm máy rồi cài "worker" theo hướng dẫn.</p> : (() => { const banMoiNhat = banCongCuMoiNhat(machines); return (
          <div className="scroll">
            <table>
              <thead><tr><th>Tên</th><th>IP</th><th>Vai trò</th><th>NCC / Khu vực</th><th>Tình trạng</th><th>Cấu hình</th><th>Băng thông</th><th>Giá thuê / hạn</th><th>Luồng</th><th></th></tr></thead>
              <tbody>
                {machines.map((m: any) => (
                  <tr key={m.id}>
                    <td>{canInfra ? <MachineName m={m} post={post} busy={busy} /> : <b>{m.name}</b>}</td>
                    <td><code style={{ fontSize: 11 }}>{m.ip}</code></td>
                    <td>{m.role === "live-pub" ? "Live Pub" : m.role === "shared" ? "Dùng chung" : "Live 24/7"}</td>
                    <td style={{ fontSize: 12 }}>{canInfra ? <><MachinePlace m={m} post={post} busy={busy} /><div style={{ marginTop: 2 }}><MachineUpload m={m} post={post} busy={busy} /></div></> : ([m.provider, m.region].filter(Boolean).join(" · ") || "—")}</td>
                    <td><Pill tone={m.forceOffline ? "red" : m.maintenance ? "amber" : m.online ? "green" : "gray"}>{m.forceOffline ? "⛔ Đã ngắt" : m.maintenance ? "🛠 Bảo trì" : m.online ? "🟢 Online" : "Offline"}</Pill>{m.agentVersion ? <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>agent {m.agentVersion}</div> : null}{congCuMay(m, banMoiNhat)}</td>
                    <td style={{ fontSize: 12 }}>{m.vcpu ? `${m.vcpu} nhân · ${m.ramGb}GB` : "—"}{m.diskFreeGb != null ? ` · trống ${money(m.diskFreeGb)}GB` : ""}</td>
                    <td style={{ fontSize: 12 }}>{canInfra ? <MachineBw m={m} post={post} busy={busy} /> : (m.uploadMbps ? `${money(m.uploadMbps)} Mbps` : "—")}{m.loadAvg != null ? ` · tải ${m.loadAvg}` : ""}</td>
                    <td>{canInfra ? <MachineCost m={m} post={post} busy={busy} /> : <span style={{ fontSize: 11.5, color: "var(--muted)" }}>—</span>}</td>
                    <td>{streams.filter((s: any) => s.machineId === m.id && s.status === "live").length}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {canInfra ? <>
                        <button className="rowbtn" onClick={() => { const open = showSetup === m.id ? "" : m.id; setShowSetup(open); if (open && !uploadToken) void ensureUploadTok?.(true); }}>Cài worker</button>
                        <button className="rowbtn" disabled={busy} title="Bảo trì: KHÔNG gán luồng mới vào máy này; luồng đang chạy KHÔNG bị đụng." onClick={() => post({ action: "update_machine", id: m.id, maintenance: !m.maintenance }, m.maintenance ? "Đã bỏ bảo trì." : "Đã đặt bảo trì — máy tạm ngưng nhận luồng mới.")} style={{ marginLeft: 6, color: m.maintenance ? "#16a34a" : "#b45309" }}>{m.maintenance ? "Bỏ bảo trì" : "Bảo trì"}</button>
                        <button className="rowbtn" disabled={busy} title="Ngắt máy: coi như máy CHẾT — worker tự dừng hết luồng, hệ TỰ CỨU luồng ưu tiên sang máy khác. Dùng để thử/bảo trì khẩn (không cần SSH)." onClick={() => { const on = m.forceOffline === true; if (on || confirm(`NGẮT máy "${m.name}"?\n\nMọi luồng trên máy này sẽ DỪNG; luồng đặt "tự động cứu" sẽ tự chuyển sang máy khác. Bấm "Bật lại" để khôi phục.`)) void post({ action: "set_machine_offline", id: m.id, offline: !on }, on ? "Đã bật lại máy." : "Đã NGẮT máy — theo dõi auto-failover."); }} style={{ marginLeft: 6, fontWeight: 700, color: m.forceOffline ? "#16a34a" : "#b3352c" }}>{m.forceOffline ? "▶ Bật lại máy" : "⛔ Ngắt máy"}</button>
                        {streams.filter((s: any) => s.machineId === m.id).length === 0 && (
                          <button className="rowbtn" disabled={busy} onClick={() => {
                            // NÓI RÕ HẬU QUẢ trước khi xoá (30/08/2026). Trước đây chỉ hỏi "Xoá máy X?" —
                            // xoá xong video của máy đó nằm lại thành bản ghi mồ côi mà không ai biết.
                            const nVid = assets.filter((a: any) => a.machineId === m.id).length;
                            const canhBao = nVid ? `

Máy này đang giữ ${nVid} video — xoá máy thì các video đó cũng bị dọn khỏi Kho video (file trên máy mất theo máy). Video đang được luồng nào dùng thì hệ sẽ CHẶN, không xoá.` : "";
                            if (confirm(`Xoá máy "${m.name}"?${canhBao}`)) void post({ action: "delete_machine", id: m.id }, "Đã xoá máy."); }} style={{ marginLeft: 6, color: "#dc2626" }}>Xoá</button>
                        )}
                      </> : <span style={{ color: "var(--muted)", fontSize: 12 }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ); })()}
        {showSetup && (() => {
          const setupM = machines.find((m: any) => m.id === showSetup);
          let upHost = "";
          try { upHost = setupM?.uploadHttpsUrl ? new URL(String(setupM.uploadHttpsUrl)).hostname : ""; } catch { upHost = ""; }
          // Neu may DA khai dia chi tai-thang (uploadHttpsUrl) -> them luon phan Caddy dung HTTPS (tu lay chung
          // chi Let's Encrypt) chuyen ve cong 8099 -> tai-thang tu may tinh dung duoc NGAY sau khi chay script.
          const caddyBlock = upHost
            ? `\n# --- HTTPS tai-thang (Caddy) cho ${upHost} -> chuyen ve cong 8099 ---\napt install -y gnupg debian-keyring debian-archive-keyring apt-transport-https\ncurl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg\ncurl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null\napt update && apt install -y caddy\nprintf '%s {\\n    reverse_proxy localhost:8099\\n}\\n' "${upHost}" >/etc/caddy/Caddyfile\ncommand -v ufw >/dev/null 2>&1 && { ufw allow 80/tcp; ufw allow 443/tcp; }\nsystemctl restart caddy
command -v caddy >/dev/null 2>&1 && echo 'OK: da cai Caddy — cho 1-2 phut lay chung chi roi tai-thang duoc' || echo 'LOI: CHUA cai duoc Caddy -> tai-thang len may nay SE KHONG CHAY. Chay lai khoi nay hoac bao lai de kiem.'`
            : "";
          return (
          <div style={{ marginTop: 12, background: "var(--card,#f8fafc)", border: "1px solid var(--border,#eef2f7)", borderRadius: 10, padding: 12 }}>
            <b>Cài / Cập nhật "worker" trên máy này (Ubuntu)</b>
            <p className="plain" style={{ margin: "6px 0" }}>SSH vào VPS (Ubuntu) rồi dán NGUYÊN khối dưới — <b>vé xác thực RIÊNG của máy này đã điền sẵn</b> (không cần sửa gì). Khối này tự cài đủ phần mềm (python3 · ffmpeg · <b>yt-dlp · gdown</b> để tải Drive · speedtest) + tải worker + tạo dịch vụ <b>tự khởi động lại</b> khi reboot/lỗi. Chạy lại = cập nhật worker bản mới.{upHost ? <> Máy này đã khai địa chỉ tải-thẳng nên khối còn <b>tự dựng HTTPS (Caddy) cho {upHost}</b> → tải-thẳng từ máy tính dùng được ngay.</> : <> <i>Muốn tải-thẳng từ máy tính lên máy này? Tạo DNS <b>liveN."TEN-MIEN-CUA-BAN" → IP máy</b>, bấm "📤 tải-thẳng: chưa gắn" điền địa chỉ đó, rồi chạy lại khối này (sẽ tự thêm HTTPS).</i></>}</p>
            <pre style={{ background: "#0e1420", color: "#d5deea", padding: 12, borderRadius: 8, overflowX: "auto", fontSize: 12 }}>{`RISE_LIVE_MACHINE="${showSetup}"
RISE_LIVE_TOKEN="${machines.find((m: any) => m.id === showSetup)?.installToken || "<TOKEN>"}"
RISE_LIVE_UPLOAD_TOKEN="${uploadToken || ""}"

RISE_LIVE_URL="https://<DIA-CHI-MAY-CHU-CUA-BAN>"
find /etc/apt -iname '*esm*' -exec mv {} {}.disabled \; 2>/dev/null || true
apt update; apt install -y --fix-missing python3 python3-pip ffmpeg speedtest-cli curl wget yt-dlp
command -v pip3 >/dev/null 2>&1 || apt install -y python3-pip || true
PIP=pip3; command -v pip3 >/dev/null 2>&1 || PIP="python3 -m pip"
$PIP install -U yt-dlp gdown || $PIP install -U --break-system-packages yt-dlp gdown || echo 'CANH BAO: pip cai yt-dlp/gdown that bai'
(curl -fsSL https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-x86_64.tgz -o /tmp/ookla.tgz 2>/dev/null || wget -qO /tmp/ookla.tgz https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-x86_64.tgz 2>/dev/null) && tar -xzf /tmp/ookla.tgz -C /usr/local/bin speedtest 2>/dev/null || true
curl -fsSL "$RISE_LIVE_URL/rise-live-agent.py" -o /root/rise-live-agent.py 2>/dev/null || wget -qO /root/rise-live-agent.py "$RISE_LIVE_URL/rise-live-agent.py" 2>/dev/null || python3 -c "import urllib.request; urllib.request.urlretrieve('$RISE_LIVE_URL/rise-live-agent.py','/root/rise-live-agent.py')"
cat >/root/rise-live.env <<EOF
RISE_LIVE_URL=$RISE_LIVE_URL
RISE_LIVE_TOKEN=$RISE_LIVE_TOKEN
RISE_LIVE_MACHINE=$RISE_LIVE_MACHINE
RISE_LIVE_UPLOAD_TOKEN=$RISE_LIVE_UPLOAD_TOKEN
RISE_LIVE_UPLOAD_PORT=8099
PYTHONIOENCODING=utf-8
EOF
chmod 600 /root/rise-live.env
cat >/etc/systemd/system/rise-live.service <<'EOF'
[Unit]
Description=Rise Live Worker Agent
After=network-online.target
Wants=network-online.target
[Service]
EnvironmentFile=/root/rise-live.env
ExecStart=/usr/bin/python3 /root/rise-live-agent.py
Restart=always
RestartSec=5
User=root
# KillMode=process (30/08/2026): khi khoi dong lai worker, KHONG giet cac tien trinh phat song con
# cua no. Truoc day systemd dung mac dinh "giet ca cum" -> moi lan keo worker ban moi la CA MAY DUT
# SONG vai giay (o 125 luong la 125 lan chop tat). Nay worker ban r2.36+ tu NHAN LAI cac luong dang
# phat, doi chieu theo khoa luong, khop thi giu - khong khop thi giet. Nguyen tac "mot khoa mot tien
# trinh" van duoc giu.
# LUU Y VAN HANH: muon DUNG han mot may thi dung nut "Ngat may" tren app (worker se dung luong dung
# cach), DUNG chay "systemctl stop" - stop se de lai tien trinh phat chay tiep ma khong ai quan.
KillMode=process
[Install]
WantedBy=multi-user.target
EOF
command -v ufw >/dev/null 2>&1 && ufw allow 8099/tcp || true
systemctl daemon-reload && systemctl enable rise-live && systemctl restart rise-live
sleep 2 && systemctl status rise-live --no-pager | head -20
echo '--- KIEM CONG CU TAI VIDEO ---'
THIEU=0
for t in ffmpeg yt-dlp gdown; do command -v $t >/dev/null 2>&1 && echo \"  OK    $t\" || { echo \"  THIEU $t\"; THIEU=1; }; done
YTV=$(yt-dlp --version 2>/dev/null | head -1)
echo \"  ban yt-dlp: \${YTV:-khong doc duoc}\"
case \"$YTV\" in 2025.*|2026.*|2027.*|2028.*) ;; *) echo '  !! yt-dlp QUA CU hoac chua cai'; THIEU=1;; esac
if [ \"$THIEU\" = \"1\" ]; then
  echo ''
  echo '###############################################################'
  echo '#  MAY CHUA CAI XONG — TAI VIDEO TU GOOGLE DRIVE SE HONG      #'
  echo '#  hoac CHAM HANG CHUC LAN. DUNG dung may nay de them video.  #'
  echo '#                                                             #'
  echo '#  Cach xu, chay lan luot:                                    #'
  echo '#    apt-get install -y python3-pip                           #'
  echo '#    pip3 install -U --break-system-packages yt-dlp gdown     #'
  echo '#    systemctl restart rise-live                              #'
  echo '#  Neu apt bao 401 o esm.ubuntu.com:                          #'
  echo '#    mv /etc/apt/sources.list.d/*esm* /root/ ; apt-get update #'
  echo '###############################################################'
else
  echo '  => Cong cu tai video DAY DU. May san sang.'
fi${caddyBlock}`}</pre>
            <p className="plain" style={{ margin: 0 }}>Máy hiện <b>🟢 Online</b> trong ~10 giây, tự báo cấu hình + băng thông về đây. (Dòng cuối in <code>active (running)</code> là chạy ngon.){upHost ? <> Sau khi Caddy lấy chứng chỉ (~1-2 phút), <b>tải-thẳng lên {upHost}</b> chạy được.</> : null}</p>
          </div>
          );
        })()}
      </Card>
    </>
  );
}
