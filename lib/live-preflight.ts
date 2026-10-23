// LIVE RISE — KIỂM TRA TRƯỚC KHI LÊN SÓNG (preflight). THUẦN: nhận trạng thái → trả mức + lý do.
// Triết lý "chỉ siết ở điểm rủi ro thật": CHẶN cái chắc chắn hỏng, CẢNH BÁO cái đáng lưu ý, còn lại PASS.
export type PreflightLevel = "pass" | "warn" | "block";
export interface PreflightIssue { level: "block" | "warn"; text: string; }

export function preflightLive(o: {
  streamKey?: string;
  goingLiveNow?: boolean;      // true = lên sóng NGAY (mới kiểm máy online); lịch hẹn thì máy có thể lên sau
  machineOnline?: boolean;
  machineName?: string;
  assetStatus?: string;
  assetName?: string;
  hasBandwidth?: boolean;      // máy đã đo/nhập băng thông chưa (để biết còn gánh mấy luồng)
}): { level: PreflightLevel; issues: PreflightIssue[] } {
  const issues: PreflightIssue[] = [];
  // ── CHẶN: chắc chắn không phát được ──
  if (!String(o.streamKey ?? "").trim()) issues.push({ level: "block", text: "Chưa có khoá luồng YouTube." });
  if (o.assetStatus && o.assetStatus !== "ready") issues.push({ level: "block", text: `Video "${o.assetName ?? ""}" chưa sẵn sàng (đang tải/nén).` });
  if (o.goingLiveNow && o.machineOnline === false) issues.push({ level: "block", text: `Máy "${o.machineName ?? ""}" đang offline — chưa thể phát ngay.` });
  // ── CẢNH BÁO: vẫn cho lên, chỉ nhắc ──
  if (o.hasBandwidth === false) issues.push({ level: "warn", text: `Chưa đo/nhập băng thông máy "${o.machineName ?? ""}" — không kiểm được còn gánh mấy luồng.` });
  const level: PreflightLevel = issues.some((i) => i.level === "block") ? "block" : issues.some((i) => i.level === "warn") ? "warn" : "pass";
  return { level, issues };
}

/** Gộp lý do CHẶN thành 1 câu để báo lỗi. */
export function blockReasons(issues: PreflightIssue[]): string {
  return issues.filter((i) => i.level === "block").map((i) => i.text).join("\n• ");
}
