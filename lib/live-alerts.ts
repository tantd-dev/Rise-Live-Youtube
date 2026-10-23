// RISE LIVE — CẢNH BÁO (suy ra từ trạng thái). Dùng chung cho: bảng Tổng quan (/api/live GET)
// + gửi Email (cron /api/live/alerts/run). THUẦN — nhận mảng máy/luồng/asset, trả danh sách cảnh báo.
//
// Chuẩn theo "Danh mục sự cố Rise Live": mỗi cảnh báo có MỨC ĐỘ (INFO→EMERGENCY) + MÃ (RL-XXX) để tra
// cứu/Runbook. Gom theo MÁY: máy chết → luồng hết tươi (fresh=false) → KHÔNG bắn cảnh báo rời từng luồng,
// chỉ 1 cảnh báo MÁY nêu rõ ẢNH HƯỞNG (N luồng, có kênh ưu tiên không) — tránh spam (RL-SCL-002).
export type LiveAlertLevel = "critical" | "warn";
export type LiveAlertSeverity = "INFO" | "WARNING" | "CRITICAL" | "EMERGENCY";
export interface LiveAlert {
  level: LiveAlertLevel;        // giữ tương thích cũ (critical/warn) — UI/email cũ vẫn đọc được
  severity: LiveAlertSeverity;  // thang chuẩn đề bài
  code: string;                 // mã sự cố RL-XXX (tra cứu/Runbook)
  kind: string;
  text: string;
  fingerprint: string;
  priority: boolean;            // liên quan KÊNH/LUỒNG ƯU TIÊN (RL-SCL-001) → đẩy lên đầu, báo mạnh hơn
}

// EMAIL chỉ dành cho sự cố "phải xử ngay": luồng SẬP + MẤT TÍN HIỆU (khán giả đang mất sóng).
// Mọi cảnh báo khác (ổ thấp, CPU, nén-khi-live, restart, video lỗi…) CHỈ hiện trong app —
// tránh cháy quota 100 mail/ngày. Muốn thêm loại nào vào email thì thêm 'kind' vào đây.
// EMAIL chỉ cho vài loại "sập cứng" — GIỮ NHỎ vì quota chỉ 100 mail/ngày. Sự cố quan trọng khác đã
// PUSH điện thoại (không tốn quota mail). KHÔNG thêm loại vào đây kẻo cháy quota mail (Chủ Rise dặn).
import { LIVE_THRESHOLDS as TH } from "@/lib/live-alert-thresholds";
import { laXacCopyHong, loiCopyDeHieu } from "@/lib/live-copy-cleanup";

export const EMAIL_ALERT_KINDS = new Set(["stream_error", "machine_offline", "stream_nodata"]);
export function emailWorthyAlerts(alerts: LiveAlert[]): LiveAlert[] {
  return alerts.filter((a) => EMAIL_ALERT_KINDS.has(a.kind) || a.severity === "EMERGENCY" || a.priority);
}

// Máy "online" nếu heartbeat trong 60 giây.
export function machineOnline(m: any, nowMs: number): boolean {
  const t = Date.parse(String(m.lastHeartbeatAt ?? "")); return Number.isFinite(t) && nowMs - t < TH.machineOnlineMs;
}
// Luồng "còn tươi" — worker còn báo trạng thái gần đây. BÌNH THƯỜNG = 60s (worker báo ~20s/lần).
// Khi bật GHI-KHI-ĐỔI (RISE_LIVE_WRITE_ON_CHANGE=1): worker CHỈ ghi lastHeartbeatAt khi có thay đổi
// hoặc mỗi ~120s (đỡ chi phí ghi khi luồng ổn định) → phải NỚI ngưỡng tươi lên 200s cho khớp, tránh
// báo "chết oan" luồng đang chạy tốt. Chết THẬT vẫn bắt: máy chết → cảnh báo MÁY; luồng lỗi → worker
// báo status/health=error NGAY (không đợi hết tươi).
// Ngưỡng gom về lib/live-alert-thresholds.ts (D-RL-05) — giá trị y hệt trước khi gom.
const STREAM_FRESH_MS = TH.streamFreshMs();
export function streamFresh(s: any, nowMs: number): boolean {
  const t = Date.parse(String(s.lastHeartbeatAt ?? "")); return Number.isFinite(t) && nowMs - t < STREAM_FRESH_MS;
}

import type { KetQuaXacMinh } from "@/lib/live-machine-probe";

