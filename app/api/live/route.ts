// RISE LIVE R1.2 — API TRUNG TÂM ĐIỀU KHIỂN (cho giao diện Admin/BLĐ). Quản Máy / Video / Luồng.
// Ghi 3 collection MỚI: liveMachines, liveAssets, liveStreams — KHÔNG đụng dữ liệu cũ.
// Sau cờ RISE_WORK_LIVE (mặc định TẮT → ẩn). Chặn xem-thử (viewingAs). CHỈ Admin/BLĐ.
// Worker trên VPS thao tác qua route riêng /api/live/agent (token), KHÔNG dùng route này.
import { NextResponse } from "next/server";
import { firestore } from "@/lib/firestore";
import { requireSession, isUnauthorized } from "@/lib/session";
import { logAudit } from "@/lib/audit";
import { notifyOutcome } from "@/lib/notify";
import { resolveLivePreset, YOUTUBE_RTMP_BASE, streamBandwidthMbps, DEFAULT_SAFETY_FACTOR, LIVE_QUALITY_PRESETS, isWithinSchedule, nextScheduleStartMs } from "@/lib/live-catalog";
import { computeLiveAlerts, machineOnline as isMachineOnline, streamFresh } from "@/lib/live-alerts";
import { preflightLive, blockReasons } from "@/lib/live-preflight";
import { getVisibleUserEmails, canAccessRecord } from "@/lib/access";
import { activeAssignment } from "@/lib/channel-assignments";
import { livePermissionsOf, packagesToPermissions, LIVE_PACKAGES, type LivePermission, type LivePackageId, type LiveScope } from "@/lib/live-permissions";
import { computeClusterCapacity } from "@/lib/live-capacity";
import { streamBackupStatus } from "@/lib/live-replica";
import { machineWorkerToken } from "@/lib/live-worker-auth";
import { moveTargetPreflight, checkMoveTarget, type MoveMode, MOVE_FEATURE_ON, MOVE_TIMEOUT_SEC, COPY_WAIT_SEC, isMoveActive, remapAssetIdsToTarget } from "@/lib/live-move";
import { kiemKhoaLuong, cheKhoaTrongCau } from "@/lib/live-stream-key";
import { assetLockOf, assetLockMap } from "@/lib/live-asset-lock";
import { thumbCacheSec, thumbPushSec as nhipDayAnh } from "@/lib/live-thumb-store";
import { POLL_SLOW_SEC, DASH_REFRESH_MS, DASH_IDLE_MS, WRITE_ON_CHANGE_REFRESH_SEC, writeOnChangeOn, readConsolidateOn } from "@/lib/live-cadence";
import { kiemLinkDrive } from "@/lib/live-drive-link";

export const dynamic = "force-dynamic";

// MÁY LÚC XẢY RA SỰ CỐ (30/08/2026) — KHÔNG phải máy hiện tại.
// Lỗi đã sửa: bản ghi sự cố lưu `machineId` = máy HIỆN TẠI của luồng tại lúc TẠO bản ghi, trong khi
// `startedAt` là lúc sự cố XẢY RA. Luồng nào chuyển máy giữa hai mốc đó thì toàn bộ lịch sử bị gán
// cho máy MỚI (Chủ Rise Group phát hiện: sự cố xảy ra ở VPS 03, chuyển sang VPS 05, nhật ký ghi
// VPS 05). Hệ quả nặng hơn con số: bộ lọc theo máy ĐẾM NHẦM, nhìn vào tưởng máy mới hay hỏng.
// Cách sửa: tra sổ chuyển máy — lần chuyển GẦN NHẤT xảy ra SAU mốc sự cố thì máy đúng là máy NGUỒN
// của lần chuyển đó. Không có lần chuyển nào sau đó → máy hiện tại chính là máy lúc xảy ra.
const mayLucXayRa = async (streamId: string, mayHienTai: string, mocISO: string): Promise<string> => {
  if (!streamId || !mocISO) return mayHienTai;
  const mv = await firestore.collection("liveMoveExecutions").where("streamId", "==", streamId).limit(50).get().catch(() => null);
  if (!mv) return mayHienTai;   // đọc lỗi → giữ nguyên như cũ, không đoán
  const sau = mv.docs.map((d) => d.data() as any)
    .filter((x) => String(x.startedAt ?? "") > mocISO && String(x.sourceMachineId ?? ""))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return sau.length ? String(sau[0].sourceMachineId) : mayHienTai;
};


const LIVE_ON = () => process.env.RISE_WORK_LIVE === "1";
// R1 Đợt 2 — phân quyền chi tiết (thêm-vào-trên gate cũ). Mặc định TẮT = giữ nguyên hành vi.
const PERMS2_ON = () => process.env.RISE_LIVE_PERMS2 === "1";
const M_COL = "liveMachines", A_COL = "liveAssets", S_COL = "liveStreams", PERM_COL = "livePermissions";


// ── GIÁ THUÊ MÁY + HẠN GIA HẠN (30/08/2026 — Chủ Rise Group yêu cầu) ────────────────────────
// Trước đây màn chi phí chỉ thấy MỘT NỬA: tiền đọc/ghi dữ liệu, không có tiền thuê máy. Nay nhập
// được đơn giá từng máy để ra TỔNG THẬT, và quan trọng hơn: có ngày hết hạn để NHẮC GIA HẠN.
// Quên gia hạn là mất sóng CẢ MÁY — đúng kiểu sự cố đã xảy ra. Bỏ trống thì không nhắc, không ép.
// Chu kỳ tháng/năm vì mỗi nhà cung cấp một kiểu; hệ tự quy về mỗi tháng khi cộng tổng.
function nhanGiaThue(body: any, up: any): void {
  if (body.costAmount != null) {
    const v = Number(body.costAmount);
    up.costAmount = Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  }
  if (typeof body.costPeriod === "string") {
    up.costPeriod = ["month", "year"].includes(body.costPeriod) ? body.costPeriod : "month";
  }
  if (typeof body.costRenewAt === "string") {
    const d = body.costRenewAt.trim();
    up.costRenewAt = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;   // bỏ trống / sai định dạng → không nhắc
  }
}

// CHẶN QUÁ TẢI BĂNG THÔNG khi lên sóng: thêm luồng mà vượt SỨC CHỨA AN TOÀN (dùng ~70% băng thông,
// chừa 30% dự phòng) → trả câu lỗi để CHẶN. Chỉ chặn khi: lên sóng NGAY + máy đã biết băng thông +
// chất lượng đo được (bỏ qua "giữ nguyên gốc" vì không ước lượng nổi). Không đủ dữ kiện → cho qua.
function capacityBlock(machine: any, preset: any, goingLiveNow: boolean): string | null {
  if (!goingLiveNow) return null;
  const up = Number(machine?.uploadMbps) || 0;
  const per = streamBandwidthMbps(preset) || 0;
  if (up <= 0 || per <= 0) return null;
  const usedMbps = machine?.txMbps != null ? Number(machine.txMbps) : (Number(machine?.liveCount) || 0) * per;
  const left = Math.floor((up * DEFAULT_SAFETY_FACTOR - usedMbps) / per);
  if (left > 0) return null;
  return `Máy "${machine?.name}" đã ĐẦY băng thông an toàn (~${up} Mbps, chừa 30% dự phòng) — thêm luồng nữa dễ giật CẢ máy. Hãy chọn máy khác, chọn chất lượng nhẹ hơn, hoặc dừng bớt luồng đang chạy.`;
}
// CHẶN NHẬN VIDEO MỚI khi máy đã đầy (Chủ Rise Group chốt 28/08/2026).
//
// Nguyên tắc bro chốt: "thiếu băng thông thì thừa ổ đĩa cũng giật" → chặn theo
// BĂNG THÔNG trước, rồi mới tới Ổ CỨNG.
//
// NGOẠI LỆ QUAN TRỌNG — bản SAO LƯU dự phòng KHÔNG bị chặn băng thông: sao lưu
// chỉ là CẤT GIỮ, không phát, nên không tiêu băng thông phát. Nhưng vẫn phải
// chặn theo ổ cứng (chép vào máy hết ổ thì chép hỏng, lại còn làm đầy ổ máy
// đang phát).
const DISK_MIN_GB = (): number => {
  const n = Number(process.env.RISE_LIVE_MIN_FREE_GB);
  return Number.isFinite(n) && n >= 5 ? Math.round(n) : 20;
};
function intakeBlock(machine: any, opts?: { laSaoLuu?: boolean }): string | null {
  if (!machine) return null;
  const ten = String(machine?.name ?? "máy");
  // 1) BĂNG THÔNG — bỏ qua với bản sao lưu.
  if (!opts?.laSaoLuu) {
    const up = Number(machine?.uploadMbps) || 0;
    const tx = Number(machine?.txMbps);
    if (up > 0 && Number.isFinite(tx) && tx <= up * 1.05) {   // >1.05 = trần ghi sai, không tin được
      const pct = tx / up;
      if (pct >= DEFAULT_SAFETY_FACTOR) {
        return `Máy "${ten}" đã chạm ngưỡng an toàn ${Math.round(DEFAULT_SAFETY_FACTOR * 100)}% băng thông (${Math.round(tx)}/${Math.round(up)} Mbps ~ ${Math.round(pct * 100)}%) — không nhận thêm video mới. Hãy chọn máy khác còn trống. (Bản sao lưu dự phòng thì vẫn nhận được vì chỉ cất giữ, không phát.)`;
      }
    }
  }
  // 2) Ổ CỨNG — áp cho MỌI đường, kể cả sao lưu.
  const free = Number(machine?.diskFreeGb);
  if (Number.isFinite(free) && free < DISK_MIN_GB()) {
    return `Máy "${ten}" chỉ còn ${Math.round(free)} GB trống (tối thiểu ${DISK_MIN_GB()} GB) — không nhận thêm video. Hãy xoá bớt video không dùng hoặc chọn máy khác.`;
  }
  return null;
}

const PKG_IDS: LivePackageId[] = ["view", "operate", "scope", "tech", "admin"];
const SCOPE_IDS: LiveScope[] = ["self", "assigned_channels", "unit", "descendant_units", "company", "explicit_channels"];

// Quyền live.* THỰC TẾ của user: ưu tiên bản ghi gói TƯỜNG MINH (còn hiệu lực) → nếu chưa có thì
// ánh xạ tạm từ quyền cũ (tương thích ngược). Chỉ đọc khi PERMS2 bật (khỏi tốn read khi tắt).
async function resolveLivePermsFor(user: any): Promise<Set<LivePermission>> {
  const email = String(user?.email ?? "").toLowerCase();
  if (email) {
    const snap = await firestore.collection(PERM_COL).doc(email).get().catch(() => null);
    if (snap?.exists) {
      const d: any = snap.data(); const now = Date.now();
      const okFrom = !d.effectiveFrom || Date.parse(d.effectiveFrom) <= now;
      const okTo = !d.effectiveTo || Date.parse(d.effectiveTo) >= now;
      if (okFrom && okTo && Array.isArray(d.packages)) return packagesToPermissions(d.packages);
    }
  }
  return livePermissionsOf(user);
}

// Hành động POST → quyền live.* tương ứng (để kiểm khi bật PERMS2). null = không ràng buộc thêm.
function livePermForAction(action: string, body: any): LivePermission | null {
  switch (action) {
    case "add_machine": case "update_machine": case "delete_machine": return "live.worker.manage";
    case "set_failover_off": return "live.worker.manage";   // nut tat khan tu cuu — chi Admin ha tang
    case "add_asset": return "live.media.upload";
    case "create_stream": return "live.stream.create";
    case "edit_stream": return "live.stream.edit";
    case "set_stream": return body?.desired === "live" ? "live.stream.start" : "live.stream.stop";
    case "rename_stream": return "live.stream.edit";
    case "set_watch_url": return "live.stream.edit";
    case "get_stream_key": return "live.stream.edit";
    case "rename_asset": return "live.media.upload";
    case "delete_asset": return "live.media.delete";
    case "delete_stream": return "live.stream.stop";
    default: return null;
  }
}

function isBLD(user: any) {
  return user.role === "admin" || (Array.isArray(user.permissions) && user.permissions.includes("admin"));
}
// Người VẬN HÀNH live = BLĐ HOẶC được cấp quyền "riseLive". Vận hành = luồng/video;
// HẠ TẦNG (máy/khoá) vẫn CHỈ Admin/BLĐ (dùng isBLD riêng).
function canOperateLive(user: any) {
  return isBLD(user) || (Array.isArray(user.permissions) && user.permissions.includes("riseLive"));
}
// VÀO được Live Rise không: admin/riseLive (như cũ) HOẶC được GÁN TAY 1 gói quyền tường minh còn hiệu
// lực. Đường gán tay CHỈ mở khi PERMS2 bật — để lớp kiểm quyền theo hành động (livePermForAction) enforce
// đúng thứ họ được làm; nếu PERMS2 tắt thì giữ nguyên cổng cũ (không ai vào thêm). THUẦN CỘNG THÊM:
// admin/riseLive short-circuit (khỏi đọc DB), không ai đang vào được bị mất.
async function canEnterLive(user: any): Promise<boolean> {
  if (canOperateLive(user)) return true;
  if (!PERMS2_ON()) return false;
  const perms = await resolveLivePermsFor(user);   // rỗng nếu không có bản ghi gán tay
  return perms.size > 0;
}
// Được ỦY QUYỀN cấp quyền Live Rise (Bước 2): Admin/BLĐ (mọi gói, mọi người) HOẶC Trưởng nhóm/phòng
// (chỉ gói Vận hành/Quản lý phạm vi, chỉ người TRONG phạm vi mình). Phó nhóm/nhân viên KHÔNG cấp.
function canDelegateLive(user: any) {
  return isBLD(user) || user.role === "lead" || user.role === "head";
}
// Bước 3 — cấp gói ở Phân quyền là TỰ bật quyền vào (riseLive) để hiện menu (gộp 1 chỗ). Lưu trong
// extraPermissions (nơi Admin cũng tích). Trả true nếu THỰC SỰ thêm (để ungrant chỉ gỡ cái grant đã thêm,
// không đụng riseLive do Admin tự tích).
async function setUserRiseLive(email: string, on: boolean): Promise<boolean> {
  const uref = firestore.collection("users").doc(email);
  const ud = await uref.get().catch(() => null);
  if (!ud?.exists) return false;
  const extra: string[] = Array.isArray((ud.data() as any).extraPermissions) ? (ud.data() as any).extraPermissions : [];
  const has = extra.includes("riseLive");
  if (on && !has) { await uref.update({ extraPermissions: [...extra, "riseLive"] }).catch(() => {}); return true; }
  if (!on && has) { await uref.update({ extraPermissions: extra.filter((p) => p !== "riseLive") }).catch(() => {}); return true; }
  return false;
}
const nowISO = () => new Date().toISOString();
// Che stream key trước khi trả về giao diện (chỉ hiện đuôi) — không lộ toàn bộ ra client.
const maskKey = (k: string) => { const s = String(k ?? ""); return s.length > 4 ? "•••• " + s.slice(-4) : (s ? "••••" : ""); };

