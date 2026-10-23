// RISE LIVE — Dự phòng nhiều VPS · ĐỢT 2 nhịp 1 (CHỈ ĐỌC, không đụng worker). Nhận biết "dự phòng
// THỰC TẾ" của một luồng: video của luồng đã có bản SẴN SÀNG trên MÁY KHÁC chưa (để có thể cứu
// luồng sang máy đó). Suy từ dữ liệu SẴN CÓ: 2 bản ghi liveAssets cùng `sourceUrl` = cùng 1 video
// logic. Chưa có checksum thật (worker sẽ báo ở nhịp sau) — nên đây là mức "có bản sao", chưa xác
// thực toàn vẹn. Thiết kế R0 mục 4c/8: "Luồng ưu tiên chưa có khả năng dự phòng thực tế".

export interface ReplicaAssetLike { id: string; machineId?: string; sourceUrl?: string; status?: string; }
export interface ReplicaStreamLike { id: string; machineId?: string; assetId?: string; assetIds?: string[]; importance?: string; }
export interface ReplicaMachineLike { id: string; name?: string; failureDomain?: string; provider?: string; online?: boolean; maintenance?: boolean; }

export interface BackupStatus {
  hasReplica: boolean;               // có MÁY KHÁC giữ đủ video của luồng (sẵn sàng)
  backupMachineNames: string[];      // các máy có thể nhận
  differentFailureDomain: boolean;   // có ít nhất 1 máy dự phòng KHÁC vùng lỗi (an toàn hơn)
  reason: string;
}

const fdOf = (m?: ReplicaMachineLike) => String(m?.failureDomain ?? m?.provider ?? "");
const streamAssetIds = (s: ReplicaStreamLike): string[] =>
  Array.isArray(s.assetIds) && s.assetIds.length ? s.assetIds : (s.assetId ? [s.assetId] : []);

// Trạng thái dự phòng của 1 luồng: có MÁY KHÁC nào giữ ĐỦ (sẵn sàng) mọi video của luồng không.
export function streamBackupStatus(
  stream: ReplicaStreamLike,
  assets: ReplicaAssetLike[],
  machineById: Record<string, ReplicaMachineLike>,
): BackupStatus {
  const srcMachineId = String(stream.machineId ?? "");
  const ids = streamAssetIds(stream);
  if (!ids.length) return { hasReplica: false, backupMachineNames: [], differentFailureDomain: false, reason: "Luồng chưa gắn video" };

  // sourceUrl của từng video luồng đang dùng (lấy từ asset trên MÁY NGUỒN).
  const wantUrls: string[] = [];
  for (const aid of ids) {
    const a = assets.find((x) => x.id === aid);
    const u = String(a?.sourceUrl ?? "").trim();
    if (u) wantUrls.push(u);
  }
  if (!wantUrls.length || wantUrls.length < ids.length) {
    return { hasReplica: false, backupMachineNames: [], differentFailureDomain: false, reason: "Không đọc được nguồn video" };
  }

  // Với mỗi MÁY KHÁC: có giữ SẴN SÀNG đủ mọi sourceUrl luồng cần không?
  // CHỈ tính máy CÒN TỒN TẠI (30/08/2026). Xoá một máy KHÔNG dọn video của máy đó → bản ghi video
  // "mồ côi" ở lại (đo thật: xoá VPS 06 để lại 7 bản ghi). Nếu đếm cả máy đã xoá thì hệ báo luồng
  // ưu tiên "đã có bản dự phòng" trong khi bản đó nằm trên một máy KHÔNG CÒN — đúng kiểu sai nguy
  // hiểm nhất: tưởng có lưới an toàn nên không ai làm gì, tới lúc sự cố mới biết là không có.
  // MÁY PHẢI CÒN SỐNG VÀ KHÔNG BẢO TRÌ (30/08/2026 — Chủ Rise Group duyệt).
  // Trước đây chỉ hỏi "máy còn tồn tại và có đủ video sẵn sàng không", KHÔNG hỏi máy đó còn sống
  // không. Nên bản dự phòng nằm trên một máy ĐÃ CHẾT vẫn hiện "đã có dự phòng" — sai đúng vào lúc
  // cần đúng nhất: lúc một máy sập, người trực nhìn màn hình tưởng có lưới an toàn nên không làm gì.
  // Máy đang BẢO TRÌ cũng vậy: nó đã bị loại khỏi danh sách nhận luồng (live-move BLOCKING_STATES,
  // failover cands, chặn gán luồng mới) nên không thể cứu ai — coi nó là nơi giữ dự phòng là tự lừa.
  // (Hàm này chỉ dùng để HIỂN THỊ — không quyết định gì tự động, nên siết ở đây không đổi hành vi máy.)
  const dungDuoc = (mid: string): boolean => {
    const m = machineById[mid];
    return !!m && m.online !== false && m.maintenance !== true;
  };
  const otherMachineIds = Array.from(new Set(
    assets.filter((a) => String(a.machineId ?? "") && String(a.machineId) !== srcMachineId && dungDuoc(String(a.machineId)))
      .map((a) => String(a.machineId)),
  ));
  const viable: string[] = [];
  for (const mid of otherMachineIds) {
    const ready = new Set(assets.filter((a) => String(a.machineId) === mid && a.status === "ready").map((a) => String(a.sourceUrl ?? "").trim()));
    if (wantUrls.every((u) => ready.has(u))) viable.push(mid);
  }
  if (!viable.length) return { hasReplica: false, backupMachineNames: [], differentFailureDomain: false, reason: "Chưa có bản sao video trên máy khác" };

  const srcFd = fdOf(machineById[srcMachineId]);
  const names = viable.map((mid) => String(machineById[mid]?.name ?? "Máy"));
  const diffFd = viable.some((mid) => { const fd = fdOf(machineById[mid]); return fd && srcFd && fd !== srcFd; });
  return {
    hasReplica: true,
    backupMachineNames: names,
    differentFailureDomain: diffFd,
    reason: diffFd ? `Có bản sao trên: ${names.join(", ")} (có máy khác nhà cung cấp — an toàn)` : `Có bản sao trên: ${names.join(", ")} (⚠ cùng nhà cung cấp với máy nguồn)`,
  };
}

// Tóm tắt dự phòng cho các luồng ƯU TIÊN (priority/critical) đang phát — để cảnh báo "chưa có dự
// phòng thực tế". Trả về danh sách luồng ưu tiên thiếu bản sao.
export function priorityBackupGaps(
  streams: ReplicaStreamLike[],
  assets: ReplicaAssetLike[],
  machines: ReplicaMachineLike[],
): { streamId: string; reason: string }[] {
  const byId: Record<string, ReplicaMachineLike> = {};
  machines.forEach((m) => { byId[m.id] = m; });
  const isPriority = (s: ReplicaStreamLike) => s.importance === "priority" || s.importance === "critical" || (s.importance == null && (s as any).priority === true);
  return streams.filter(isPriority).map((s) => {
    const st = streamBackupStatus(s, assets, byId);
    return st.hasReplica && st.differentFailureDomain ? null : { streamId: s.id, reason: st.reason };
  }).filter(Boolean) as { streamId: string; reason: string }[];
}