// `xacMinh` (tuỳ chọn) = kết quả GỌI THẲNG vào máy để xác minh nó có thật sự chết không.
// KHÔNG truyền → giữ nguyên hành vi cũ (màn Live gọi mỗi lần làm mới, không nên đi kèm phép thử mạng).
// Chỉ cron cảnh báo truyền vào, vì đó là chỗ quyết định có hô hoán và có cứu luồng hay không.
export function computeLiveAlerts(machines: any[], streams: any[], assets: any[], nowMs: number, xacMinh?: KetQuaXacMinh): LiveAlert[] {
  const alerts: LiveAlert[] = [];
  const push = (severity: LiveAlertSeverity, code: string, kind: string, id: string, text: string, priority = false) => {
    const level: LiveAlertLevel = severity === "WARNING" || severity === "INFO" ? "warn" : "critical";
    alerts.push({ level, severity, code, kind, text, fingerprint: `${kind}:${id}`, priority });
  };
  // 28/08/2026: truoc chi doc co CU (priority/important) -> luong dat "⭐ Uu tien"
  // bang o chon MOI (importance) KHONG duoc gan nhan uu tien, nen canh bao cua no
  // khong duoc gui mail leo thang. Doc dung cach ca he thong dang doc.
  const streamPriority = (s: any) => {
    const i = String(s.importance || (s.priority || s.important ? "priority" : "normal"));
    return i === "priority" || i === "critical";
  };

  // ── PHÁN ĐOÁN TRƯỚC KHI HÔ (30/08/2026) ─────────────────────────────────────────────────────
  // Trước đây chỉ hỏi đúng một câu "quá 60 giây chưa" rồi hô NGHIÊM TRỌNG. Chớp 60 giây cũng bị dán
  // nhãn "1 sự cố NGHIÊM TRỌNG cần xử lý" — và người nhận hoảng, vào chuyển luồng, mỗi lần chuyển
  // cắt vài giây sóng THẬT để chữa một sự cố KHÔNG CÓ THẬT (Chủ Rise Group: "hoảng hốt vào chuyển
  // luồng thì toi"). Nay dùng nốt các manh mối vốn đã có sẵn nhưng bị bỏ không.
  const imLau = (m: any) => Math.max(0, Math.round((nowMs - (Date.parse(String(m.lastHeartbeatAt ?? "")) || nowMs)) / 1000));
  const muonPhat = (m: any) => streams.some((s) => s.machineId === m.id && (s.desiredState === "live" || (s.control === "schedule" && s.scheduleActive)));
  // MÁY ĐANG BẢO TRÌ THÌ KHÔNG BÁO LÀ CHẾT (30/08/2026 — Chủ Rise Group duyệt).
  // Bảo trì là trạng thái CÓ CHỦ ĐÍCH: người quản trị tự bấm để thay máy / sửa máy / chuẩn bị xoá.
  // Máy im lúc đó là ĐÚNG Ý, không phải sự cố. Trước đây vẫn hô "MẤT LIÊN LẠC", dội email cho cả
  // nhóm, và còn gọi xác minh vào máy vô ích — mỗi lần thay VPS là một trận báo động giả.
  //
  // RANH GIỚI CỐ Ý KHÔNG VƯỢT: chỉ TẮT TIẾNG CẢNH BÁO, KHÔNG tắt tự cứu luồng. Nếu máy bảo trì vẫn
  // còn luồng ưu tiên và chết thật thì luồng vẫn được dời sang máy khác như thường. Tắt cứu luồng là
  // đánh đổi sóng lấy sự yên tĩnh — không làm.
  const baoTri = (m: any) => m?.maintenance === true;
  const dangIm = machines.filter((m) => !machineOnline(m, nowMs) && !baoTri(m) && muonPhat(m));
  // NHIỀU MÁY CÙNG IM = gần như chắc chắn lỗi PHÍA MÌNH, không phải VPS. Năm máy ở hai nhà cung cấp
  // khác nhau không thể cùng chết trong một giây. Trước đây hệ bắn 5 cảnh báo "VPS mất kết nối" và cả
  // đội đi gọi nhà cung cấp — sai hoàn toàn hướng.
  const loiPhiaMinh = dangIm.length >= 2;
  if (loiPhiaMinh) {
    const ten = dangIm.map((m: any) => `"${m.name}"`).join(", ");
    push("EMERGENCY", "RL-NET-006", "cluster_quiet", "cluster",
      `Hệ thống MẤT LIÊN LẠC với ${dangIm.length}/${machines.length} máy cùng lúc (${ten}) — nhiều máy ở nhiều nhà cung cấp không thể cùng hỏng, nghi lỗi PHÍA HỆ THỐNG. Kiểm hệ thống trước khi gọi nhà cung cấp. Luồng live đi thẳng từ VPS lên YouTube nên có thể vẫn đang phát bình thường.`, true);
  }

  for (const m of machines) {
    const online = machineOnline(m, nowMs);
    // "Đang muốn phát" = bật tay (desiredState live) HOẶC luồng HẸN GIỜ đang trong khung giờ. KHÔNG chỉ
    // desiredState="live": luồng hẹn giờ giữ desiredState="stopped" cả khi đang phát → nếu bỏ sót thì máy
    // chết mà chỉ có luồng hẹn giờ sẽ KHÔNG bắn cảnh báo/không gửi mail. (scheduleActive tính ở route/cron.)
    const onMachine = streams.filter((s) => s.machineId === m.id && (s.desiredState === "live" || (s.control === "schedule" && s.scheduleActive)));
    const wantLive = onMachine.length > 0;
    // Máy đang BẢO TRÌ im là ĐÚNG Ý người quản trị → không báo động (xem khối `baoTri` ở trên).
    // Tự cứu luồng KHÔNG bị đụng: nó chạy ở app/api/live/failover/run, không đi qua đây.
    if (!online && wantLive && !baoTri(m)) {
      // RL-SCL-002 / RL-NET-003: gom về 1 cảnh báo MÁY, nêu rõ ẢNH HƯỞNG (bao nhiêu luồng, có kênh ưu tiên).
      const prio = onMachine.filter(streamPriority);
      const chans = Array.from(new Set(onMachine.map((s) => s.channelName).filter(Boolean)));
      // NÓI ĐÚNG THỨ HỆ BIẾT (30/08/2026). Trước đây câu này khẳng định "N luồng đang tắt" — nhưng hệ
      // KHÔNG kiểm từng luồng, nó chỉ biết MÁY NGỪNG BÁO CÁO rồi suy ra. Luồng chạy bằng tiến trình
      // riêng trên máy: máy ngừng BÁO CÁO không có nghĩa luồng ngừng PHÁT.
      // Sự cố thật 30/08: VPS 05 im đúng 60 giây, cảnh báo hô "28 luồng đang tắt" — vào kiểm thì cả 28
      // luồng vẫn chạy liên tục, số lần bật lại = 0. Người nhận đi tìm một sự cố không tồn tại.
      const giay = imLau(m);
      const phut = Math.round(giay / 60);
      // Luồng trên máy vừa báo lỗi MẠNG trước khi im → gọi đúng tên: mạng VPS gián đoạn.
      const loiMang = onMachine.some((s) => /network is unreachable|no route|temporary failure|timed out|failed to resolve|name or service/i.test(String(s.error ?? "") + " " + String(s.haltReason ?? "")));
      const keNh = chans.length ? ` · kênh: ${chans.slice(0, 4).join(", ")}${chans.length > 4 ? "…" : ""}` : "";
      // NÓI ĐÚNG NGHĨA: "mất kết nối" đang bị hiểu là MẤT MẠNG. Thực ra chỉ là mất liên lạc VỚI HỆ
      // THỐNG. Luồng live đi VPS → YouTube, KHÔNG qua máy chủ Rise Work — nên máy chủ mất liên lạc
      // với VPS KHÔNG nói lên được gì về việc luồng còn phát hay không. Đây là gốc sâu nhất của vụ
      // 30/08: cảnh báo hô "28 luồng đang tắt" trong khi cả 28 luồng chạy liên tục không gián đoạn.
      const giaiThich = " Luồng live đi thẳng từ VPS lên YouTube, KHÔNG qua hệ thống — nên có thể vẫn đang phát bình thường. Kiểm trên YouTube trước khi kết luận.";
      // ĐÃ GỌI VÀO VÀ MÁY TRẢ LỜI → máy SỐNG, chỉ là nó không gọi ra được. Đây chính xác là ca VPS 05
      // ngày 30/08: im 72 giây vì một lượt gửi lạc đường, trong khi cả 28 luồng phát liên tục.
      // Vẫn ghi một cảnh báo NHẸ để có dấu vết, nhưng KHÔNG hô nghiêm trọng, KHÔNG email, KHÔNG rung.
      const xacMinhSong = xacMinh?.tinDuoc && xacMinh.songNhungKhongGoiVe.has(m.id);
      const xacMinhChet = xacMinh?.tinDuoc && xacMinh.chet.has(m.id);
      if (loiPhiaMinh) {
        // Đã có cảnh báo gộp ở trên — không bắn thêm từng máy, tránh dội 5 cảnh báo cho một sự việc.
      } else if (xacMinhSong) {
        push("WARNING", "RL-NET-007", "machine_one_way", m.id,
          `Máy "${m.name}" KHÔNG GỌI VỀ ĐƯỢC ${giay} giây, nhưng hệ thống GỌI VÀO VẪN TRẢ LỜI — máy còn sống, ${onMachine.length} luồng nhiều khả năng vẫn phát bình thường${keNh}. Không cần xử lý gấp; nếu lặp nhiều lần thì kiểm đường mạng VPS ra ngoài.`, false);
      } else if (xacMinhChet) {
        const prioNote2 = prio.length ? ` ⭐ CÓ ${prio.length} KÊNH ƯU TIÊN — xử lý gấp.` : "";
        push("EMERGENCY", "RL-NET-003", "machine_offline", m.id,
          `Máy "${m.name}" MẤT KẾT NỐI ${giay < 90 ? giay + " giây" : phut + " phút"} — ĐÃ XÁC MINH: gọi thẳng vào máy cũng không trả lời. Kiểm tra ${onMachine.length} luồng đang chạy trên máy này${keNh}.${prioNote2}`, prio.length > 0);
      } else if (giay < TH.machineQuietSeriousSec) {
        // IM NGẮN: nhiều khả năng chỉ lỡ vài nhịp báo cáo. Mức NHẮC, KHÔNG email, KHÔNG rung điện thoại.
        push("WARNING", "RL-NET-003", "machine_quiet", m.id,
          `Máy "${m.name}" GIÁN ĐOẠN LIÊN LẠC ${giay} giây — ${onMachine.length} luồng đang chạy trên máy này${keNh}. Chưa có dấu hiệu ảnh hưởng, đang theo dõi.${giaiThich}`, false);
      } else {
        const ten = loiMang ? "MẠNG VPS GIÁN ĐOẠN" : "MẤT LIÊN LẠC VỚI HỆ THỐNG";
        const prioNote = prio.length ? ` ⭐ CÓ ${prio.length} KÊNH ƯU TIÊN — xử lý gấp.` : "";
        push("EMERGENCY", "RL-NET-003", "machine_offline", m.id,
          `Máy "${m.name}" ${ten} ${phut} phút — kiểm tra ${onMachine.length} luồng đang chạy trên máy này${keNh}.${prioNote}${giaiThich}`, prio.length > 0);
      }
    }
    // CPU: chỉ cảnh báo khi QUÁ TẢI THẬT (load > 1.5× số nhân) — nén video làm load cao tạm thời
    // là bình thường (live copy-codec vẫn nhẹ), không kêu oan.
    if (m.loadAvg != null && m.vcpu && m.loadAvg > m.vcpu * TH.cpuLoadFactor) push("WARNING", "RL-RES-003", "cpu_high", m.id, `Máy "${m.name}" QUÁ TẢI CPU (${m.loadAvg}/${m.vcpu} nhân) — có thể do quá nhiều video nén cùng lúc.`);
    // Nén/tải video TRONG KHI đang có luồng phát trên cùng máy → CPU dễ nóng, có thể ảnh hưởng luồng.
    if (online && wantLive && assets.some((a) => a.machineId === m.id && (a.status === "normalizing" || a.status === "downloading")))
      push("WARNING", "RL-MED-012", "normalize_while_live", m.id, `Máy "${m.name}" đang NÉN/TẢI video trong khi có luồng đang phát — theo dõi CPU, tránh nén nặng giờ cao điểm.`);
    // RL-MED-015 — CÔNG CỤ TẢI DRIVE hỏng/cũ (V71.17). Sự cố 29–30/08/2026: VPS 06 mới dựng KHÔNG có
    // pip3 → cả khối cài lẫn cơ chế tự cập nhật hằng ngày đều thất bại IM LẶNG; máy chạy yt-dlp bản
    // 2022, tải Drive chậm 56 lần khả năng thật của chính nó, suốt một ngày không ai biết. Máy vẫn
    // báo Online, vẫn xanh, không có một dấu hiệu nào. Từ nay máy tự khai và hệ tự kêu.
    if (online && m.toolError) push("WARNING", "RL-MED-015", "tool_broken", m.id, `Máy "${m.name}": ${String(m.toolError).slice(0, 200)}`);
    else if (online && m.agentVersion && m.ytdlpVersion === "") push("WARNING", "RL-MED-015", "tool_broken", m.id, `Máy "${m.name}" CHƯA CÓ công cụ tải Drive (yt-dlp) — thêm video từ link Drive sẽ chậm hoặc hỏng.`);
    // RL-MED-014 — TẢI VIDEO CHẬM BẤT THƯỜNG. Đo trên chính lần tải gần đây của máy (worker r2.34 báo
    // MB/phút). Bỏ qua video nhỏ vì thời gian tải quá ngắn thì con số nhiễu.
    {
      // CHỈ XÉT LẦN TẢI GẦN ĐÂY. Không có mốc thời gian thì cảnh báo này không bao giờ tự tắt:
      // video tải chậm đêm qua vẫn kêu sáng hôm sau dù đã tải xong và đang phát bình thường
      // (Chủ Rise Group báo 01/09/2026).
      // ĐANG TẢI thì cảnh báo suốt (đang chậm THẬT, sửa được ngay). TẢI XONG rồi thì chỉ nhắc
      // một lúc ngắn cho có người thấy, KHÔNG kêu tiếp 6 tiếng.
      //
      // Vì sao (Chủ Rise Group hỏi 03/09/2026: "video đã lên xong rồi thì bao lâu mới hết báo lỗi?"):
      // trước đây chỉ xét "cập nhật trong 6 giờ", không nhìn trạng thái. Đo lúc đó có đúng 1 video
      // — "R&J FAMILY 3.9 CẮM", 87 MB/phút, ĐÃ SẴN SÀNG, xong được 0,4 giờ — mà vẫn còn kêu thêm
      // gần 6 tiếng nữa dù nó đã tải xong và đang phát bình thường. Cảnh báo về việc ĐÃ XONG thì
      // không còn gì để xử lý, chỉ làm nhiễu.
      const moiTai = (a: any) => {
        const t = Date.parse(String(a?.updatedAt ?? a?.createdAt ?? ""));
        if (!Number.isFinite(t)) return false;
        const tuoi = nowMs - t;
        if (String(a?.status) === "downloading") return tuoi <= TH.slowDownloadWindowMs;   // đang tải: giữ cửa sổ dài
        return tuoi <= TH.slowDownloadDoneWindowMs;                                          // đã xong: nhắc ngắn rồi thôi
      };
      const cham = assets.filter((a) => a.machineId === m.id && Number(a.dlMbPerMin) > 0
        && Number(a.dlMbPerMin) < TH.slowDownloadMbPerMin && Number(a.sizeMb) >= TH.slowDownloadMinSizeMb
        && moiTai(a));
      if (online && cham.length) {
        const chamNhat = cham.reduce((x, y) => (Number(x.dlMbPerMin) <= Number(y.dlMbPerMin) ? x : y));
        push("WARNING", "RL-MED-014", "download_slow", m.id,
          `Máy "${m.name}" TẢI VIDEO CHẬM BẤT THƯỜNG — ${Math.round(Number(chamNhat.dlMbPerMin))} MB/phút ("${String(chamNhat.name ?? "video").slice(0, 40)}"), trong khi máy khoẻ đạt hơn 1.000 MB/phút. Kiểm tra công cụ tải trên máy này trước, rồi tới đường mạng đi Google.`);
      }
    }
    // RL-MED-016 — SỔ NÓI CÓ, MÁY KHÔNG CÓ FILE (30/08/2026 — Chủ Rise Group duyệt).
    // Sự cố thật: sổ ghi 2 video "sẵn sàng" trên một máy nhưng file đã bị xoá khỏi ổ. Luồng dùng
    // chúng đứng im ở "Chờ chạy" KHÔNG BÁO GÌ — worker gặp thiếu video thì lặng lẽ bỏ qua. Phải mất
    // nhiều giờ mới phát hiện, và chỉ vì có người tình cờ nhìn thấy.
    // ÂN HẠN 5 PHÚT là bắt buộc: worker vừa khởi động lại thì bộ nhớ của nó trống, báo về rỗng, nhìn
    // như mất sạch video — nó tự nhận lại trong 1–2 nhịp (~40 giây). Chỉ kêu khi lệch KÉO DÀI.
    {
      const tu = Date.parse(String(m.assetMissingSince ?? "")) || 0;
      const thieu: string[] = Array.isArray(m.assetMissing) ? m.assetMissing : [];
      if (online && thieu.length && tu && nowMs - tu > TH.assetMissingGraceMs) {
        const tenThieu = thieu.map((id) => String(assets.find((a) => a.id === id)?.name ?? id).slice(0, 34));
        push("CRITICAL", "RL-MED-016", "asset_missing", m.id,
          `Máy "${m.name}": ${thieu.length} video sổ ghi SẴN SÀNG nhưng máy KHÔNG CÓ FILE (${Math.round((nowMs - tu) / 1000 / 60)} phút) — ${tenThieu.slice(0, 3).join(", ")}${thieu.length > 3 ? "…" : ""}. Luồng dùng những video này sẽ đứng ở "Chờ chạy" mà không báo lỗi. Xử: thêm lại video (video tải-thẳng KHÔNG tự tải lại được), hoặc chép từ máy khác.`);
      }
    }
    if (m.diskFreeGb != null && m.diskGb) {
      const pct = m.diskFreeGb / m.diskGb;
      if (pct < TH.diskCritPct || m.diskFreeGb < TH.diskCritFreeGb) push("CRITICAL", "RL-RES-002", "disk_full", m.id, `Máy "${m.name}" GẦN ĐẦY Ổ (còn ${Math.round(m.diskFreeGb)}GB) — dọn video không dùng ngay. (Đã CHẶN tải/nén video mới để bảo vệ luồng đang chạy.)`);
      else if (pct < TH.diskWarnPct) push("WARNING", "RL-RES-001", "disk_low", m.id, `Máy "${m.name}" ổ còn ${Math.round(m.diskFreeGb)}GB (${Math.round(pct * 100)}%) — nên dọn video cũ.`);
    } else if (m.diskFreeGb != null && m.diskFreeGb < TH.diskWarnFreeGbNoTotal) {
      push("WARNING", "RL-RES-001", "disk_low", m.id, `Máy "${m.name}" sắp đầy ổ (còn ${Math.round(m.diskFreeGb)}GB).`);
    }
    // BĂNG THÔNG gần đầy (RL-RES-004): txMbps (đo thật) so với uploadMbps (trần đã đặt). Gần đầy → luồng
    // dễ GIẬT. CẦN đặt ĐÚNG trần thật của máy (khi bị nhà cung cấp bóp thì đặt = mức bị bóp) mới chuẩn.
    if (online && m.txMbps != null && m.uploadMbps && m.uploadMbps > 0) {
      // TRẦN ĐO SAI: nếu ĐANG đẩy NHIỀU HƠN trần đã ghi thì trần (speedtest) chắc chắn SAI/quá thấp — không
      // thể đẩy vượt đường truyền thật. % "gần đầy" là ẢO (VD 1038/132 ~ 786%) → KHÔNG báo "sẽ giật" (tránh
      // báo động giả). Thay vào đó nhắc đặt lại trần đúng. Nghẽn THẬT vẫn bắt được qua RL-NET-005 (đo độ tụt
      // luồng, không phụ thuộc trần). Đệm 1.05 cho nhiễu đo.
      if (m.txMbps > m.uploadMbps * TH.bwCapWrongFactor) {
        push("WARNING", "RL-RES-006", "bandwidth_cap_wrong", m.id, `Máy "${m.name}" đang đẩy ${Math.round(m.txMbps)} Mbps nhưng "băng thông tối đa" chỉ ghi ${Math.round(m.uploadMbps)} Mbps — số tối đa đo được SAI/quá thấp, nên cảnh báo % băng thông của máy này KHÔNG đáng tin. Vào sửa máy đặt lại "băng thông tối đa" đúng thực tế.`);
      } else {
        const bw = m.txMbps / m.uploadMbps;
        const usage = `${Math.round(m.txMbps)}/${Math.round(m.uploadMbps)} Mbps ~ ${Math.round(bw * 100)}%`;
        if (bw >= TH.bwFull) push("CRITICAL", "RL-RES-004", "bandwidth_full", m.id, `Máy "${m.name}" GẦN ĐẦY BĂNG THÔNG (${usage}) — luồng sẽ GIẬT. Giảm bớt luồng hoặc hạ bitrate (dùng preset 1080p thay "giữ nguyên gốc").`);
        else if (bw >= TH.bwHigh) push("WARNING", "RL-RES-004", "bandwidth_high", m.id, `Máy "${m.name}" băng thông cao (${usage}) — sắp đầy, kiểm tra kẻo luồng giật. Cân nhắc giảm tải trước khi kịch trần.`);
        // NGƯỠNG AN TOÀN 70% (Chủ Rise Group chốt 27/08/2026): mức này máy VẪN CHẠY TỐT, báo sớm để
        // còn kịp xử lý — 85% là đã sát mép, 95% là đang giật rồi. Từ mốc này máy KHÔNG nhận thêm
        // luồng live mới (ô chọn máy khoá lại), nhưng vẫn nhận bản sao lưu (sao lưu không tốn Mbps).
        else if (bw >= TH.bwSafe) push("INFO", "RL-RES-008", "bandwidth_safe_limit", m.id, `Máy "${m.name}" đã chạm ngưỡng an toàn 70% (${usage}) — từ giờ KHÔNG nhận thêm luồng live mới. Máy vẫn chạy tốt; luồng mới hãy chọn máy khác còn trống.`);
      }
    }
    // NGHẼN BĂNG THÔNG MÁY (RL-NET-005) — không phụ thuộc trần nhập tay: nếu ≥2 luồng trên CÙNG máy
    // cùng TỤT tốc độ một lúc (slow) → gần như chắc chắn nghẽn băng thông cả máy, không phải lỗi 1 luồng.
    if (online) {
      const slowN = streams.filter((s) => s.machineId === m.id && streamFresh(s, nowMs) && s.status === "live" && s.slow).length;
      if (slowN >= TH.saturatedMinSlow) push("WARNING", "RL-NET-005", "machine_saturated", m.id, `Máy "${m.name}" có ${slowN} luồng CÙNG TỤT tốc độ một lúc — nhiều khả năng NGHẼN BĂNG THÔNG máy (không phải lỗi từng luồng). Giảm bớt luồng hoặc hạ bitrate.`);
    }
  }
  for (const s of streams) {
    // MỌI cảnh báo luồng chỉ tính khi worker CÒN báo tươi (heartbeat < 60s). Luồng đã DỪNG / Pub đã phát
    // xong / MÁY chết: worker thôi báo → trạng thái ĐÓNG BĂNG → KHÔNG cảnh báo (tránh báo động giả + đã
    // gom về cảnh báo MÁY ở trên). Nhờ vậy bấm Dừng luồng là cảnh báo TỰ HẾT trong ~1 phút.
    const fresh = streamFresh(s, nowMs);
    const prio = streamPriority(s);
    // GHI RÕ ĐANG Ở MÁY NÀO (01/09/2026 — Chủ Rise Group: "thông báo chớp tắt nhưng không có
    // thêm thông tin như VPS nào để kiểm tra cho tiện"). Người trực đọc cảnh báo xong việc đầu
    // tiên phải làm là biết vào máy nào — trước đây phải tự đi dò tên luồng trong 163 luồng.
    const tenMay = String(machines.find((m: any) => m.id === s.machineId)?.name ?? "").trim();
    const oMay = tenMay ? ` [máy ${tenMay}]` : "";
    const p = (sev: LiveAlertSeverity, code: string, kind: string, text: string) =>
      // Luồng ưu tiên: nâng WARNING → CRITICAL để nổi bật (không hạ cấp CRITICAL/EMERGENCY).
      push(prio && sev === "WARNING" ? "CRITICAL" : sev, code, kind, s.id, (prio ? "⭐ " : "") + text + oMay, prio);
    // RL-YTB-006: sự cố YouTube (bản quyền/đình chỉ) — cờ THỦ CÔNG (hoặc engine YT sau này). Báo LUÔN
    // (không cần fresh): YouTube có thể chặn công khai trong khi worker vẫn đẩy đều → local trông "ổn".
    if (s.ytIssue) p("CRITICAL", "RL-YTB-006", "yt_issue", `Luồng "${s.name}" NGHI BỊ CHẶN/ĐÌNH CHỈ trên YouTube${s.ytIssue.note ? `: ${s.ytIssue.note}` : ""} — dù máy vẫn đang đẩy tín hiệu. Kiểm tra YouTube Studio (báo bởi ${s.ytIssue.byName || s.ytIssue.by || "?"}).`);
    // KHÔNG báo "LỖI/SẬP" chung nếu luồng ĐÃ có cảnh báo dứt khoát hơn: restartHalted (đang tự thử lại)
    // hoặc needsHuman (đã dừng hẳn, cần người) — tránh 1 luồng đếm 2 cảnh báo nghiêm trọng (Chủ Rise Group
    // báo: "báo 4 mà chỉ 2 luồng lỗi"). needsHuman đã kèm lý do (broken pipe...) nên dòng chung là thừa.
    const reportedDown = (s.health === "error" || s.status === "error") && fresh && !s.restartHalted && !s.needsHuman;
    if (reportedDown) p("CRITICAL", "RL-PRC-001", "stream_error", `Luồng "${s.name}" LỖI/SẬP${s.error ? ": " + s.error : ""}.`);
    else if (fresh && s.desiredState === "live" && s.health === "poor") p("WARNING", "RL-YTB-004", "stream_poor", `Luồng "${s.name}" sức khoẻ KÉM.`);
    else if (fresh && s.health === "nodata" && s.status === "live") p("WARNING", "RL-PRC-007", "stream_nodata", `Luồng "${s.name}" chưa có tín hiệu.`);
    // ĐANG TỤT (RL-NET-004): worker báo đẩy chậm hơn thời gian thực kéo dài (slow) → nghi nghẽn băng
    // thông/CPU, người xem dễ giật/buffer. Chỉ khi CÒN tươi + đang phát.
    else if (fresh && s.status === "live" && s.slow) p("WARNING", "RL-NET-004", "stream_slow", `Luồng "${s.name}" đang TỤT tốc độ (đẩy chậm hơn thời gian thực${s.speed != null ? ` · ${s.speed}×` : ""}${s.bitrateKbps != null ? ` · ${Math.round(s.bitrateKbps / 100) / 10} Mbps` : ""}) — nghi nghẽn băng thông hoặc CPU, người xem có thể bị giật.`);
    // "Chớp tắt" đếm theo số lần restart DỒN trong ~15 phút gần đây (từ recentIncidents), KHÔNG dùng tổng
    // s.restarts cả phiên — tránh gộp nhầm mấy lần rớt CÁCH XA NHAU thành "đang chớp tắt" (Chủ Rise Group báo).
    const recentRestarts = Array.isArray(s.recentIncidents)
      ? s.recentIncidents.filter((ev: any) => String(ev?.kind ?? "restart") === "restart" && (nowMs - (Date.parse(String(ev?.at ?? "")) || 0)) < TH.restartWindowMs).length
      : 0;
    // Circuit breaker (worker RL-PRC-003) — 2 mức:
    //  • needsHuman = ĐÃ DỪNG HẲN do LỖI NGUỒN/FILE (không tự thử lại — thử vô ích) → cần người sửa nguồn.
    //  • restartHalted = TẠM NGỪNG do chớp tắt (lỗi mạng/VPS) → đang TỰ THỬ LẠI mỗi 5 phút tới khi hết sự cố.
    if (fresh && s.needsHuman)
      p("CRITICAL", "RL-PRC-003", "stream_needs_human", `Luồng "${s.name}" ĐÃ DỪNG${s.haltReason ? ` — ${s.haltReason}` : " (lỗi nguồn/file)"} — hệ thống KHÔNG tự bật lại (thử vô ích). ${s.mode === "live-pub" ? "Live Pub rớt là YouTube đóng buổi phát → tạo buổi phát MỚI nếu cần." : "Kiểm tra/tải lại video (thử nhãn NÉN) hoặc kiểm khoá luồng, rồi Bật lại tay."}`);
    else if (fresh && s.restartHalted)
      p("CRITICAL", "RL-PRC-003", "stream_restart_halted", `Luồng "${s.name}" chớp tắt (nghi lỗi mạng/VPS) → TẠM NGỪNG, đang TỰ THỬ LẠI mỗi 5 phút cho tới khi hết sự cố. Nếu kéo dài: kiểm tra mạng VPS + khoá luồng. Có thể Dừng/Bật lại tay nếu muốn.`);
    else if (fresh && s.status === "live" && recentRestarts >= TH.restartMinCount)
      p("WARNING", "RL-PRC-003", "stream_restart", `Luồng "${s.name}" đang chớp tắt (${recentRestarts} lần trong ~15 phút gần đây) — thường do video lệch độ phân giải hoặc mạng chập chờn. Ghi chú: cảnh báo TỰ MẤT khi luồng chạy ổn định trở lại, không cần thao tác gì.`);
    // MÀN ĐEN kéo dài (RL-MED-008): đang phát nhưng khung hình đen tuyền TRÊN 3 PHÚT (60s worker +
    // 120s máy chủ đếm qua blackSince). Bỏ qua "tối/đen chủ ý".
    if (fresh && s.black && !s.allowBlack && s.blackSince && (nowMs - (Date.parse(String(s.blackSince)) || nowMs)) >= TH.blackMinMs)
      p("WARNING", "RL-MED-008", "stream_black", `Luồng "${s.name}" MÀN ĐEN kéo dài (trên 3 phút) — kiểm tra video/nguồn. Nếu hình tối/đen CHỦ Ý (nhạc ngủ…), bấm nút "✓ Nền đen chủ ý" ngay ở cảnh báo này.`);
  }
  for (const a of assets) {
    if (a.status === "error") {
      // Copy hỏng vì KHÔNG với tới máy nguồn KHÔNG phải "nghiêm trọng": luồng gốc vẫn đang phát,
      // đây chỉ là bản sao chưa tạo được. Để mức CRITICAL thì 16 cái như hôm 29/08 che mất cảnh
      // báo thật. Hạ xuống WARNING + đổi sang câu người vận hành làm được.
      const copyHong = laXacCopyHong(a);
      const ly = a.error ? ": " + loiCopyDeHieu(a.error) : "";
      push(copyHong ? "WARNING" : "CRITICAL", "RL-MED-002", "asset_error", a.id, `Video "${a.name}" xử lý LỖI${ly}.`);
    }
  }
  // Sắp xếp: EMERGENCY → CRITICAL → WARNING → INFO; trong cùng mức, KÊNH ƯU TIÊN lên trước.
  const rank: Record<LiveAlertSeverity, number> = { EMERGENCY: 0, CRITICAL: 1, WARNING: 2, INFO: 3 };
  // ═══ RL-RES-007 — LUỒNG ƯU TIÊN ĐANG CHẠY MÀ CHƯA CÓ BẢN DỰ PHÒNG ═══
  // Vì sao cần (Chủ Rise Group duyệt 27/08/2026): hệ CHỈ chuyển máy được khi máy đích ĐÃ CÓ SẴN
  // video (điều kiện hasVideo). Nếu vì lý do nào đó không tạo được bản dự phòng — hết ổ, hết băng
  // thông, thiếu IP máy nguồn, hoặc người dùng lỡ xoá bản còn lại — thì trước đây hệ IM LẶNG.
  // Luồng vẫn chạy bình thường nên không ai biết là đang KHÔNG CÒN LƯỚI AN TOÀN; đến lúc máy chết
  // mới nhận thông báo "không có máy nào nhận" — nhưng lúc đó đã mất sóng rồi.
  // Cảnh báo này biến rủi ro ngầm thành thứ nhìn thấy được TRƯỚC khi sự cố xảy ra.
  try {
    const isPriority = (s: any) => {
      const imp = String(s.importance || (s.priority ? "priority" : "normal"));
      return (imp === "priority" || imp === "critical") && s.mode !== "live-pub";  // Pub không dùng dự phòng
    };
    const READY = ["ready", "pending", "downloading", "queued", "normalizing"];
    for (const s of streams) {
      if (!isPriority(s)) continue;
      const running = s.desiredState === "live" || s.scheduleActive;
      if (!running) continue;
      const ids: string[] = (Array.isArray(s.assetIds) && s.assetIds.length ? s.assetIds : (s.assetId ? [s.assetId] : [])).map(String);
      if (!ids.length) continue;
      const mine = String(s.machineId ?? "");
      // Máy KHÁC nào đang giữ đủ mọi video của luồng này? (khớp theo bản gốc hoặc theo link nguồn)
      const srcAssets = ids.map((id) => assets.find((a: any) => String(a.id) === id)).filter(Boolean) as any[];
      if (srcAssets.length < ids.length) continue;         // thiếu dữ liệu -> không kết luận (không đoán bừa)
      const others = Array.from(new Set(assets.map((a: any) => String(a.machineId)).filter((m: string) => m && m !== mine)));
      const covered = others.some((mid) => {
        const have = new Set<string>();
        assets.filter((x: any) => String(x.machineId) === mid && READY.includes(String(x.status))).forEach((x: any) => {
          if (x.copyFromAssetId) have.add("id:" + String(x.copyFromAssetId));
          const su = String(x.sourceUrl ?? "").trim(); if (su) have.add("url:" + su);
        });
        return srcAssets.every((a) => have.has("id:" + String(a.id)) || (String(a.sourceUrl ?? "").trim() !== "" && have.has("url:" + String(a.sourceUrl).trim())));
      });
      if (covered) continue;
      const nm = String(s.name ?? "").slice(0, 50);
      push("WARNING", "RL-RES-007", "no_backup_copy", String(s.id),
        `Luồng ưu tiên "${nm}" đang chạy nhưng CHƯA có bản dự phòng ở máy nào khác — nếu máy hiện tại gặp sự cố thì KHÔNG chuyển máy được. Thường do máy khác hết ổ/hết băng thông, hoặc bản dự phòng vừa bị xoá. Kiểm tra ổ trống các máy, hoặc sao chép tay sang một máy khác.`,
        true);
    }
  } catch {
    // Không chặn các cảnh báo khác nếu dữ liệu thiếu — thà bớt 1 cảnh báo còn hơn hỏng cả bảng.
  }

  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || (Number(b.priority) - Number(a.priority)));
}