export async function GET() {
  try {
    const user = await requireSession();
    if (!(await canEnterLive(user))) return NextResponse.json({ error: "Bạn không có quyền vào Live Rise." }, { status: 403 });
    if (!LIVE_ON()) return NextResponse.json({ enabled: false });

    const [mSnap, aSnap, sSnap] = await Promise.all([
      firestore.collection(M_COL).limit(200).get().catch(() => null),
      firestore.collection(A_COL).limit(1000).get().catch(() => null),
      firestore.collection(S_COL).limit(2000).get().catch(() => null),
    ]);
    const nowMs = Date.now();
    const machines = (mSnap?.docs ?? []).map((d) => { const m: any = { id: d.id, ...(d.data() as any) }; m.online = isMachineOnline(m, nowMs) && m.forceOffline !== true; return m; });
    const allAssets = (aSnap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) }))
      .sort((a: any, b: any) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));   // mới nhất lên đầu
    const allStreams = (sSnap?.docs ?? []).map((d) => {
      const s: any = { id: d.id, ...(d.data() as any) };
      s.streamKeyMasked = maskKey(s.streamKey); delete s.streamKey;
      // CHE NOT du lieu CU: cau "ly do dung"/"loi" da lo luu kem khoa luong truoc khi va
      // (29/08/2026) van con trong kho. Che o day de khong hien ra man hinh du chua ghi de.
      if (s.haltReason) s.haltReason = cheKhoaTrongCau(s.haltReason);
      if (s.error) s.error = cheKhoaTrongCau(s.error);
      if (s.control === "schedule" && s.schedule) {
        s.scheduleActive = isWithinSchedule(s.schedule, nowMs);
        const nx = nextScheduleStartMs(s.schedule, nowMs);
        s.nextStartISO = nx != null ? new Date(nx).toISOString() : null;
      }
      return s;
    }).sort((a: any, b: any) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));   // mới tạo lên đầu

    // Sức chứa/máy = tính trên TOÀN BỘ luồng (băng thông dùng chung) — mọi người xem để set.
    machines.forEach((m: any) => {
      // Đang chạy = luồng ĐANG phát trên máy: bật tay (desiredState live) HOẶC hẹn giờ đang trong
      // khung giờ. Trước đây bỏ sót luồng hẹn giờ đang phát → lệch với "Đang phát" ở Tổng quan.
      m.liveCount = allStreams.filter((s: any) => s.machineId === m.id && (s.desiredState === "live" || (s.control === "schedule" && s.scheduleActive))).length;
    });

    // ── PHẠM VI XEM: Admin/BLĐ → tất cả; Trưởng nhóm → đội mình; nhân viên → của mình.
    //    (Tái dùng getVisibleUserEmails — cùng cơ chế Báo cáo/Đánh giá.) Máy vẫn xem chung.
    const visible = await getVisibleUserEmails(user);
    const vis = visible ? new Set(Array.from(visible).map((e) => String(e).toLowerCase())) : null;
    const inScope = (x: any) => !vis || vis.has(String(x.createdBy ?? "").toLowerCase());
    const streams = allStreams.filter(inScope);
    // VIDEO HỆ THỐNG TỰ TẠO (dự phòng auto-backup, createdBy="system") phải hiện với
    // MỌI người có quyền vào Live — Chủ Rise chốt 28/08/2026. Trước đây bị lọc theo
    // phạm vi đơn vị nên Trưởng nhóm KHÔNG thấy bản dự phòng của chính luồng đội mình:
    // thẻ luồng báo xanh "có dự phòng" (tính trên toàn bộ) nhưng danh sách video không
    // có, và khối cảnh báo (tính trên danh sách ĐÃ LỌC) nổ hàng loạt "chưa có dự phòng"
    // GIẢ — 26 cảnh báo ảo ở màn Trưởng nhóm trong khi màn Admin im lặng.
    const laVideoHeThong = (x: any) =>
      String(x.createdBy ?? "").toLowerCase() === "system" || String(x.source ?? "") === "auto-backup";
    // NHƯNG cho MỌI NGƯỜI thấy MỌI bản dự phòng thì thành lộ: ai cũng nhìn thấy video dự phòng của
    // người khác, đội khác (Chủ Rise Group phát hiện 29/08/2026).
    // Cách đúng cho CẢ HAI: bản dự phòng do hệ tạo KHÔNG có chủ riêng — chủ THẬT của nó là chủ của
    // VIDEO GỐC mà nó sao lại. Nên soi theo chủ gốc:
    //   · Trưởng nhóm vẫn thấy bản dự phòng của video ĐỘI MÌNH  -> hết 26 cảnh báo ảo (lý do của bản 28/08)
    //   · Nhưng KHÔNG còn thấy bản dự phòng của đội khác        -> hết lộ
    const chuGocCuaBanDuPhong = (x: any): string => {
      const goc = x.copyFromAssetId ? allAssets.find((g: any) => String(g.id) === String(x.copyFromAssetId)) : null;
      if (goc) return String(goc.createdBy ?? "").toLowerCase();
      // Không có mã gốc thì dò theo cùng nguồn video (bỏ qua chính nó và các bản hệ tạo khác).
      const su = String(x.sourceUrl ?? "").trim();
      if (!su) return "";
      const g2 = allAssets.find((g: any) => String(g.id) !== String(x.id)
        && String(g.sourceUrl ?? "").trim() === su && !laVideoHeThong(g));
      return g2 ? String(g2.createdBy ?? "").toLowerCase() : "";
    };
    const assets = allAssets.filter((x: any) => {
      if (inScope(x)) return true;
      if (!laVideoHeThong(x)) return false;
      if (!vis) return true;                                   // Admin/BLĐ: thấy toàn công ty như cũ
      const chu = chuGocCuaBanDuPhong(x);
      // KHÔNG tra được chủ gốc -> KHÔNG cho xem (thà thiếu còn hơn lộ nhầm sang đội khác).
      return chu !== "" && vis.has(chu);
    });
    // Dự phòng THỰC TẾ từng luồng (Đợt 2 nhịp 1, CHỈ ĐỌC): video đã có sẵn trên máy khác chưa.
    // Dùng TOÀN BỘ asset + máy (không theo phạm vi) để nhận biết đủ. Worker KHÔNG liên quan.
    const machineById: Record<string, any> = {}; machines.forEach((m: any) => { machineById[m.id] = m; });
    streams.forEach((s: any) => { s.backup = streamBackupStatus(s, allAssets as any, machineById); });
    // Đánh dấu video đang phục vụ luồng ưu tiên -> giao diện hiện ổ khoá + tắt nút Xoá.
    { const lockMap = assetLockMap(allStreams as any, allAssets as any);
      assets.forEach((a: any) => { const lk = lockMap[String(a.id)]; if (lk) { a.locked = true; a.lockReason = lk.reason; } }); }
    const scopeLabel = !vis ? "toàn công ty" : (user.dataScope === "self" ? "của tôi" : "đội của tôi");

    // ── TỔNG QUAN (KPI) ──
    const overview = {
      streamsLive: streams.filter((s: any) => s.status === "live").length,
      // "Được đặt phát" = bật tay (desiredState live) HOẶC hẹn giờ đang trong khung giờ → khỏi lệch 7/6.
      streamsDesiredLive: streams.filter((s: any) => s.desiredState === "live" || (s.control === "schedule" && s.scheduleActive)).length,
      streamsQueued: streams.filter((s: any) => s.status === "queued" || s.status === "starting").length,
      streamsError: streams.filter((s: any) => (s.status === "error" || s.health === "error") && streamFresh(s, nowMs)).length,
      machinesOnline: machines.filter((m: any) => m.online).length,
      machinesTotal: machines.length,
      assetsReady: assets.filter((a: any) => a.status === "ready").length,
      assetsProcessing: assets.filter((a: any) => ["pending", "downloading", "queued", "normalizing"].includes(a.status)).length,
      assetsError: assets.filter((a: any) => a.status === "error").length,
    };

    // ── SỨC CHỨA CỤM & N+1 (ĐỢT 1, CHỈ ĐỌC) — tính trên TOÀN BỘ luồng (băng thông dùng chung),
    //    không theo phạm vi xem. Dùng cho bảng "mất 1 máy cụm có gánh nổi không". Không ghi gì.
    const presetMbps: Record<string, number> = {};
    LIVE_QUALITY_PRESETS.forEach((p) => { presetMbps[p.id] = streamBandwidthMbps(p); });
    const clusterCapacity = computeClusterCapacity(machines as any, allStreams as any, presetMbps);

    // ── CẢNH BÁO (suy ra từ trạng thái) — dùng lib chung (cùng logic với email cảnh báo) ──
    const alerts = computeLiveAlerts(machines, streams, assets, nowMs);
    (overview as any).alertsCritical = alerts.filter((x) => x.level === "critical").length;
    (overview as any).alertsWarn = alerts.filter((x) => x.level === "warn").length;

    // HẠ TẦNG (máy): Admin/BLĐ luôn được; NGOÀI RA người được cấp GÓI "Kỹ thuật" (live.worker.manage) cũng
    // quản được máy — cho kỹ thuật viên ngoài BLĐ. canGrant (gán quyền) hiện vẫn chỉ Admin/BLĐ (Bước 2 mở QL).
    const uLivePerms = isBLD(user) ? null : await resolveLivePermsFor(user);
    const canInfra = isBLD(user) || !!uLivePerms?.has("live.worker.manage");
    // Trang thai NUT TAT KHAN co che tu cuu — chi doc khi la Admin ha tang (khoi ton luot doc).
    let failoverOff: any = null;
    if (canInfra) {
      const fd = await firestore.collection("liveSettings").doc("failover").get().catch(() => null);
      const fv: any = fd?.exists ? fd.data() : null;
      failoverOff = { disabled: fv?.disabled === true, by: fv?.disabledBy ?? null, at: fv?.disabledAt ?? null, reason: fv?.reason ?? "" };
    }
    // Vé xác thực RIÊNG từng máy — chỉ gửi cho người quản hạ tầng (để dán vào khối "Cài worker").
    if (canInfra) machines.forEach((m: any) => { m.installToken = machineWorkerToken(m.id); });
    // LỊCH SỬ CHUYỂN MÁY + NHẬT KÝ SỰ CỐ: KHÔNG đọc ở đây nữa (V64.90). Trước đây gửi kèm MỌI nhịp
    // /api/live (route bị gọi rất nhiều) → đọc thừa hàng trăm bản ghi mỗi lần, góp phần làm CHẬM app.
    // Nay có đường riêng /api/live/logs — chỉ tải khi người dùng MỞ tab "Nhật ký", có phân trang + lọc.
    const moveHistory: any[] = [];
    const canGrant = canDelegateLive(user);   // Admin (mọi gói) + Trưởng nhóm/phòng (operate/scope, trong đội)

    // NHẬT KÝ SỰ CỐ CỐ ĐỊNH (liveIncidentLog): xem ở /api/live/logs (tab "Nhật ký"), không đọc ở nhịp này.
    const incidentLog: any[] = [];

    return NextResponse.json({
      // NHỊP THẬT CỦA HỆ — gửi kèm để chỗ hiển thị chi phí KHÔNG PHẢI CHÉP LẠI con số.
      // Chủ Rise Group hỏi "các nhịp đọc ghi ở đó có đúng thực tế không?" → đo ra là SAI: chỗ đó ghi
      // đẩy ảnh 45 giây (thực tế 300) và màn hình 12 giây (thực tế 20). Vì nó chép cứng nên hệ đổi
      // mà nó không đổi theo. Nay đọc từ một nguồn (lib/live-cadence.ts + lib/live-thumb-store.ts).
      cadence: {
        pollSec: POLL_SLOW_SEC, thumbPushSec: nhipDayAnh(), dashMs: DASH_REFRESH_MS, dashIdleMs: DASH_IDLE_MS,
        writeOnChange: writeOnChangeOn(), readConsolidate: readConsolidateOn(), wocRefreshSec: WRITE_ON_CHANGE_REFRESH_SEC,
      },
      enabled: true, isBLD: isBLD(user), canInfra, canGrant, safetyFactor: DEFAULT_SAFETY_FACTOR, scopeLabel, incidentLog,
      // Nhịp làm mới ảnh xem trước — giao diện BÁM THEO số này thay vì gõ cứng (xem lib/live-thumb-store.ts).
      thumbCacheSec: thumbCacheSec(),
      failoverOff,   // nut tat khan co che tu cuu (chi Admin ha tang thay/doi duoc)
      // Công cụ TẢI THẲNG TỪ MÁY: hiện cho MỌI người được cấp quyền vận hành (tự tải + tự cấu hình
      // + nén video ở máy mình).
      uploadEnabled: !!process.env.RISE_LIVE_UPLOAD_TOKEN,
      userEmail: user.email,   // để nút tải web gán đúng người tải
      // BẢO MẬT (S0): KHÔNG trả token tải-lên trong payload polling nữa (trước đây token hạ tầng dùng
      // chung bị phát mỗi 12s + in sẵn trên màn hình mọi người vận hành). Chỉ còn port/httpsUrl (không
      // bí mật). Token lấy RIÊNG qua action "upload_token" (khi thật sự tải / khi admin xem lệnh cài),
      // có ghi audit. Kéo-thả tải video vẫn chạy: client tự xin token đúng lúc cần.
      uploadConfig: canOperateLive(user) && process.env.RISE_LIVE_UPLOAD_TOKEN ? {
        port: Number(process.env.RISE_LIVE_UPLOAD_PORT) || 8099,
        httpsUrl: (process.env.RISE_LIVE_UPLOAD_HTTPS_URL || "").replace(/\/+$/, "") || null,
      } : null,
      // Đích tải-thẳng-từ-máy-tính theo TỪNG MÁY (máy nào đã gắn địa chỉ nhận file HTTPS riêng) → cho
      // chọn VPS khi kéo-thả (không còn cứng vào 1 máy). Token vẫn dùng chung từ uploadConfig.
      uploadTargets: (canOperateLive(user) && process.env.RISE_LIVE_UPLOAD_TOKEN)
        ? machines.filter((m: any) => typeof m.uploadHttpsUrl === "string" && /^https:\/\//.test(m.uploadHttpsUrl))
            // Kem BANG THONG + O CUNG de giao dien chan NGAY truoc khi tai, khong
            // de nguoi dung tai xong ca file lon roi may chu moi bao "may day".
            .map((m: any) => ({ id: m.id, name: m.name, httpsUrl: String(m.uploadHttpsUrl).replace(/\/+$/, ""),
              uploadMbps: Number(m.uploadMbps) || 0, txMbps: m.txMbps ?? null, diskFreeGb: m.diskFreeGb ?? null }))
        : [],
      presets: LIVE_QUALITY_PRESETS.map((p) => ({ id: p.id, label: p.label, ytTier: p.ytTier, bandwidthMbps: streamBandwidthMbps(p), note: p.note, keepOriginal: !!p.keepOriginal, height: p.height })),
      rtmpBase: YOUTUBE_RTMP_BASE, machines, assets, streams, overview, alerts, clusterCapacity,
      moveEnabled: MOVE_FEATURE_ON(),   // Đợt 3: có bật chuyển máy thật chưa (sau cờ RISE_LIVE_MOVE)
      moveHistory,                      // lịch sử chuyển máy (canInfra)
    });
  } catch (error: any) {
    if (isUnauthorized(error)) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
    console.error("GET /api/live failed", error);
    return NextResponse.json({ error: error?.message ?? "Lỗi máy chủ." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireSession();
    if (!(await canEnterLive(user))) return NextResponse.json({ error: "Bạn không có quyền thao tác Live Rise." }, { status: 403 });
    if (user.viewingAs) return NextResponse.json({ error: "Chế độ xem thử không được thao tác." }, { status: 403 });
    if (!LIVE_ON()) return NextResponse.json({ error: "Tính năng Live Rise đang tắt." }, { status: 400 });

    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? "");
    // Hạ tầng (máy): Admin/BLĐ luôn được. NGOÀI RA cho người được cấp GÓI "Kỹ thuật" (live.worker.manage)
    // khi PERMS2 bật — kỹ thuật viên lo VPS không nhất thiết là BLĐ. (PERMS2 tắt → chỉ Admin/BLĐ.)
    // `clean_orphan_assets` cũng nằm trong nhóm HẠ TẦNG: nó dọn hậu quả của việc xoá máy, và xoá
    // bản ghi hàng loạt — không phải việc của người vận hành thường.
    if (["add_machine", "update_machine", "delete_machine", "set_machine_offline", "clean_orphan_assets"].includes(action) && !isBLD(user)) {
      const okTech = PERMS2_ON() && (await resolveLivePermsFor(user)).has("live.worker.manage");
      if (!okTech) return NextResponse.json({ error: "Chỉ Admin/Ban lãnh đạo hoặc người được cấp gói Kỹ thuật mới quản lý máy live." }, { status: 403 });
    }
    // R1 Đợt 2 — PHÂN QUYỀN CHI TIẾT (sau flag, thêm-vào-trên gate cũ; ánh xạ tương thích ngược nên
    // người có riseLive/admin KHÔNG mất quyền). Chỉ áp khi PERMS2 bật.
    if (PERMS2_ON()) {
      const need = livePermForAction(action, body);
      if (need) {
        const uPerms = await resolveLivePermsFor(user);
        if (!uPerms.has(need)) return NextResponse.json({ error: "Bạn chưa được cấp quyền cho thao tác này trong Live Rise." }, { status: 403 });
      }
    }
    // PHẠM VI: nhân viên/Trưởng nhóm chỉ thao tác được luồng/video TRONG phạm vi mình (do mình
    // hoặc đội mình tạo). Admin/BLĐ (company) làm tất. Tính 1 lần khi cần (lazy).
    let scopeSet: Set<string> | null | undefined = undefined;
    const ownsEntity = async (createdBy: any): Promise<boolean> => {
      if (isBLD(user)) return true;
      if (scopeSet === undefined) { const v = await getVisibleUserEmails(user); scopeSet = v ? new Set(Array.from(v).map((e) => String(e).toLowerCase())) : null; }
      if (scopeSet === null) return true;
      return scopeSet.has(String(createdBy ?? "").toLowerCase());
    };

    // Gắn luồng vào KÊNH có sẵn của Rise Work (khóa ổn định = doc.id). Kiểm tra tồn tại + chưa
    // archived + TRONG PHẠM VI xem của người dùng → trả {id,name,url}. Trả null nếu không hợp lệ.
    const resolveChannelInScope = async (channelId: string): Promise<{ id: string; name: string; url: string } | null> => {
      const cid = String(channelId ?? "").trim(); if (!cid) return null;
      const cDoc = await firestore.collection("channels").doc(cid).get();
      if (!cDoc.exists) return null;
      const raw: any = { id: cDoc.id, ...(cDoc.data() as any) };
      if (raw.status === "archived") return null;
      const act = activeAssignment(raw);
      const rec = act ? { ...raw, ownerEmail: act.ownerEmail, unit: act.unit, assignedEmails: [act.ownerEmail] } : raw;
      const visForCh = await getVisibleUserEmails(user);
      if (!(user.role === "admin" || canAccessRecord(user, rec, visForCh ?? undefined))) return null;
      return { id: raw.id, name: String(raw.name ?? "Kênh"), url: String(raw.url ?? "") };
    };

    // DANH SÁCH PHÁT: 1 video (assetId) hoặc nhiều video (assetIds). Kiểm tra tất cả tồn tại + sẵn sàng.
    // Trả video ĐẦU (để lấy preset + hiển thị), danh sách id, kiểu phát, và cờ cảnh báo nếu trộn nhiều mức.
    const resolvePlaylist = async (body: any): Promise<{ ok: true; assetIds: string[]; firstAsset: any; presetId: string; playMode: string; mixWarn: boolean } | { ok: false; error: string }> => {
      const ids = (Array.isArray(body.assetIds) ? body.assetIds : (body.assetId ? [body.assetId] : [])).map((x: any) => String(x)).filter(Boolean);
      const uniq = Array.from(new Set(ids)) as string[];
      if (!uniq.length) return { ok: false, error: "Chưa chọn video." };
      const docs = await Promise.all(uniq.map((id) => firestore.collection(A_COL).doc(id).get().catch(() => null)));
      const assets: any[] = [];
      for (let i = 0; i < uniq.length; i++) {
        const d = docs[i]; if (!d?.exists) return { ok: false, error: "Có video không tồn tại." };
        const a: any = d.data(); if (a.status !== "ready") return { ok: false, error: `Video "${a.name ?? ""}" chưa sẵn sàng (chưa nén xong).` };
        assets.push(a);
      }
      const presets = new Set(assets.map((a) => String(a.presetId ?? "")));
      const playMode = body.playMode === "random" ? "random" : "sequence";
      return { ok: true, assetIds: uniq, firstAsset: assets[0], presetId: String(assets[0].presetId ?? ""), playMode, mixWarn: uniq.length > 1 && presets.size > 1 };
    };

    // Lịch phát chồng nhau (theo giờ trong ngày). 24/7 liên tục (durationMin=0) chiếm cả ngày → chồng mọi lịch.
    const schedulesOverlap = (a: any, b: any): boolean => {
      if (!a || !b) return false;
      if ((Number(a.durationMin) || 0) === 0 || (Number(b.durationMin) || 0) === 0) return true;
      const mins = (s: string) => { const d = new Date(String(s)); return Number.isFinite(d.getTime()) ? d.getHours() * 60 + d.getMinutes() : null; };
      const as = mins(a.start), bs = mins(b.start);
      if (as == null || bs == null) return false;   // không chắc → KHÔNG chặn (tránh chặn oan)
      const ae = as + (Number(a.durationMin) || 0), be = bs + (Number(b.durationMin) || 0);
      return as < be && bs < ae;
    };
    // Chặn xung đột đích phát: trùng KHOÁ (RL-SET-002) · cùng KÊNH cùng lúc (RL-SET-008) · lịch chồng (RL-SCH-001).
    const streamConflict = async (streamKey: string, channelId: string | null, control: string, schedule: any, liveNow: boolean, excludeId: string | null): Promise<string | null> => {
      const nowMs = Date.now();
      const keySnap = await firestore.collection(S_COL).where("streamKey", "==", streamKey).get().catch(() => null);
      // CHỈ TRÙNG KHOÁ LUỒNG mới chặn (xung đột THẬT: 2 luồng cùng khoá thì YouTube không nhận).
      // Khác khoá → cho phát THOẢI MÁI, kể cả 2 luồng vào 1 kênh (YouTube 1 kênh phát được nhiều
      // buổi live cùng lúc, mỗi buổi 1 khoá + 1 link riêng). Đã BỎ luật chặn theo KÊNH cũ.
      for (const d of keySnap?.docs ?? []) {
        if (d.id === excludeId) continue; const o: any = d.data();
        if (o.desiredState === "live" || (o.control === "schedule" && isWithinSchedule(o.schedule, nowMs)))
          return `Khoá luồng này ĐANG được luồng "${o.name}" dùng (RL-SET-002). Đổi khoá hoặc dừng luồng kia trước.`;
        // Cùng KHOÁ + 2 lịch CHỒNG giờ (tương lai) → cũng chặn (cùng khoá không phát 2 buổi 1 lúc).
        if (control === "schedule" && o.control === "schedule" && schedulesOverlap(schedule, o.schedule))
          return `Khoá luồng này trùng luồng "${o.name}" và 2 LỊCH chồng giờ (RL-SET-002). Đổi khoá hoặc chỉnh giờ.`;
      }
      return null;
    };

    // ── Danh sách KÊNH trong phạm vi (cho ô "Chọn kênh" khi tạo/sửa luồng) — gọi 1 lần khi mở
    //    form, KHÔNG nằm trong GET bị poll → đỡ chi phí đọc. Đã lọc archived + phạm vi xem.
    if (action === "list_channels") {
      const snap = await firestore.collection("channels").limit(1000).get().catch(() => null);
      const visForCh = await getVisibleUserEmails(user);
      const scoped = (snap?.docs ?? [])
        .map((d) => { const raw: any = { id: d.id, ...(d.data() as any) }; const act = activeAssignment(raw); return act ? { ...raw, ownerEmail: act.ownerEmail, owner: act.owner, unit: act.unit, assignedEmails: [act.ownerEmail] } : raw; })
        .filter((c: any) => c.status !== "archived")
        .filter((c: any) => user.role === "admin" || canAccessRecord(user, c, visForCh ?? undefined));
      // L3: LINK VIDEO LIVE THẬT của kênh (nếu kênh đã kết nối YouTube + đang live) — để "gắn kênh"
      // tự điền ĐÚNG link buổi phát, KHÔNG dùng link @handle của kênh (L3 không đọc được từ đó).
      const connSnap = await firestore.collection("liveYoutubeConnections").limit(2000).get().catch(() => null);   // R1.3: trần an toàn (số kết nối ~ số kênh, vài trăm)
      const liveUrlByCh: Record<string, string> = {};
      (connSnap?.docs ?? []).forEach((d) => { const cc: any = d.data(); const ys = cc.youtubeState; if (cc.riseChannelId && ys?.broadcastStatus === "live" && ys?.watchUrl) liveUrlByCh[String(cc.riseChannelId)] = String(ys.watchUrl); });
      const channels = scoped
        .map((c: any) => ({ id: c.id, name: String(c.name ?? "Kênh"), unit: String(c.unit ?? ""), owner: String(c.owner ?? ""), url: String(c.url ?? ""), liveUrl: liveUrlByCh[c.id] ?? "" }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name, "vi"));
      return NextResponse.json({ ok: true, channels });
    }

    // ── Thêm MÁY (đăng ký VPS thủ công; worker sẽ cập nhật specs/heartbeat sau) ──
    if (action === "add_machine") {
      const name = String(body.name ?? "").trim(), ip = String(body.ip ?? "").trim();
      const role = ["stream-247", "live-pub", "shared"].includes(body.role) ? body.role : "stream-247";
      if (!name || !ip) return NextResponse.json({ error: "Thiếu tên hoặc IP máy." }, { status: 400 });
      // Dự phòng nhiều VPS (Đợt 1): nhà cung cấp / khu vực / vùng lỗi — để sau chọn máy cứu KHÁC
      // điểm chết. failureDomain trống → mặc định theo nhà cung cấp (cùng NCC ~ cùng điểm chết).
      const provider = String(body.provider ?? "").trim().slice(0, 60);
      const region = String(body.region ?? "").trim().slice(0, 60);
      const failureDomain = (String(body.failureDomain ?? "").trim() || provider || region).slice(0, 60);
      // Địa chỉ nhận file HTTPS RIÊNG của máy (để tải-thẳng-từ-máy-tính chọn được VPS này). Chỉ nhận https://.
      const uploadHttpsUrl = String(body.uploadHttpsUrl ?? "").trim().replace(/\/+$/, "");
      const gia: any = {}; nhanGiaThue(body, gia);   // giá thuê + hạn gia hạn (bỏ trống được)
      const ref = await firestore.collection(M_COL).add({
        name, ip, role, uploadMbps: Number(body.uploadMbps) || 0,
        provider, region, failureDomain, ...gia,
        ...(uploadHttpsUrl && /^https:\/\//.test(uploadHttpsUrl) ? { uploadHttpsUrl } : {}),
        vcpu: Number(body.vcpu) || 0, ramGb: Number(body.ramGb) || 0, diskGb: Number(body.diskGb) || 0,
        status: "registered", createdAt: nowISO(), createdBy: user.email,
      });
      await logAudit(firestore, { action: "live_add_machine", entityType: "liveMachine", entityId: ref.id, performedBy: user.email, detail: `${name} (${ip})` });
      return NextResponse.json({ ok: true, id: ref.id });
    }

    // ── NGẮT MÁY (giả lập sự cố / bảo trì khẩn) — coi máy như CHẾT: worker tự dừng luồng + auto-failover
    //    cứu luồng ưu tiên sang máy khác. KHÔNG cần SSH. "Bật lại" để đưa máy trở lại vận hành.
    if (action === "set_machine_offline") {
      const id = String(body.id ?? ""); if (!id) return NextResponse.json({ error: "Thiếu id máy." }, { status: 400 });
      const off = body.offline === true;
      await firestore.collection(M_COL).doc(id).set({ forceOffline: off, updatedAt: nowISO() }, { merge: true });
      await logAudit(firestore, { action: "live_set_machine_offline", entityType: "liveMachine", entityId: id, performedBy: user.email, detail: off ? "NGẮT máy (giả lập sự cố)" : "Bật lại máy" });
      return NextResponse.json({ ok: true });
    }

    // ── Sửa MÁY (tên / băng thông đo tay / vai trò) ──
    if (action === "update_machine") {
      const id = String(body.id ?? ""); if (!id) return NextResponse.json({ error: "Thiếu id máy." }, { status: 400 });
      const up: any = { updatedAt: nowISO() };
      if (typeof body.name === "string" && body.name.trim()) up.name = body.name.trim();
      if (body.uploadMbps != null) {
        const mbps = Number(body.uploadMbps) || 0;
        up.uploadMbps = mbps;
        up.uploadMbpsManual = mbps > 0;   // >0 = đặt tay (worker không ghi đè); =0 = trả về tự đo
      }
      if (["stream-247", "live-pub", "shared"].includes(body.role)) up.role = body.role;
      if (typeof body.provider === "string") up.provider = body.provider.trim().slice(0, 60);
      if (typeof body.region === "string") up.region = body.region.trim().slice(0, 60);
      if (typeof body.failureDomain === "string") up.failureDomain = body.failureDomain.trim().slice(0, 60);
      // Địa chỉ nhận file HTTPS riêng của máy (bỏ trống = xoá → máy này không tải-thẳng được, chỉ tải-từ-link).
      if (typeof body.uploadHttpsUrl === "string") { const u = body.uploadHttpsUrl.trim().replace(/\/+$/, ""); up.uploadHttpsUrl = (u && /^https:\/\//.test(u)) ? u : ""; }
      if (typeof body.maintenance === "boolean") up.maintenance = body.maintenance;   // Bảo trì: không gán luồng MỚI (luồng đang chạy không đụng)
      nhanGiaThue(body, up);
      await firestore.collection(M_COL).doc(id).update(up).catch(() => firestore.collection(M_COL).doc(id).set(up, { merge: true }));
      await logAudit(firestore, { action: "live_update_machine", entityType: "liveMachine", entityId: id, performedBy: user.email, detail: up.name ? `đổi tên "${up.name}"` : `băng thông ${up.uploadMbps ?? "?"} Mbps` });
      return NextResponse.json({ ok: true });
    }

    // ── Xoá MÁY (chỉ khi không còn luồng gắn máy này) ──
    if (action === "delete_machine") {
      const id = String(body.id ?? ""); if (!id) return NextResponse.json({ error: "Thiếu id." }, { status: 400 });
      const sSnap = await firestore.collection(S_COL).where("machineId", "==", id).limit(1).get().catch(() => null);
      if (sSnap && !sSnap.empty) return NextResponse.json({ error: "Máy còn luồng gắn vào — xoá/chuyển luồng trước." }, { status: 400 });
      // DỌN LUÔN VIDEO CỦA MÁY (30/08/2026). Trước đây xoá máy chỉ xoá bản ghi máy, còn video của nó
      // Ở LẠI làm bản ghi "mồ côi": cột Máy hiện "—", không dùng được vào việc gì, và tệ hơn là làm hệ
      // tưởng luồng ưu tiên "đã có bản dự phòng" trên một máy KHÔNG CÒN TỒN TẠI. Đo thật: xoá VPS 06
      // để lại 7 bản ghi như vậy. Máy đã xoá thì file trên nó cũng mất theo — giữ bản ghi là giữ rác.
      const aSnapDel = await firestore.collection(A_COL).where("machineId", "==", id).limit(500).get().catch(() => null);
      const videoIds = (aSnapDel?.docs ?? []).map((d) => d.id);
      // AN TOÀN: không xoá video nào còn được MỘT LUỒNG NÀO ĐÓ dùng (kể cả luồng ở máy khác).
      const dangDung = new Set<string>();
      if (videoIds.length) {
        const allS = await firestore.collection(S_COL).limit(2000).get().catch(() => null);
        (allS?.docs ?? []).forEach((d) => {
          const s: any = d.data();
          const ids: string[] = Array.isArray(s.assetIds) && s.assetIds.length ? s.assetIds : (s.assetId ? [s.assetId] : []);
          ids.forEach((i) => dangDung.add(String(i)));
        });
      }
      const canXoa = videoIds.filter((v) => !dangDung.has(v));
      const giuLai = videoIds.length - canXoa.length;
      if (giuLai > 0) return NextResponse.json({ error: `Máy này còn ${giuLai} video đang được luồng khác dùng — gỡ khỏi luồng trước rồi xoá máy.` }, { status: 400 });
      for (const v of canXoa) await firestore.collection(A_COL).doc(v).delete().catch(() => { /* đã xoá → bỏ qua */ });
      await firestore.collection(M_COL).doc(id).delete();
      await logAudit(firestore, { action: "live_delete_machine", entityType: "liveMachine", entityId: id, performedBy: user.email, detail: `xoá máy${canXoa.length ? ` + dọn ${canXoa.length} video của máy` : ""}` });
      return NextResponse.json({ ok: true, cleaned: canXoa.length });
    }

    // ── DỌN VIDEO MỒ CÔI: bản ghi video trỏ tới máy KHÔNG CÒN TỒN TẠI ──
    // Sinh ra từ những lần xoá máy TRƯỚC bản này (lúc đó xoá máy không dọn video). Chúng nằm lại
    // trong Kho video với cột Máy "—", không dùng được, và làm hệ tính nhầm tình trạng dự phòng.
    // Chỉ xoá bản ghi nào KHÔNG luồng nào đang dùng — an toàn tuyệt đối.
    if (action === "clean_orphan_assets") {
      const [mAllS, aAllS, sAllS] = await Promise.all([
        firestore.collection(M_COL).limit(200).get().catch(() => null),
        firestore.collection(A_COL).limit(2000).get().catch(() => null),
        firestore.collection(S_COL).limit(2000).get().catch(() => null),
      ]);
      // Đọc lỗi ở BẤT KỲ bảng nào → DỪNG, không đoán. Thiếu danh sách máy mà cứ xoá thì xoá sạch kho.
      if (!mAllS || !aAllS || !sAllS) return NextResponse.json({ error: "Không đọc đủ dữ liệu để dọn an toàn — thử lại sau." }, { status: 503 });
      const coMay = new Set(mAllS.docs.map((d) => d.id));
      const dangDung2 = new Set<string>();
      sAllS.docs.forEach((d) => {
        const s: any = d.data();
        const ids: string[] = Array.isArray(s.assetIds) && s.assetIds.length ? s.assetIds : (s.assetId ? [s.assetId] : []);
        ids.forEach((i) => dangDung2.add(String(i)));
      });
      const moCoi = aAllS.docs.filter((d) => {
        const a: any = d.data();
        const mid = String(a.machineId ?? "");
        return mid !== "" && !coMay.has(mid) && !dangDung2.has(d.id);
      });
      for (const d of moCoi) await firestore.collection(A_COL).doc(d.id).delete().catch(() => { /* đã xoá → bỏ qua */ });
      if (moCoi.length) await logAudit(firestore, { action: "live_clean_orphan_assets", entityType: "liveAsset", entityId: "-", performedBy: user.email, detail: `dọn ${moCoi.length} video mồ côi (máy đã xoá)` });
      return NextResponse.json({ ok: true, cleaned: moCoi.length });
    }

    // ── Thêm VIDEO (asset): link Drive + preset chuẩn hoá + máy sẽ tải/nén/phục vụ ──
    if (action === "add_asset") {
      const name = String(body.name ?? "").trim(), sourceUrl = String(body.sourceUrl ?? "").trim();
      let presetId = String(body.presetId ?? ""); const machineId = String(body.machineId ?? "");
      // CHÍNH SÁCH (Chủ Rise 2026-08-18): KHÔNG nén trên VPS nữa — video thêm từ Drive/link LUÔN giữ
      // NGUYÊN GỐC (nhân sự chuẩn hoá sẵn ở máy tính rồi tải lên). Ép về preset giữ-nguyên-gốc, chặn
      // mọi yêu cầu nén (dù client cũ có gửi preset nén thì cũng không nén).
      const reqPreset = resolveLivePreset(presetId);
      if (!reqPreset || !reqPreset.keepOriginal) { const orig = LIVE_QUALITY_PRESETS.find((p) => p.keepOriginal); if (orig) presetId = orig.id; }
      if (!name || !sourceUrl) return NextResponse.json({ error: "Thiếu tên hoặc link video." }, { status: 400 });
      // CHẶN NGAY Ở ĐÂY: link thư mục / link tài liệu / link không có mã file. Trước đây nhận bừa
      // rồi đẩy sang VPS, tới lúc tải mới báo "Khong doc duoc file id Google Drive" — người dán
      // không hiểu sai ở đâu (Chủ Rise Group phát hiện 29/08/2026).
      { const kq = kiemLinkDrive(sourceUrl); if (!kq.ok) return NextResponse.json({ error: kq.loi }, { status: 400 }); }
      if (!resolveLivePreset(presetId)) return NextResponse.json({ error: "Preset chất lượng không hợp lệ." }, { status: 400 });
      if (!machineId) return NextResponse.json({ error: "Chọn máy để tải video." }, { status: 400 });
      // Máy đầy băng thông / hết ổ → không nhận video mới.
      {
        const mSnap = await firestore.collection(M_COL).doc(machineId).get().catch(() => null);
        const chan = intakeBlock(mSnap?.exists ? { id: machineId, ...(mSnap.data() as any) } : null);
        if (chan) return NextResponse.json({ error: chan }, { status: 400 });
      }
      // ── E (V71.17) — KHÔNG TẢI LẠI LINK ĐÃ CÓ ────────────────────────────────────────────────
      // Đo thật 30/08/2026: 83 lượt tải THỪA trên 56 file — cùng một link Drive, mỗi máy tải lại một
      // lần. Google giới hạn lượt tải công khai THEO TỪNG FILE mỗi ngày; tải trùng chính là thứ đốt
      // hết hạn mức đó, rồi nhân sự nhận "không tải được" (lỗi mà bro gặp 29–30/08).
      // Cách xử: link này máy khác ĐÃ có bản sẵn sàng → bảo máy đích KÉO THẲNG từ máy đó, không hỏi
      // Google lần hai. Nhanh hơn nhiều (mạng nội bộ giữa VPS) và không tốn lượt Drive nào.
      // An toàn: đánh dấu `copyOptional` → chép hỏng thì worker LUI VỀ tải Drive đúng như trước khi
      // có mục này. Đây là đường tắt, không phải đường bắt buộc.
      let copyGoc: { url: string; assetId: string } | null = null;
      {
        const upPort = Number(process.env.RISE_LIVE_UPLOAD_PORT) || 8099;
        const same = await firestore.collection(A_COL).where("sourceUrl", "==", sourceUrl).limit(20).get().catch(() => null);
        // Đọc lỗi → same=null → BỎ đường tắt, tải Drive y như cũ. Đây là lui về hành vi cũ an toàn,
        // KHÔNG phải nuốt lỗi rồi hiểu nhầm "chưa có bản nào" (quy tắc 5) — kết quả xấu nhất chỉ là
        // tải lại từ Drive một lần như trước.
        const ungVien = (same?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) })).filter((x: any) =>
          x.status === "ready" && String(x.machineId ?? "") && String(x.machineId) !== machineId
          && String(x.presetId ?? "") === presetId);   // khác preset → file khác chất lượng, không dùng lại
        for (const c of ungVien) {
          const md = await firestore.collection(M_COL).doc(String(c.machineId)).get().catch(() => null);
          const m: any = md?.exists ? md.data() : null;
          if (!m) continue;
          const ip = String(m.ip ?? "").trim();
          if (!ip || m.forceOffline === true) continue;
          if (!isMachineOnline(m, Date.now())) continue;               // máy nguồn phải đang sống
          const up = Number(m.uploadMbps) || 0, tx = Number(m.txMbps) || 0;
          if (up > 0 && tx > up * DEFAULT_SAFETY_FACTOR) continue;     // máy nguồn đang căng băng thông → để yên
          copyGoc = { url: `http://${ip}:${upPort}`, assetId: c.id };
          break;
        }
      }
      const ref = await firestore.collection(A_COL).add({
        name, sourceUrl, presetId, machineId, status: "pending", createdAt: nowISO(), createdBy: user.email,
        ...(copyGoc ? { copyFromUrl: copyGoc.url, copyFromAssetId: copyGoc.assetId, copyOptional: true } : {}),
      });
      await logAudit(firestore, { action: "live_add_asset", entityType: "liveAsset", entityId: ref.id, performedBy: user.email, detail: name + (copyGoc ? " (chép từ máy đã có sẵn, không tải lại Drive)" : "") });
      return NextResponse.json({ ok: true, id: ref.id, ...(copyGoc ? { reused: true, note: "Video này máy khác đã có — hệ thống chép thẳng từ máy đó, không tải lại từ Google Drive (nhanh hơn và không tốn lượt tải của file)." } : {}) });
    }

    // ── SAO CHÉP video sang VPS khác (giữ nguyên gốc, KHÔNG nén): máy đích tự tải lại TỪ NGUỒN
    //    (Drive/link) của video. Chỉ được với video CÓ nguồn tải lại; video tải-thẳng-từ-máy không có
    //    nguồn → phải tải lại lên máy đó. ──
    if (action === "copy_asset") {
      const assetId = String(body.assetId ?? ""); const targetMachineId = String(body.targetMachineId ?? "");
      if (!assetId || !targetMachineId) return NextResponse.json({ error: "Thiếu video hoặc máy đích." }, { status: 400 });
      const aDoc = await firestore.collection(A_COL).doc(assetId).get();
      if (!aDoc.exists) return NextResponse.json({ error: "Không tìm thấy video." }, { status: 404 });
      const a = aDoc.data() as any;
      if (!(await ownsEntity(a.createdBy))) return NextResponse.json({ error: "Bạn không có quyền với video này." }, { status: 403 });
      const sourceUrl = String(a.sourceUrl ?? "").trim();
      if (targetMachineId === String(a.machineId ?? "")) return NextResponse.json({ error: "Video đã ở trên máy này rồi." }, { status: 400 });
      const mDoc = await firestore.collection(M_COL).doc(targetMachineId).get();
      if (!mDoc.exists) return NextResponse.json({ error: "Máy đích không tồn tại." }, { status: 400 });
      // Bản sao lưu chỉ CẤT GIỮ, không phát → KHÔNG chặn theo băng thông (Chủ Rise
      // chốt). Nhưng vẫn chặn theo ổ cứng: chép vào máy hết ổ là chép hỏng.
      {
        const chan = intakeBlock({ id: targetMachineId, ...(mDoc.data() as any) }, { laSaoLuu: true });
        if (chan) return NextResponse.json({ error: chan }, { status: 400 });
      }
      // COPY VPS->VPS: dia chi VPS NGUON (dang giu file da chuan) -> agent dich keo THANG file goc ve,
      // giu nguyen chat luong, KHONG tai lai tu Drive (Drive ha file lon xuong 360p). Luu san copyFromUrl.
      const srcMDoc = await firestore.collection(M_COL).doc(String(a.machineId ?? "")).get().catch(() => null);
      const srcIp = String((srcMDoc?.data() as any)?.ip ?? "").trim();
      const copyFromUrl = srcIp ? `http://${srcIp}:${Number(process.env.RISE_LIVE_UPLOAD_PORT) || 8099}` : null;
      // Copy duoc khi: co dia chi may nguon (VPS->VPS - KE CA video upload tay) HOAC co link Drive de tai lai.
      const hasDrive = /^https?:\/\//i.test(sourceUrl);
      if (!copyFromUrl && !hasDrive) return NextResponse.json({ error: "Không copy được: máy nguồn chưa có địa chỉ (IP) và video không có link tải lại — hãy TẢI TAY video lên máy đích (Tải video lên → chọn máy)." }, { status: 400 });
      // May dich da co ban nay chua? (theo id asset nguon HOAC sourceUrl)
      const dup = await firestore.collection(A_COL).where("machineId", "==", targetMachineId).limit(500).get().catch(() => null);
      if ((dup?.docs ?? []).some((d) => { const x = d.data() as any; return String(x.copyFromAssetId ?? "") === assetId || (sourceUrl !== "" && String(x.sourceUrl ?? "").trim() === sourceUrl); })) return NextResponse.json({ error: "Máy đích đã có video này rồi." }, { status: 400 });
      const ref = await firestore.collection(A_COL).add({
        name: a.name ?? "video", sourceUrl: a.sourceUrl ?? null, presetId: a.presetId, machineId: targetMachineId,
        status: "pending", createdAt: nowISO(), createdBy: user.email, source: "manual-copy",
        ...(copyFromUrl ? { copyFromUrl, copyFromAssetId: assetId } : {}),
      });
      await logAudit(firestore, { action: "live_copy_asset", entityType: "liveAsset", entityId: ref.id, performedBy: user.email, detail: `Sao chép "${a.name ?? assetId}" sang máy ${targetMachineId}` });
      return NextResponse.json({ ok: true, id: ref.id });
    }

    // ── Tạo LUỒNG: video (ready) + kênh (stream key) + máy → đặt trạng thái mong muốn = live ──
    if (action === "create_stream") {
      const name = String(body.name ?? "").trim();
      const machineId = String(body.machineId ?? "");
      const streamKey = String(body.streamKey ?? "").trim();
      const mode = body.mode === "live-pub" ? "live-pub" : "stream-247";
      if (!name || !machineId || !streamKey) return NextResponse.json({ error: "Thiếu tên / máy / khoá luồng." }, { status: 400 });
      // Chan dan nham DUONG DAN vao o khoa luong — sai khoa thi chuyen may nao
      // cung hong, ma he thong lai bao "nghi loi mang/VPS" (Chu Rise gap 28/08).
      { const kq = kiemKhoaLuong(streamKey); if (!kq.ok) return NextResponse.json({ error: kq.loi }, { status: 400 }); }
      const pl = await resolvePlaylist(body);
      if (!pl.ok) return NextResponse.json({ error: pl.error }, { status: 400 });
      const { assetIds, firstAsset: asset, presetId: plPreset, playMode, mixWarn } = pl;
      const assetId = assetIds[0];
      // Lịch phát (tuỳ chọn — áp dụng cho CẢ 24/7 lẫn live-pub). control=schedule → worker
      // tự bật/tắt theo giờ; control=manual → bật/tắt bằng nút.
      const control = body.control === "schedule" ? "schedule" : "manual";
      let schedule: any = null;
      if (control === "schedule") {
        const start = String(body.scheduleStart ?? "").trim();
        if (!start) return NextResponse.json({ error: "Lịch phát: thiếu thời điểm bắt đầu." }, { status: 400 });
        if (mode === "live-pub") {
          // Live Pub: cần thời lượng (phát 1 phiên có điểm kết thúc) + có thể lặp hằng ngày.
          const durationMin = Math.round(Number(body.scheduleDurationMin) || 0);
          if (durationMin <= 0) return NextResponse.json({ error: "Live Pub hẹn giờ: cần nhập thời lượng (phút)." }, { status: 400 });
          const repeat = body.scheduleRepeat === "daily" ? "daily" : "none";
          schedule = { start, durationMin, repeat };
        } else {
          // Live 24/7 hẹn giờ: phát LIÊN TỤC từ giờ bắt đầu — không cần thời lượng/lặp lại.
          schedule = { start, durationMin: 0, repeat: "none" };
        }
      }
      // ── KIỂM TRA TRƯỚC KHI LÊN SÓNG (preflight): CHẶN cái chắc hỏng, CẢNH BÁO cái đáng lưu ý ──
      const mDoc = await firestore.collection(M_COL).doc(machineId).get();
      const machine: any = mDoc.exists ? { id: mDoc.id, ...(mDoc.data() as any) } : null;
      if (!machine) return NextResponse.json({ error: "Máy không tồn tại." }, { status: 400 });
      // ENFORCE THẬT Ở SERVER: máy đang BẢO TRÌ không được gán luồng MỚI (trước chỉ chặn ở giao diện).
      if (machine.maintenance) return NextResponse.json({ error: `Máy "${machine.name}" đang BẢO TRÌ — không gán luồng mới. Hãy chọn máy khác.` }, { status: 400 });
      const pf = preflightLive({
        streamKey, goingLiveNow: control === "manual", machineOnline: isMachineOnline(machine, Date.now()),
        machineName: machine.name, assetStatus: asset.status, assetName: asset.name, hasBandwidth: !!machine.uploadMbps,
      });
      if (pf.level === "block") return NextResponse.json({ error: "Chưa thể lên sóng:\n• " + blockReasons(pf.issues) }, { status: 400 });
      // CHẶN QUÁ TẢI BĂNG THÔNG: nếu thêm luồng này vượt SỨC CHỨA AN TOÀN của máy (dùng ~70% băng
      // thông, chừa 30% dự phòng) → không cho lên sóng (tránh giật CẢ máy). Chỉ chặn khi lên sóng
      // NGAY + máy đã biết băng thông + chất lượng đo được (bỏ qua "giữ nguyên gốc" vì không ước lượng nổi).
      const capMsg = capacityBlock(machine, resolveLivePreset(plPreset || asset.presetId), control === "manual");
      if (capMsg) return NextResponse.json({ error: capMsg }, { status: 400 });

      let watchUrl = String(body.watchUrl ?? "").trim().slice(0, 300);
      // Gắn kênh (tuỳ chọn). Nếu chọn → kiểm tra phạm vi + denormalize tên kênh; watchUrl trống thì
      // mượn URL kênh.
      let channelId: string | null = null, channelName: string | null = null;
      if (body.channelId) {
        const ch = await resolveChannelInScope(String(body.channelId));
        if (!ch) return NextResponse.json({ error: "Kênh không hợp lệ hoặc ngoài phạm vi của bạn." }, { status: 400 });
        channelId = ch.id; channelName = ch.name; if (!watchUrl && ch.url) watchUrl = ch.url.slice(0, 300);
      }
      // BẮT BUỘC link video live (YouTube) — hệ thống dùng API KEY để tự theo dõi luồng có bị chặn/
      // đình chỉ không (RL-YTB-006). Không có link thì engine không kiểm được → yêu cầu dán khi tạo.
      if (!watchUrl) return NextResponse.json({ error: "Cần dán LINK VIDEO LIVE (YouTube) để hệ thống tự theo dõi luồng bằng API. Lấy link ở trang phát trực tiếp của kênh (hoặc gắn kênh có sẵn link)." }, { status: 400 });
      // Chặn xung đột đích phát (trùng khoá / cùng kênh cùng lúc / lịch chồng).
      const conflict = await streamConflict(streamKey, channelId, control, schedule, control === "manual", null);
      if (conflict) return NextResponse.json({ error: conflict }, { status: 400 });
      const ref = await firestore.collection(S_COL).add({
        name, assetId, assetIds, playMode, machineId, presetId: plPreset, mode,
        allowBlack: body.allowBlack === true,   // "Nội dung tối/đen chủ ý" → bỏ qua cảnh báo màn đen
        priority: body.priority === true,        // KÊNH ƯU TIÊN (RL-SCL-001) → cảnh báo mạnh hơn + phục hồi trước
        rtmpBase: YOUTUBE_RTMP_BASE, streamKey, control, schedule,
        desiredState: control === "schedule" ? "stopped" : "live", status: "queued", health: "unknown",
        restarts: 0, createdAt: nowISO(), createdBy: user.email,
        // Denormalize người tạo + đơn vị (chụp lúc tạo — không tốn đọc users mỗi lần poll)
        createdByName: user.fullName ?? user.email, createdByUnit: user.unit ?? "",
        channelId, channelName, watchUrl: watchUrl || null,
      });
      await logAudit(firestore, { action: "live_create_stream", entityType: "liveStream", entityId: ref.id, performedBy: user.email, detail: `${name} → ${maskKey(streamKey)}` });
      const warns = pf.issues.filter((i) => i.level === "warn").map((i) => i.text);
      if (mixWarn) warns.push("Danh sách có nhiều mức chất lượng khác nhau — phát nối có thể lỗi/giật; nên chọn video CÙNG mức.");
      return NextResponse.json({ ok: true, id: ref.id, warnings: warns });
    }

    // ── SỬA LUỒNG (chỉ khi CHƯA chạy — tránh sửa nhầm/set nhầm khoá/video/máy/lịch) ──
    if (action === "edit_stream") {
      const id = String(body.id ?? ""); if (!id) return NextResponse.json({ error: "Thiếu id luồng." }, { status: 400 });
      const cur = await firestore.collection(S_COL).doc(id).get();
      if (!cur.exists) return NextResponse.json({ error: "Luồng không tồn tại." }, { status: 404 });
      const old: any = cur.data();
      if (!(await ownsEntity(old.createdBy))) return NextResponse.json({ error: "Bạn không có quyền sửa luồng này." }, { status: 403 });
      // Chặn sửa khi luồng ĐANG PHẢI phát (ý định), KHÔNG bám status của worker (có thể kẹt "live" sau
      // khi đã dừng vì worker thôi báo) → luồng đã dừng vẫn sửa được.
      if (old.desiredState === "live" || (old.control === "schedule" && isWithinSchedule(old.schedule, Date.now())))
        return NextResponse.json({ error: "Luồng đang chạy — hãy DỪNG luồng trước khi sửa." }, { status: 400 });
      const name = String(body.name ?? "").trim();
      const machineId = String(body.machineId ?? "");
      const streamKey = String(body.streamKey ?? "").trim();
      const mode = body.mode === "live-pub" ? "live-pub" : "stream-247";
      if (!name || !machineId || !streamKey) return NextResponse.json({ error: "Thiếu tên / máy / khoá luồng." }, { status: 400 });
      // Chan dan nham DUONG DAN vao o khoa luong — sai khoa thi chuyen may nao
      // cung hong, ma he thong lai bao "nghi loi mang/VPS" (Chu Rise gap 28/08).
      { const kq = kiemKhoaLuong(streamKey); if (!kq.ok) return NextResponse.json({ error: kq.loi }, { status: 400 }); }
      const pl = await resolvePlaylist(body);
      if (!pl.ok) return NextResponse.json({ error: pl.error }, { status: 400 });
      const { assetIds, firstAsset: asset, presetId: plPreset, playMode } = pl;
      const assetId = assetIds[0];
      const control = body.control === "schedule" ? "schedule" : "manual";
      let schedule: any = null;
      if (control === "schedule") {
        const start = String(body.scheduleStart ?? "").trim();
        if (!start) return NextResponse.json({ error: "Lịch phát: thiếu thời điểm bắt đầu." }, { status: 400 });
        if (mode === "live-pub") {
          const durationMin = Math.round(Number(body.scheduleDurationMin) || 0);
          if (durationMin <= 0) return NextResponse.json({ error: "Live Pub hẹn giờ: cần nhập thời lượng (phút)." }, { status: 400 });
          schedule = { start, durationMin, repeat: body.scheduleRepeat === "daily" ? "daily" : "none" };
        } else schedule = { start, durationMin: 0, repeat: "none" };
      }
      let watchUrl = String(body.watchUrl ?? "").trim().slice(0, 300);
      let channelId: string | null = null, channelName: string | null = null;
      if (body.channelId) {
        const ch = await resolveChannelInScope(String(body.channelId));
        if (!ch) return NextResponse.json({ error: "Kênh không hợp lệ hoặc ngoài phạm vi của bạn." }, { status: 400 });
        channelId = ch.id; channelName = ch.name; if (!watchUrl && ch.url) watchUrl = ch.url.slice(0, 300);
      }
      const editConflict = await streamConflict(streamKey, channelId, control, schedule, false, id);
      if (editConflict) return NextResponse.json({ error: editConflict }, { status: 400 });
      await firestore.collection(S_COL).doc(id).set({
        name, assetId, assetIds, playMode, machineId, presetId: plPreset, mode, streamKey, control, schedule,
        allowBlack: body.allowBlack === true,   // "Nội dung tối/đen chủ ý" → bỏ qua cảnh báo màn đen
        priority: body.priority === true,        // KÊNH ƯU TIÊN (RL-SCL-001)
        desiredState: "stopped", channelId, channelName, watchUrl: watchUrl || null, updatedAt: nowISO(), updatedBy: user.email,
      }, { merge: true });
      await logAudit(firestore, { action: "live_edit_stream", entityType: "liveStream", entityId: id, performedBy: user.email, detail: `${name} → ${maskKey(streamKey)}` });
      return NextResponse.json({ ok: true, warnings: pl.mixWarn ? ["Danh sách có nhiều mức chất lượng — nên chọn video cùng mức."] : [] });
    }

    // ── BÁO / GỠ sự cố YouTube (bản quyền / đình chỉ) — thủ công (RL-YTB-005/006). Ai phát hiện (xem
    //    YouTube Studio) thì gắn cờ → luồng hiện ĐỎ + báo chủ luồng, dù local vẫn "đang phát". Sau này
    //    engine YouTube API sẽ tự set cờ này. Chủ luồng HOẶC người vận hành được thao tác.
    if (action === "flag_yt_issue" || action === "clear_yt_issue") {
      const id = String(body.id ?? ""); if (!id) return NextResponse.json({ error: "Thiếu id luồng." }, { status: 400 });
      const cur = await firestore.collection(S_COL).doc(id).get();
      if (!cur.exists) return NextResponse.json({ error: "Luồng không tồn tại." }, { status: 404 });
      const sd: any = cur.data();
      if (!(await ownsEntity(sd.createdBy)) && !canOperateLive(user)) return NextResponse.json({ error: "Bạn không có quyền với luồng này." }, { status: 403 });
      if (action === "clear_yt_issue") {
        await firestore.collection(S_COL).doc(id).set({ ytIssue: null }, { merge: true });
        // Nhật ký cố định: vụ YouTube chặn/đình chỉ ĐÃ XỬ (bỏ cờ) → lưu lịch sử.
        if (sd.ytIssue) {
          await firestore.collection("liveIncidentLog").add({
            streamId: id, streamName: sd.name ?? "", machineId: await mayLucXayRa(id, String(sd.machineId ?? ""), String(sd.ytIssue?.at ?? nowISO())), streamOwner: sd.createdBy ?? "",
            cause: "YouTube chặn/đình chỉ", reason: String(sd.ytIssue?.note ?? "").slice(0, 300),
            startedAt: sd.ytIssue?.at ?? nowISO(), resolvedAt: nowISO(), resolution: "cleared_yt_flag",
            resolvedBy: user.email, resolvedByName: user.fullName ?? user.email, createdAt: nowISO(),
          }).catch(() => {});
        }
        await logAudit(firestore, { action: "live_clear_yt_issue", entityType: "liveStream", entityId: id, performedBy: user.email, detail: sd.name });
        return NextResponse.json({ ok: true });
      }
      const note = String(body.note ?? "").trim().slice(0, 300);
      await firestore.collection(S_COL).doc(id).set({
        ytIssue: { type: "policy", note, source: "manual", by: user.email, byName: user.fullName ?? user.email, at: nowISO() },
      }, { merge: true });
      await logAudit(firestore, { action: "live_flag_yt_issue", entityType: "liveStream", entityId: id, performedBy: user.email, detail: `${sd.name}${note ? " — " + note : ""}` });
      await notifyOutcome(firestore, [sd.createdBy], { eventType: "live_yt_issue", label: `⚠ Luồng "${sd.name}" nghi bị chặn/đình chỉ trên YouTube${note ? " — " + note : ""}. Kiểm tra YouTube Studio.`, tone: "red", pushCategory: "urgent", actorEmail: user.email });
      return NextResponse.json({ ok: true });
    }

    // ── Xác nhận "nội dung tối/đen CHỦ Ý" ngay trên cảnh báo màn đen (thay ô tích lúc tạo — gọn hơn).
    //    Bấm 1 nút → bỏ qua cảnh báo màn đen cho luồng này. Chạy được cả khi đang live.
    if (action === "set_allow_black") {
      const id = String(body.id ?? ""); if (!id) return NextResponse.json({ error: "Thiếu id luồng." }, { status: 400 });
      const cur = await firestore.collection(S_COL).doc(id).get();
      if (!cur.exists) return NextResponse.json({ error: "Luồng không tồn tại." }, { status: 404 });
      const sd: any = cur.data();
      if (!(await ownsEntity(sd.createdBy)) && !canOperateLive(user)) return NextResponse.json({ error: "Bạn không có quyền với luồng này." }, { status: 403 });
      const allow = body.allow !== false;
      await firestore.collection(S_COL).doc(id).set({ allowBlack: allow }, { merge: true });
      await logAudit(firestore, { action: "live_set_allow_black", entityType: "liveStream", entityId: id, performedBy: user.email, detail: allow ? "xác nhận nền đen chủ ý" : "bật lại cảnh báo màn đen" });
      return NextResponse.json({ ok: true });
    }

    // ── Bật/dừng LUỒNG (đổi trạng thái mong muốn — worker sẽ khớp theo) ──
    // ── CHUYỂN Live Pub → Live 24/7 (phát LIÊN TỤC, không kết thúc theo thời lượng). An toàn cả khi
    //    đang phát: worker vốn lặp video vô hạn; chỉ đổi ngữ nghĩa mode + bỏ thời lượng lịch (nếu có).
    if (action === "convert_to_247") {
      const id = String(body.id ?? ""); if (!id) return NextResponse.json({ error: "Thiếu id luồng." }, { status: 400 });
      const cur = await firestore.collection(S_COL).doc(id).get();
      if (!cur.exists) return NextResponse.json({ error: "Luồng không tồn tại." }, { status: 404 });
      const sd: any = cur.data();
      if (!(await ownsEntity(sd.createdBy))) return NextResponse.json({ error: "Bạn không có quyền với luồng này." }, { status: 403 });
      if (sd.mode !== "live-pub") return NextResponse.json({ error: "Luồng này đã là Live 24/7." }, { status: 400 });
      const up: any = { mode: "stream-247", updatedAt: nowISO() };
      // Hẹn giờ: giữ giờ bắt đầu nhưng BỎ thời lượng/lặp → phát liên tục từ giờ đó (durationMin=0).
      if (sd.control === "schedule" && sd.schedule) up.schedule = { ...sd.schedule, durationMin: 0, repeat: "none" };
      await firestore.collection(S_COL).doc(id).set(up, { merge: true });
      await logAudit(firestore, { action: "live_convert_247", entityType: "liveStream", entityId: id, performedBy: user.email, detail: `Chuyển "${sd.name ?? id}" Live Pub → Live 24/7` });
      return NextResponse.json({ ok: true });
    }

    if (action === "set_stream") {
      const id = String(body.id ?? ""); const desired = body.desired === "live" ? "live" : "stopped";
      if (!id) return NextResponse.json({ error: "Thiếu id luồng." }, { status: 400 });
      const cur = await firestore.collection(S_COL).doc(id).get();
      if (!cur.exists) return NextResponse.json({ error: "Luồng không tồn tại." }, { status: 404 });
      const sd: any = cur.data();
      if (!(await ownsEntity(sd.createdBy))) return NextResponse.json({ error: "Bạn không có quyền với luồng này." }, { status: 403 });
      // Kiểm tra trước khi LÊN SÓNG (chỉ khi bấm "Lên sóng") — CHẶN nếu chắc chắn hỏng.
      let warnings: string[] = [];
      if (desired === "live") {
        const [mDoc, aDoc] = await Promise.all([
          firestore.collection(M_COL).doc(String(sd.machineId ?? "")).get().catch(() => null),
          firestore.collection(A_COL).doc(String(sd.assetId ?? "")).get().catch(() => null),
        ]);
        const machine: any = mDoc?.exists ? mDoc.data() : null;
        const asset: any = aDoc?.exists ? aDoc.data() : null;
        const pf = preflightLive({
          streamKey: sd.streamKey, goingLiveNow: true, machineOnline: machine ? isMachineOnline(machine, Date.now()) : false,
          machineName: machine?.name, assetStatus: asset?.status ?? "missing", assetName: asset?.name, hasBandwidth: !!machine?.uploadMbps,
        });
        if (pf.level === "block") return NextResponse.json({ error: "Chưa thể lên sóng:\n• " + blockReasons(pf.issues) }, { status: 400 });
        // CHẶN QUÁ TẢI BĂNG THÔNG (như lúc tạo luồng): máy đầy sức chứa an toàn → không cho bật thêm.
        const capMsg = capacityBlock(machine, resolveLivePreset(asset?.presetId), true);
        if (capMsg) return NextResponse.json({ error: capMsg }, { status: 400 });
        warnings = pf.issues.filter((i) => i.level === "warn").map((i) => i.text);
        // Chặn xung đột đích phát khi BẬT lên sóng (trùng khoá / cùng kênh đang phát).
        const liveConflict = await streamConflict(String(sd.streamKey ?? ""), sd.channelId ?? null, sd.control ?? "manual", sd.schedule ?? null, true, id);
        if (liveConflict) return NextResponse.json({ error: liveConflict }, { status: 400 });
      }
      // Chủ động DỪNG → xoá mốc "live từ" (phiên sau lên sóng sẽ tính mốc mới). Tự restart KHÔNG đụng.
      // Luồng HẸN GIỜ mà bấm Dừng → chuyển về THỦ CÔNG để nó THỰC SỰ dừng (không tự bật lại theo lịch).
      const patch: any = { desiredState: desired, updatedAt: nowISO(), updatedBy: user.email };
      // Bấm "Lên sóng" = người dùng đã kiểm tra/xử lý → GỠ cờ "nghi bị chặn/đình chỉ YouTube" (auto) để agent
      // được phép đẩy lại (phá kẹt: nếu không gỡ, reconcile thấy ytIssue → cứ dừng, không bao giờ lên lại được).
      if (desired === "live" && sd.ytIssue) patch.ytIssue = null;
      if (desired === "stopped") {
        patch.liveSince = null;
        if (sd.control === "schedule") patch.control = "manual";
        // Phản ánh DỪNG NGAY trên giao diện (Sửa/Xoá hiện liền) — không chờ worker báo lại. Worker r2.12
        // sau khi dừng thôi báo trạng thái nên status/health bị đóng băng ở "live"; đặt tay tại đây cho đúng.
        patch.status = "stopped"; patch.health = "idle";
      }
      await firestore.collection(S_COL).doc(id).set(patch, { merge: true });
      // NHẬT KÝ SỰ CỐ CỐ ĐỊNH: dừng 1 luồng ĐANG LỖI → lưu 1 bản ghi lịch sử (giữ cả SAU khi dừng,
      // để không mất dấu "luồng này từng lỗi lúc X, ai dừng, vì sao"). Thuần cộng thêm, không đụng phát.
      if (desired === "stopped") {
        const hadIssue = sd.status === "error" || sd.health === "error" || !!sd.ytIssue || !!sd.restartHalted || !!sd.needsHuman;
        if (hadIssue) {
          const cause = sd.ytIssue ? "YouTube chặn/đình chỉ" : (sd.restartHalted ? "Chớp tắt — đã tạm dừng" : "Luồng lỗi/sập");
          await firestore.collection("liveIncidentLog").add({
            streamId: id, streamName: sd.name ?? "", machineId: await mayLucXayRa(id, String(sd.machineId ?? ""), String(sd.ytIssue?.at ?? sd.lastHeartbeatAt ?? nowISO())), streamOwner: sd.createdBy ?? "",
            cause, reason: String(sd.ytIssue?.note || sd.haltReason || sd.error || "").slice(0, 300),
            startedAt: sd.ytIssue?.at ?? sd.lastHeartbeatAt ?? nowISO(),
            resolvedAt: nowISO(), resolution: "stopped",
            resolvedBy: user.email, resolvedByName: user.fullName ?? user.email, createdAt: nowISO(),
          }).catch(() => {});
        }
      }
      await logAudit(firestore, { action: "live_set_stream", entityType: "liveStream", entityId: id, performedBy: user.email, detail: desired });
      return NextResponse.json({ ok: true, warnings });
    }

    // ── Đổi TÊN luồng / video (trong phạm vi) ──
    if (action === "rename_stream" || action === "rename_asset") {
      const col = action === "rename_stream" ? S_COL : A_COL;
      const id = String(body.id ?? ""); const name = String(body.name ?? "").trim().slice(0, 120);
      if (!id || !name) return NextResponse.json({ error: "Thiếu id hoặc tên mới." }, { status: 400 });
      const cur = await firestore.collection(col).doc(id).get();
      if (!cur.exists) return NextResponse.json({ error: "Không tồn tại." }, { status: 404 });
      if (!(await ownsEntity((cur.data() as any).createdBy))) return NextResponse.json({ error: "Bạn không có quyền đổi tên mục này." }, { status: 403 });
      await firestore.collection(col).doc(id).set({ name, updatedAt: nowISO() }, { merge: true });
      await logAudit(firestore, { action: `live_${action}`, entityType: action === "rename_stream" ? "liveStream" : "liveAsset", entityId: id, performedBy: user.email, detail: `đổi tên → ${name}` });
      return NextResponse.json({ ok: true });
    }

    // ── Đặt URL video live (link YouTube để xem/kiểm tra chất lượng — nhập tay, trong phạm vi) ──
    if (action === "set_watch_url") {
      const id = String(body.id ?? ""); const watchUrl = String(body.watchUrl ?? "").trim().slice(0, 300);
      if (!id) return NextResponse.json({ error: "Thiếu id luồng." }, { status: 400 });
      const cur = await firestore.collection(S_COL).doc(id).get();
      if (!cur.exists) return NextResponse.json({ error: "Luồng không tồn tại." }, { status: 404 });
      if (!(await ownsEntity((cur.data() as any).createdBy))) return NextResponse.json({ error: "Bạn không có quyền với luồng này." }, { status: 403 });
      await firestore.collection(S_COL).doc(id).set({ watchUrl: watchUrl || null, updatedAt: nowISO() }, { merge: true });
      return NextResponse.json({ ok: true });
    }

    // ── Dự phòng nhiều VPS (Đợt 2): đặt MỨC ƯU TIÊN + CHẾ ĐỘ DỰ PHÒNG cho luồng ──
    //    Thuần metadata (worker KHÔNG đọc) — an toàn đặt cả khi đang phát. importance quyết thứ tự
    //    cứu; failoverMode quyết có được TỰ chuyển hay không (auto chỉ chạy khi =automatic, ở đợt sau).
    if (action === "set_stream_meta") {
      const id = String(body.id ?? ""); if (!id) return NextResponse.json({ error: "Thiếu id luồng." }, { status: 400 });
      const cur = await firestore.collection(S_COL).doc(id).get();
      if (!cur.exists) return NextResponse.json({ error: "Luồng không tồn tại." }, { status: 404 });
      if (!(await ownsEntity((cur.data() as any).createdBy))) return NextResponse.json({ error: "Bạn không có quyền với luồng này." }, { status: 403 });
      const up: any = { updatedAt: nowISO() };
      if (["normal", "priority", "critical"].includes(body.importance)) up.importance = body.importance;
      if (["disabled", "manual", "automatic"].includes(body.failoverMode)) up.failoverMode = body.failoverMode;
      if (up.importance === undefined && up.failoverMode === undefined) return NextResponse.json({ error: "Không có thay đổi hợp lệ." }, { status: 400 });
      // (A) Chủ Rise chốt 2026-08-18: luồng ƯU TIÊN/TRỌNG YẾU thì LUÔN được bảo vệ → tự bật "tự động cứu".
      // (Không cho tắt tự-cứu trên luồng ưu tiên; muốn tắt thì hạ mức về "thường" trước.)
      const finalImportance = up.importance ?? (cur.data() as any).importance ?? "normal";
      let autoForced = false;
      if ((finalImportance === "priority" || finalImportance === "critical") && up.failoverMode !== "automatic") {
        autoForced = (cur.data() as any).failoverMode !== "automatic";
        up.failoverMode = "automatic";
      }
      await firestore.collection(S_COL).doc(id).set(up, { merge: true });
      await logAudit(firestore, { action: "live_set_stream_meta", entityType: "liveStream", entityId: id, performedBy: user.email, detail: `ưu tiên=${up.importance ?? "-"} dự phòng=${up.failoverMode ?? "-"}${autoForced ? " (ép tự-cứu do ưu tiên)" : ""}` });
      return NextResponse.json({ ok: true, autoForced });
    }

    // ── Dự phòng nhiều VPS (Đợt 3): PREFLIGHT chuyển luồng — CHỈ ĐỌC (chấm điểm máy đích + kiểm tra).
    if (action === "move_preflight") {
      const id = String(body.id ?? ""); if (!id) return NextResponse.json({ error: "Thiếu id luồng." }, { status: 400 });
      const sDoc = await firestore.collection(S_COL).doc(id).get();
      if (!sDoc.exists) return NextResponse.json({ error: "Luồng không tồn tại." }, { status: 404 });
      const sData: any = { id: sDoc.id, ...(sDoc.data() as any) };
      if (!(await ownsEntity(sData.createdBy))) return NextResponse.json({ error: "Bạn không có quyền với luồng này." }, { status: 403 });
      const [mSnap, aSnap, sSnap] = await Promise.all([
        firestore.collection(M_COL).limit(200).get().catch(() => null),
        firestore.collection(A_COL).limit(1000).get().catch(() => null),
        firestore.collection(S_COL).limit(2000).get().catch(() => null),
      ]);
      const nowMs2 = Date.now();
      const mAll = (mSnap?.docs ?? []).map((d) => { const m: any = { id: d.id, ...(d.data() as any) }; m.online = isMachineOnline(m, nowMs2); return m; });
      const aAll = (aSnap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) }));
      const sAll = (sSnap?.docs ?? []).map((d) => { const s: any = { id: d.id, ...(d.data() as any) }; if (s.control === "schedule" && s.schedule) s.scheduleActive = isWithinSchedule(s.schedule, nowMs2); return s; });
      const pm: Record<string, number> = {}; LIVE_QUALITY_PRESETS.forEach((p) => { pm[p.id] = streamBandwidthMbps(p); });
      const mode: MoveMode = body.mode === "emergency" ? "emergency" : "planned";
      const pf = moveTargetPreflight(sData, mAll as any, sAll as any, aAll as any, pm, mode);
      const targetId = String(body.targetId ?? "");
      const check = targetId ? checkMoveTarget(pf, targetId) : null;
      // COPY ĐƯỢC SANG MÁY ĐÍCH? = máy NGUỒN có địa chỉ (IP) để máy đích KÉO THẲNG file đã chuẩn về
      // (VPS->VPS, giữ chất lượng, không qua Drive). Nay đúng cho CẢ video tải lên tay (không cần link Drive) —
      // miễn máy nguồn đang giữ file (luồng đang phát thì luôn có).
      const srcIds: string[] = Array.isArray(sData.assetIds) && sData.assetIds.length ? sData.assetIds : (sData.assetId ? [sData.assetId] : []);
      const srcA = srcIds.map((aid) => (aAll as any[]).find((a) => a.id === aid)).filter(Boolean) as any[];
      const srcMachine = (mAll as any[]).find((m) => m.id === String(sData.machineId ?? ""));
      const srcHasIp = !!String(srcMachine?.ip ?? "").trim();
      const videoReDownloadable = srcA.length === srcIds.length && srcA.length > 0 && srcHasIp;
      return NextResponse.json({ ok: true, preflight: pf, check, moveEnabled: MOVE_FEATURE_ON(), videoReDownloadable });
    }

    // ── Dự phòng nhiều VPS (Đợt 3): CHUYỂN LUỒNG THẬT (bàn giao 2 pha an toàn) — sau cờ RISE_LIVE_MOVE.
    //    Chỉ KHỞI ĐỘNG (đặt moveState). Bàn giao do agent tự tiến (dừng nguồn xong mới bật đích →
    //    KHÔNG bao giờ 2 máy cùng phát). Hoàn tác nếu quá hạn.
    if (action === "move_execute") {
      if (!MOVE_FEATURE_ON()) return NextResponse.json({ error: "Tính năng chuyển máy chưa được bật (RISE_LIVE_MOVE)." }, { status: 400 });
      const id = String(body.id ?? ""); const targetId = String(body.targetId ?? "");
      if (!id || !targetId) return NextResponse.json({ error: "Thiếu luồng hoặc máy đích." }, { status: 400 });
      const sDoc = await firestore.collection(S_COL).doc(id).get();
      if (!sDoc.exists) return NextResponse.json({ error: "Luồng không tồn tại." }, { status: 404 });
      const sData: any = { id: sDoc.id, ...(sDoc.data() as any) };
      if (!(await ownsEntity(sData.createdBy))) return NextResponse.json({ error: "Bạn không có quyền với luồng này." }, { status: 403 });
      if (isMoveActive(sData.moveState)) return NextResponse.json({ error: "Luồng đang trong một lần chuyển khác." }, { status: 409 });
      if (targetId === String(sData.machineId ?? "")) return NextResponse.json({ error: "Máy đích trùng máy hiện tại." }, { status: 400 });
      const liveNow = sData.desiredState === "live" || (sData.control === "schedule" && isWithinSchedule(sData.schedule, Date.now()));
      if (!liveNow) return NextResponse.json({ error: "Chỉ chuyển được luồng ĐANG phát. Luồng đã dừng thì Sửa để đổi máy." }, { status: 400 });
      // Preflight đích.
      const [mSnap, aSnap, sSnap] = await Promise.all([
        firestore.collection(M_COL).limit(200).get().catch(() => null),
        firestore.collection(A_COL).limit(1000).get().catch(() => null),
        firestore.collection(S_COL).limit(2000).get().catch(() => null),
      ]);
      const nowMs3 = Date.now();
      const mAll = (mSnap?.docs ?? []).map((d) => { const m: any = { id: d.id, ...(d.data() as any) }; m.online = isMachineOnline(m, nowMs3); return m; });
      const aAll = (aSnap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) }));
      const sAll = (sSnap?.docs ?? []).map((d) => { const s: any = { id: d.id, ...(d.data() as any) }; if (s.control === "schedule" && s.schedule) s.scheduleActive = isWithinSchedule(s.schedule, nowMs3); return s; });
      const pm: Record<string, number> = {}; LIVE_QUALITY_PRESETS.forEach((p) => { pm[p.id] = streamBandwidthMbps(p); });
      const pf = moveTargetPreflight(sData, mAll as any, sAll as any, aAll as any, pm, body.mode === "emergency" ? "emergency" : "planned");
      const chk = checkMoveTarget(pf, targetId);
      if (chk.level === "block") return NextResponse.json({ error: "Không chuyển được: " + chk.messages.join(" · ") }, { status: 400 });
      const cand = pf.candidates.find((c) => c.machineId === targetId);
      // Máy đích CHƯA có video: nếu người dùng chọn TỰ COPY + video TẢI LẠI ĐƯỢC (Drive/link) → tạo bản
      // sao trên máy đích + đặt "copying_video" (luồng VẪN phát ở nguồn), cron tự chuyển khi sẵn sàng.
      if (!cand?.hasVideo) {
        const ids0: string[] = Array.isArray(sData.assetIds) && sData.assetIds.length ? sData.assetIds : (sData.assetId ? [sData.assetId] : []);
        const srcAssets0 = ids0.map((aid) => (aAll as any[]).find((a) => a.id === aid)).filter(Boolean) as any[];
        const parts = srcAssets0.map((a) => ({ url: String(a.sourceUrl ?? "").trim(), presetId: a.presetId, name: a.name, srcAssetId: String(a.id ?? "") }));
        // COPY VPS->VPS: chi can NGUON co san file (moi luong dang phat deu co). KHONG con doi hoi tai lai tu
        // Drive (allReDownloadable). Neu nguon khong toi duoc -> agent bao loi ro, khong am tham lay 360p.
        const srcMDoc2 = await firestore.collection(M_COL).doc(String(sData.machineId ?? "")).get().catch(() => null);
        const srcIp2 = String((srcMDoc2?.data() as any)?.ip ?? "").trim();
        const copyFromUrl2 = srcIp2 ? `http://${srcIp2}:${Number(process.env.RISE_LIVE_UPLOAD_PORT) || 8099}` : null;
        const canCopy = srcAssets0.length === ids0.length && parts.length > 0 && !!copyFromUrl2;
        if (!body.autoCopy || !canCopy) {
          return NextResponse.json({ error: canCopy
            ? "Máy đích CHƯA có video sẵn sàng — copy video sang trước (không cắt sóng cũ)."
            : "Không copy tự động được (thiếu địa chỉ máy nguồn) — hãy TẢI TAY video lên máy đích rồi chuyển." }, { status: 400 });
        }
        const nowC = nowISO();
        // Dedup theo id asset nguon (video upload tay) HOAC sourceUrl (Drive) — tranh tao ban sao trung khi
        // bam chuyen may nhieu lan (truoc day chi theo sourceUrl -> video upload tay khong co url -> tao trung).
        const targetHas = new Set<string>();
        (aAll as any[]).filter((a) => String(a.machineId) === targetId).forEach((a) => {
          if (a.copyFromAssetId) targetHas.add("id:" + String(a.copyFromAssetId));
          const su = String(a.sourceUrl ?? "").trim(); if (su) targetHas.add("url:" + su);
        });
        for (const x of parts) {
          if ((x.srcAssetId && targetHas.has("id:" + x.srcAssetId)) || (x.url && targetHas.has("url:" + x.url))) continue;
          await firestore.collection(A_COL).add({ name: x.name ?? "video", sourceUrl: x.url, presetId: x.presetId, machineId: targetId, status: "pending", createdAt: nowC, createdBy: user.email, source: "move-autocopy",
            ...(copyFromUrl2 && x.srcAssetId ? { copyFromUrl: copyFromUrl2, copyFromAssetId: x.srcAssetId } : {}) });
          if (x.srcAssetId) targetHas.add("id:" + x.srcAssetId);
          if (x.url) targetHas.add("url:" + x.url);
        }
        const execC = await firestore.collection("liveMoveExecutions").add({
          streamId: id, streamName: sData.name ?? "", moveType: "manual_autocopy_move", trigger: "manual",
          sourceMachineId: String(sData.machineId ?? ""), targetMachineId: targetId, reason: String(body.reason ?? "").slice(0, 200),
          startedAt: nowC, state: "copying_video", initiatedBy: user.email, initiatedByName: String((user as any).name ?? user.email),
        });
        await firestore.collection(S_COL).doc(id).set({
          moveState: "copying_video", moveSourceId: String(sData.machineId ?? ""), moveTargetId: targetId,
          moveType: "manual_autocopy_move", movePrevAssetIds: ids0, moveMode: body.mode === "emergency" ? "emergency" : "planned",
          moveExecId: execC.id, moveStartedAt: nowC, moveCopyDeadlineAt: new Date(Date.now() + COPY_WAIT_SEC() * 1000).toISOString(), updatedAt: nowC,
        }, { merge: true });
        await logAudit(firestore, { action: "live_move_autocopy", entityType: "liveStream", entityId: id, performedBy: user.email, detail: `chuyển "${sData.name}" → máy ${cand?.name ?? targetId} (tự copy video trước)` });
        return NextResponse.json({ ok: true, copying: true });
      }
      // Tính SẴN assetId trên máy đích (mỗi máy 1 id riêng cho cùng video) — cutover sẽ đổi sang id này.
      const targetAssetIds = remapAssetIdsToTarget(sData, targetId, aAll as any);
      if (!targetAssetIds) return NextResponse.json({ error: "Máy đích chưa có đủ bản sao video sẵn sàng của luồng." }, { status: 400 });
      const prevAssetIds: string[] = Array.isArray(sData.assetIds) && sData.assetIds.length ? sData.assetIds : (sData.assetId ? [sData.assetId] : []);
      // KHỞI ĐỘNG chuyển: đặt moveState=stopping_source (agent sẽ bảo máy NGUỒN dừng luồng này).
      const now = nowISO();
      const exec = await firestore.collection("liveMoveExecutions").add({
        streamId: id, streamName: sData.name ?? "", moveType: body.mode === "emergency" ? "manual_emergency_move" : "manual_safe_move",
        trigger: "manual", sourceMachineId: String(sData.machineId ?? ""), targetMachineId: targetId,
        reason: String(body.reason ?? "").slice(0, 200), startedAt: now, state: "stopping_source",
        initiatedBy: user.email, initiatedByName: String((user as any).name ?? user.email),
      });
      await firestore.collection(S_COL).doc(id).set({
        moveState: "stopping_source", moveSourceId: String(sData.machineId ?? ""), moveTargetId: targetId,
        moveType: body.mode === "emergency" ? "manual_emergency_move" : "manual_safe_move",
        moveTargetAssetIds: targetAssetIds, movePrevAssetIds: prevAssetIds,   // ánh xạ video đích + để hoàn tác
        moveExecId: exec.id, moveStartedAt: now, moveDeadlineAt: new Date(Date.now() + MOVE_TIMEOUT_SEC() * 1000).toISOString(),
        updatedAt: now,
      }, { merge: true });
      await logAudit(firestore, { action: "live_move_start", entityType: "liveStream", entityId: id, performedBy: user.email, detail: `chuyển "${sData.name}" → máy ${cand.name}` });
      return NextResponse.json({ ok: true, execId: exec.id });
    }

    // ── HIỆN khoá luồng đầy đủ (ẩn mặc định như mật khẩu; chỉ luồng TRONG PHẠM VI + ghi audit) ──
    if (action === "get_stream_key") {
      const id = String(body.id ?? ""); if (!id) return NextResponse.json({ error: "Thiếu id luồng." }, { status: 400 });
      const cur = await firestore.collection(S_COL).doc(id).get();
      if (!cur.exists) return NextResponse.json({ error: "Luồng không tồn tại." }, { status: 404 });
      const s: any = cur.data();
      if (!(await ownsEntity(s.createdBy))) return NextResponse.json({ error: "Bạn không có quyền xem khoá luồng này." }, { status: 403 });
      await logAudit(firestore, { action: "live_reveal_stream_key", entityType: "liveStream", entityId: id, performedBy: user.email, detail: `xem khoá: ${s.name ?? ""}` });
      return NextResponse.json({ ok: true, streamKey: s.streamKey ?? "" });
    }

    // ── Lấy TOKEN TẢI-LÊN theo yêu cầu (S0 bảo mật) — thay vì phát token trong mọi lần polling.
    //    Chỉ người được cấp quyền vận hành Live; viewingAs đã bị chặn ở đầu POST. Ghi audit để biết
    //    ai đã lấy (nhất là khi xem lệnh cài đặt VPS). Token này CHỈ cho tải file lên máy, không đụng
    //    luồng/YouTube/dữ liệu. Client tự gọi đúng lúc cần (kéo-thả tải, hoặc admin xem lệnh cài).
    if (action === "upload_token") {
      if (!canOperateLive(user)) return NextResponse.json({ error: "Bạn không có quyền tải video lên máy live." }, { status: 403 });
      const tok = process.env.RISE_LIVE_UPLOAD_TOKEN;
      if (!tok) return NextResponse.json({ error: "Chưa bật tải-lên (thiếu RISE_LIVE_UPLOAD_TOKEN)." }, { status: 400 });
      const forInstall = body.forInstall === true;
      // Tải THẲNG lên VPS: nếu giao diện có nói rõ máy đích thì gác luôn ở đây.
      // (Xem lệnh cài đặt VPS thì KHÔNG gác — lúc đó chưa tải gì.)
      const mIdUp = String(body.machineId ?? "").trim();
      if (!forInstall && mIdUp) {
        const mSnap = await firestore.collection(M_COL).doc(mIdUp).get().catch(() => null);
        const chan = intakeBlock(mSnap?.exists ? { id: mIdUp, ...(mSnap.data() as any) } : null);
        if (chan) return NextResponse.json({ error: chan }, { status: 400 });
      }
      await logAudit(firestore, { action: "live_upload_token_issued", entityType: "liveUpload", entityId: "-", performedBy: user.email, detail: forInstall ? "xem lệnh cài đặt VPS (token tải-lên)" : "lấy token để tải video" }).catch(() => {});
      return NextResponse.json({ ok: true, token: tok, port: Number(process.env.RISE_LIVE_UPLOAD_PORT) || 8099 });
    }

    // ── NÚT TẮT KHẨN cơ chế TỰ CỨU (nghiệm thu R0 #11) ──────────────────────────
    //    Chỉ dừng phần TỰ CHUYỂN máy. Luồng đang phát VẪN PHÁT, cảnh báo VẪN CHẠY.
    //    Dùng khi cơ chế tự cứu chạy sai và cần dừng NGAY mà không được đụng vào
    //    các luồng đang lên sóng. Chỉ Admin hạ tầng.
    if (action === "set_failover_off") {
      if (!isBLD(user) && !(await resolveLivePermsFor(user)).has("live.worker.manage")) return NextResponse.json({ error: "Chỉ Admin hạ tầng được bật/tắt cơ chế tự cứu." }, { status: 403 });
      const tat = body.off === true;
      const lyDo = String(body.reason ?? "").trim().slice(0, 300);
      if (tat && !lyDo) return NextResponse.json({ error: "Cho biết lý do tắt (để người sau hiểu vì sao)." }, { status: 400 });
      await firestore.collection("liveSettings").doc("failover").set(
        tat
          ? { disabled: true, disabledBy: user.email, disabledAt: nowISO(), reason: lyDo }
          : { disabled: false, enabledBy: user.email, enabledAt: nowISO(), reason: "" },
        { merge: true });
      await logAudit(firestore, { action: tat ? "live_failover_off" : "live_failover_on", entityType: "liveSettings", entityId: "failover", performedBy: user.email, detail: tat ? `TẮT tự cứu — ${lyDo}` : "BẬT lại tự cứu" });
      return NextResponse.json({ ok: true, disabled: tat });
    }

    // ── Xoá VIDEO (chỉ khi không luồng nào dùng) — worker sẽ tự xoá file trên VPS để dọn ổ ──
    if (action === "delete_asset") {
      const id = String(body.id ?? ""); if (!id) return NextResponse.json({ error: "Thiếu id." }, { status: 400 });
      const aDoc = await firestore.collection(A_COL).doc(id).get();
      if (aDoc.exists && !(await ownsEntity((aDoc.data() as any).createdBy))) return NextResponse.json({ error: "Bạn không có quyền với video này." }, { status: 403 });
      // Chặn xoá nếu video đang được luồng nào dùng: video ĐƠN (assetId) HOẶC là 1 thành viên của
      // DANH SÁCH PHÁT (assetIds) — trước đây chỉ dò assetId nên xoá lọt video giữa playlist → vỡ luồng.
      const [uSnap, uSnap2] = await Promise.all([
        firestore.collection(S_COL).where("assetId", "==", id).limit(1).get().catch(() => null),
        firestore.collection(S_COL).where("assetIds", "array-contains", id).limit(1).get().catch(() => null),
      ]);
      if ((uSnap && !uSnap.empty) || (uSnap2 && !uSnap2.empty)) return NextResponse.json({ error: "Video đang được 1 luồng dùng — xoá luồng trước." }, { status: 400 });
      // KHOÁ bản DỰ PHÒNG của luồng ƯU TIÊN (Chủ Rise Group 27/08/2026): xoá nhầm bản này là luồng
      // ưu tiên mất lưới an toàn NGAY, mà người xoá không biết mình vừa làm gì. Chặn từ đầu.
      {
        const [allS2, allA2] = await Promise.all([
          firestore.collection(S_COL).limit(2000).get().catch(() => null),
          firestore.collection(A_COL).limit(2000).get().catch(() => null),
        ]);
        const lk = assetLockOf(id,
          (allS2?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) })),
          (allA2?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) })));
        if (lk.locked) return NextResponse.json({ error: lk.reason }, { status: 400 });
      }
      await firestore.collection(A_COL).doc(id).delete();
      await logAudit(firestore, { action: "live_delete_asset", entityType: "liveAsset", entityId: id, performedBy: user.email, detail: "xoá video (worker dọn file)" });
      return NextResponse.json({ ok: true });
    }

    // ═══ DỌN BẢN DỰ PHÒNG KHÔNG CÒN DÙNG ═══
    // Vấn đề Chủ Rise Group nêu (27/08/2026): luồng ưu tiên được hệ tự nhân bản video sang máy khác
    // làm dự phòng — hợp lý khi luồng đang chạy. Nhưng khi luồng DỪNG hoặc BỊ XOÁ thì các bản nhân
    // bản đó nằm lại vĩnh viễn, âm thầm ăn ổ cứng. Đo thực tế: 25 bản mồ côi = 84 GB.
    //
    // ⚠ CỐ Ý KHÔNG TỰ XOÁ. Chỉ LIỆT KÊ ra cho người xem rồi tự bấm dọn — xoá là không khôi phục
    // được, nhất là video tải tay (không có link Drive để tải lại). Hệ chỉ ghi nhận và đề xuất.
    if (action === "list_orphan_backups" || action === "cleanup_orphan_backups") {
      if (!canOperateLive(user)) return NextResponse.json({ error: "Bạn không có quyền." }, { status: 403 });
      const [aSnap, sSnap, mSnap] = await Promise.all([
        firestore.collection(A_COL).limit(2000).get().catch(() => null),
        firestore.collection(S_COL).limit(2000).get().catch(() => null),
        firestore.collection(M_COL).limit(50).get().catch(() => null),
      ]);
      const assetsAll = (aSnap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) })) as any[];
      const streamsAll = (sSnap?.docs ?? []).map((d) => ({ id: d.id, ...(d.data() as any) })) as any[];
      const mNames: Record<string, string> = {};
      (mSnap?.docs ?? []).forEach((d) => { mNames[d.id] = String((d.data() as any).name ?? d.id); });
      // Mọi video đang được BẤT KỲ luồng nào trỏ tới (kể cả luồng đã dừng — dừng rồi vẫn có thể bật lại).
      const referenced = new Set<string>();
      streamsAll.forEach((st: any) => {
        (Array.isArray(st.assetIds) && st.assetIds.length ? st.assetIds : [st.assetId]).filter(Boolean)
          .forEach((x: any) => referenced.add(String(x)));
      });
      // MỒ CÔI = bản do HỆ tự tạo + không luồng nào trỏ tới + bản gốc của nó cũng không luồng nào dùng.
      // (Bản gốc còn được luồng dùng ⇒ bản dự phòng vẫn có lý do tồn tại ⇒ GIỮ.)
      // ⚠ LỖI ĐÃ SỬA (V67.2 — Chủ Rise Group phát hiện): rất nhiều bản dự phòng KHÔNG có trường
      // liên kết về bản gốc, chỉ TRÙNG LINK NGUỒN (vì bản đó tải lại từ Drive chứ không copy
      // máy-sang-máy). Chỉ so theo trường liên kết thì không nhận ra quan hệ → xếp NHẦM là mồ côi
      // và mời xoá, trong khi bản gốc VẪN đang phục vụ luồng. Nay so THÊM theo link nguồn, và cả
      // chiều ngược lại (bản đang dùng là bản sao của video này).
      const protectedUrls = new Set<string>();
      const protectedSrcIds = new Set<string>();
      assetsAll.forEach((x: any) => {
        if (!referenced.has(String(x.id))) return;
        const su = String(x.sourceUrl ?? "").trim(); if (su) protectedUrls.add(su);
        const cf = String(x.copyFromAssetId ?? "").trim(); if (cf) protectedSrcIds.add(cf);
      });
      const orphans = assetsAll.filter((a: any) =>
        (a.source === "auto-backup" || String(a.name ?? "").includes("(dự phòng)"))
        && !referenced.has(String(a.id))
        && !referenced.has(String(a.copyFromAssetId ?? ""))
        && !protectedSrcIds.has(String(a.id))
        && !(String(a.sourceUrl ?? "").trim() !== "" && protectedUrls.has(String(a.sourceUrl).trim())));

      if (action === "list_orphan_backups") {
        return NextResponse.json({
          ok: true,
          items: orphans
            .sort((a: any, b: any) => (Number(b.sizeMb) || 0) - (Number(a.sizeMb) || 0))
            .slice(0, 100)
            .map((a: any) => ({
              id: a.id, name: a.name ?? "", machineId: a.machineId ?? "",
              machineName: mNames[String(a.machineId)] ?? String(a.machineId ?? ""),
              sizeMb: Math.round(Number(a.sizeMb) || 0), createdAt: a.createdAt ?? "",
              fromDrive: !!String(a.sourceUrl ?? "").trim(),   // có link Drive thì tải lại được
            })),
          totalCount: orphans.length,
          totalGb: Math.round((orphans.reduce((sum: number, a: any) => sum + (Number(a.sizeMb) || 0), 0) / 1024) * 10) / 10,
        });
      }

      // Dọn: chỉ xoá đúng những id người dùng gửi lên VÀ vẫn còn nằm trong danh sách mồ côi vừa tính
      // (chống trường hợp trong lúc xem thì có luồng mới dùng lại video đó).
      const want = (Array.isArray(body.ids) ? body.ids : []).map(String);
      const okIds = new Set(orphans.map((a: any) => String(a.id)));
      const toDelete = want.filter((x: string) => okIds.has(x));
      for (const id of toDelete) await firestore.collection(A_COL).doc(id).delete().catch(() => undefined);
      await logAudit(firestore, { action: "live_cleanup_backups", entityType: "liveAsset", entityId: toDelete.join(","), performedBy: user.email, detail: `dọn ${toDelete.length} bản dự phòng không còn dùng` });
      return NextResponse.json({ ok: true, deleted: toDelete.length, skipped: want.length - toDelete.length });
    }

    // ── Xoá LUỒNG (chỉ khi đã dừng) ──
    if (action === "delete_stream") {
      const id = String(body.id ?? ""); if (!id) return NextResponse.json({ error: "Thiếu id." }, { status: 400 });
      const sDoc = await firestore.collection(S_COL).doc(id).get();
      if (sDoc.exists && !(await ownsEntity((sDoc.data() as any).createdBy))) return NextResponse.json({ error: "Bạn không có quyền với luồng này." }, { status: 403 });
      const sdd: any = sDoc.exists ? sDoc.data() : null;
      if (sdd && (sdd.desiredState === "live" || (sdd.control === "schedule" && isWithinSchedule(sdd.schedule, Date.now()))))
        return NextResponse.json({ error: "Luồng đang chạy — dừng trước khi xoá." }, { status: 400 });
      await firestore.collection(S_COL).doc(id).delete();
      await logAudit(firestore, { action: "live_delete_stream", entityType: "liveStream", entityId: id, performedBy: user.email, detail: "xoá luồng" });
      return NextResponse.json({ ok: true });
    }

    // ── PHÂN QUYỀN RISE LIVE (R1 Đợt 2) — CHỈ Admin gán/liệt kê gói quyền cho người khác ──
    if (action === "list_live_permissions") {
      if (!canDelegateLive(user)) return NextResponse.json({ error: "Chỉ Admin hoặc Trưởng nhóm/phòng được quản lý quyền Live Rise." }, { status: 403 });
      const adminGrantor = isBLD(user);
      const [aSnap, uSnap] = await Promise.all([
        firestore.collection(PERM_COL).limit(500).get().catch(() => null),
        firestore.collection("users").where("status", "==", "active").limit(1000).get().catch(() => null),
      ]);
      // Trưởng nhóm/phòng: chỉ thấy + gán người TRONG phạm vi mình (cùng cây getVisibleUserEmails).
      let inScope = (_em: string) => true;
      if (!adminGrantor) {
        const vis = await getVisibleUserEmails(user);
        const visSet = vis ? new Set(Array.from(vis).map((e) => String(e).toLowerCase())) : null;
        inScope = (em: string) => !!visSet && visSet.has(String(em).toLowerCase());
      }
      const assignments = (aSnap?.docs ?? []).map((d) => ({ email: d.id, ...(d.data() as any) })).filter((a) => inScope(a.email));
      // MỌI nhân sự đang làm việc (trừ đối tác), trong phạm vi người gán.
      const candidates = (uSnap?.docs ?? []).map((d) => d.data() as any)
        .filter((u) => u.email && u.role !== "partner" && inScope(u.email))
        .map((u) => ({ email: u.email, name: u.fullName ?? u.name ?? u.email, role: u.role, unit: u.unit ?? "", hasLive: u.role === "admin" || (Array.isArray(u.extraPermissions) && u.extraPermissions.includes("riseLive")) }))
        .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name), "vi"));
      // Gói được cấp: Admin → tất cả; Trưởng nhóm/phòng → CHỈ Vận hành + Quản lý phạm vi (không tech/admin).
      const grantable = LIVE_PACKAGES.filter((p) => adminGrantor || p.id === "operate" || p.id === "scope");
      return NextResponse.json({ ok: true, perms2On: PERMS2_ON(), canGrantAll: adminGrantor, assignments, candidates, packages: grantable.map((p) => ({ id: p.id, label: p.label, desc: p.desc })), scopes: SCOPE_IDS });
    }
    if (action === "set_live_permissions") {
      if (!canDelegateLive(user)) return NextResponse.json({ error: "Chỉ Admin hoặc Trưởng nhóm/phòng được gán quyền Live Rise." }, { status: 403 });
      const adminGrantor = isBLD(user);
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!email) return NextResponse.json({ error: "Thiếu email người được gán." }, { status: 400 });
      const packages = (Array.isArray(body.packages) ? body.packages : []).filter((p: any) => PKG_IDS.includes(p));
      const scope: LiveScope = SCOPE_IDS.includes(body.scope) ? body.scope : "assigned_channels";
      const effectiveFrom = String(body.effectiveFrom ?? "").trim() || null;
      const effectiveTo = String(body.effectiveTo ?? "").trim() || null;
      // Trưởng nhóm/phòng: chỉ trong phạm vi + chỉ gói operate/scope + KHÔNG đụng người đang có gói cao (tech/admin).
      if (!adminGrantor) {
        const vis = await getVisibleUserEmails(user);
        const visSet = vis ? new Set(Array.from(vis).map((e) => String(e).toLowerCase())) : null;
        if (!visSet || !visSet.has(email)) return NextResponse.json({ error: "Bạn chỉ cấp quyền cho người TRONG phạm vi mình quản lý." }, { status: 403 });
        if (packages.some((p: string) => p !== "operate" && p !== "scope")) return NextResponse.json({ error: "Trưởng nhóm chỉ cấp gói Vận hành / Quản lý phạm vi (gói Kỹ thuật/Quản trị do Admin cấp)." }, { status: 403 });
        const curDoc = await firestore.collection(PERM_COL).doc(email).get().catch(() => null);
        const curPkgs: string[] = curDoc?.exists && Array.isArray((curDoc.data() as any).packages) ? (curDoc.data() as any).packages : [];
        if (curPkgs.some((p) => p === "tech" || p === "admin")) return NextResponse.json({ error: "Người này đang có quyền cấp cao (Kỹ thuật/Quản trị) — nhờ Admin chỉnh." }, { status: 403 });
      }
      if (packages.length === 0) {
        // GỠ: nếu grant từng TỰ bật riseLive thì gỡ lại (không đụng riseLive do Admin tự tích).
        const prev = await firestore.collection(PERM_COL).doc(email).get().catch(() => null);
        if (prev?.exists && (prev.data() as any).grantedRiseLive) await setUserRiseLive(email, false);
        await firestore.collection(PERM_COL).doc(email).delete().catch(() => {});
        await logAudit(firestore, { action: "live_set_permissions", entityType: "livePermission", entityId: email, performedBy: user.email, detail: "gỡ mọi gói quyền Live Rise" });
        return NextResponse.json({ ok: true });
      }
      // Bước 3: cấp gói → TỰ bật quyền vào Live Rise (hiện menu). Nhớ grant có tự thêm riseLive không.
      const addedRiseLive = await setUserRiseLive(email, true);
      const prev = await firestore.collection(PERM_COL).doc(email).get().catch(() => null);
      const grantedRiseLive = (prev?.exists && (prev.data() as any).grantedRiseLive === true) || addedRiseLive;
      await firestore.collection(PERM_COL).doc(email).set({ email, packages, scope, effectiveFrom, effectiveTo, grantedBy: user.email, grantedRiseLive, updatedAt: nowISO() }, { merge: true });
      await logAudit(firestore, { action: "live_set_permissions", entityType: "livePermission", entityId: email, performedBy: user.email, detail: `gói [${packages.join(", ")}] · phạm vi ${scope}${adminGrantor ? "" : " (Trưởng nhóm cấp)"}` });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Hành động không hợp lệ." }, { status: 400 });
  } catch (error: any) {
    if (isUnauthorized(error)) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
    console.error("POST /api/live failed", error);
    return NextResponse.json({ error: error?.message ?? "Lỗi máy chủ." }, { status: 500 });
  }
}
