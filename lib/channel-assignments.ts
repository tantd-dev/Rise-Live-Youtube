export type ChannelAssignment = {
  ownerEmail: string;
  owner: string;
  unit: string;
  startDate: string;
  endDate?: string;
  changedAt: string;
  changedBy: string;
  reason?: string;
};

export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export function tomorrowUtc() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function previousDate(dateText: string) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function assignmentsOf(channel: any): ChannelAssignment[] {
  const history = Array.isArray(channel.assignmentHistory)
    ? channel.assignmentHistory
        .map((item: any) => ({
          ownerEmail: String(item.ownerEmail ?? "").toLowerCase(),
          owner: String(item.owner ?? ""),
          unit: String(item.unit ?? channel.unit ?? ""),
          startDate: String(item.startDate ?? "").slice(0, 10),
          endDate: item.endDate ? String(item.endDate).slice(0, 10) : undefined,
          changedAt: String(item.changedAt ?? channel.createdAt ?? ""),
          changedBy: String(item.changedBy ?? channel.createdBy ?? ""),
          reason: item.reason ? String(item.reason) : undefined,
        }))
        .filter((item: ChannelAssignment) => item.ownerEmail && item.startDate)
    : [];

  if (history.length) {
    return history.sort((a: ChannelAssignment, b: ChannelAssignment) =>
      a.startDate.localeCompare(b.startDate),
    );
  }

  const ownerEmail = String(channel.ownerEmail ?? "").toLowerCase();
  if (!ownerEmail) return [];
  return [{
    ownerEmail,
    owner: String(channel.owner ?? ownerEmail),
    unit: String(channel.unit ?? ""),
    startDate: String(channel.createdAt ?? todayUtc()).slice(0, 10),
    changedAt: String(channel.createdAt ?? new Date().toISOString()),
    changedBy: String(channel.createdBy ?? ownerEmail),
    reason: "Phân công ban đầu",
  }];
}

export function assignmentAt(channel: any, dateText: string) {
  const date = String(dateText).slice(0, 10);
  const history = assignmentsOf(channel);
  return [...history]
    .reverse()
    .find((item) =>
      item.startDate <= date && (!item.endDate || item.endDate >= date),
    ) ?? null;
}

// YouTube thường chốt số liệu chậm khoảng 48 giờ. Với kênh mới được đưa
// vào hệ thống, ngày số liệu đầu tiên có thể sớm hơn ngày ghi nhận phân công
// tối đa 2 ngày. Chỉ nới đúng cửa sổ này, không mở quyền cho lịch sử xa hơn.
export function reportAssignmentAt(channel: any, dateText: string, lagDays = 2) {
  const exact = assignmentAt(channel, dateText);
  if (exact) return exact;
  const history = assignmentsOf(channel);
  if (!history.length) return null;
  const first = history[0];
  const reportDate = new Date(`${String(dateText).slice(0, 10)}T00:00:00Z`);
  const firstDate = new Date(`${first.startDate}T00:00:00Z`);
  const difference = Math.round((firstDate.getTime() - reportDate.getTime()) / 86400000);
  return difference >= 1 && difference <= lagDays ? first : null;
}

export function activeAssignment(channel: any) {
  return assignmentAt(channel, todayUtc());
}

// ============================================================
// GIAI ĐOẠN 1 — Tách "phân công" thành collection riêng
// (channelAssignments), CHẠY SONG SONG với assignmentHistory cũ
// (không xóa/thay thế ngay) để an toàn dữ liệu. Mỗi lần
// assignmentHistory của kênh thay đổi (tạo/xóa/khôi phục/chuyển
// giao), gọi syncChannelAssignments() để đồng bộ collection mới
// theo đúng mảng assignmentHistory hiện tại — idempotent, gọi lại
// nhiều lần không tạo trùng, dùng doc ID xác định theo
// channelId + startDate.
// ============================================================
export async function syncChannelAssignments(firestore: any, channelId: string, history: ChannelAssignment[]) {
  const batch = firestore.batch();
  const existingSnap = await firestore
    .collection("channelAssignments")
    .where("channelId", "==", channelId)
    .get();
  const existingIds = new Set(existingSnap.docs.map((d: any) => d.id));
  const seenIds = new Set<string>();
  history.forEach((item, index) => {
    const id = `${channelId}_${item.startDate}_${index}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    seenIds.add(id);
    const ref = firestore.collection("channelAssignments").doc(id);
    batch.set(ref, {
      channelId,
      userId: item.ownerEmail,
      userName: item.owner,
      unit: item.unit,
      assignedFrom: item.startDate,
      assignedTo: item.endDate ?? null,
      status: item.endDate ? "ended" : "active",
      createdBy: item.changedBy,
      createdAt: item.changedAt,
      endedBy: item.endDate ? item.changedBy : null,
      endedAt: item.endDate ? item.changedAt : null,
      reason: item.reason ?? "",
    }, { merge: true });
  });
  // Dọn các bản ghi cũ không còn khớp (vd sau khi đóng lịch sử lúc khôi
  // phục kênh) — chỉ xóa những gì KHÔNG còn khớp với history hiện tại,
  // không đụng gì tới assignmentHistory gốc trên channel doc.
  existingIds.forEach((id) => {
    if (!seenIds.has(id as string)) {
      batch.delete(firestore.collection("channelAssignments").doc(id as string));
    }
  });
  await batch.commit();
  return Array.from(seenIds);
}

// Tìm đúng assignmentId (trong collection mới) khớp với 1 assignment cụ
// thể (dùng khi ghi báo cáo, để lưu assignmentIdAtReportDate).
export function assignmentDocId(channelId: string, history: ChannelAssignment[], assignment: ChannelAssignment) {
  const index = history.findIndex(
    (item) => item.startDate === assignment.startDate && item.ownerEmail === assignment.ownerEmail,
  );
  if (index < 0) return null;
  return `${channelId}_${assignment.startDate}_${index}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}