// ── NHỊP MỘT LUỒNG: đang phát hay đang có vấn đề (31/08/2026) ────────────────────────────────
//
// Vì sao tách ra đây: cùng một câu hỏi "luồng này có ổn không" đang được hỏi ở HAI nơi —
//   · /api/my-work  (đưa sự cố luồng của tôi vào "việc cần xử lý" + ô Nhịp Rise Live)
//   · cron cảnh báo (tổng hợp nhịp theo ĐƠN VỊ để ô Tổng quan đọc 1 doc thay vì quét cả trăm luồng)
// Nếu mỗi nơi tự viết luật thì sớm muộn hai bên nói hai đằng: ô Tổng quan bảo "2 luồng lỗi" mà
// vào màn Live lại thấy 3. Nên luật nằm ĐÚNG MỘT CHỖ, cả hai cùng gọi.
//
// KHÔNG đọc/ghi gì, không phụ thuộc máy chủ — chỉ suy từ chính bản ghi luồng, đúng như trước.
export function nhipLuong(s: any, nowMs: number): { dangPhat: boolean; coVanDe: boolean } {
  const wantLive = s?.desiredState === "live" || (s?.control === "schedule" && s?.scheduleActive);
  const fresh = streamFresh(s, nowMs);
  const coVanDe = !!(
    s?.ytIssue                                                   // nghi bị chặn/đình chỉ trên YouTube
    || (wantLive && !fresh)                                      // muốn phát mà máy ngừng báo tín hiệu
    || (fresh && (s?.health === "error" || s?.status === "error") && !s?.restartHalted)
    || (fresh && s?.restartHalted)                               // chớp tắt liên tục → đã ngừng tự bật lại
    || (fresh && s?.black && !s?.allowBlack)                     // màn đen kéo dài
    || (fresh && wantLive && s?.health === "poor")               // sức khoẻ kém
  );
  const dangPhat = !!(fresh && wantLive && s?.status === "live" && !coVanDe);
  return { dangPhat, coVanDe };
}
