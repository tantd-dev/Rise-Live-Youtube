// Chuẩn hóa audit log theo đúng mục 19 bản đặc tả GD (Kênh/Phân công/Báo
// cáo/Doanh thu). Ghi đồng thời cả field chuẩn theo đặc tả (performedBy,
// performedAt, fieldChanged, oldValue, newValue, reason) LẪN field cũ đang
// được dùng rải rác trong code (actorEmail, createdAt, detail) để không phá
// vỡ các chỗ đang đọc theo format cũ — không cần sửa lại toàn bộ code cũ
// cùng lúc, giảm rủi ro.

export const AUDIT_ACTIONS = {
  CHANNEL_CREATED: "CHANNEL_CREATED",
  CHANNEL_ASSIGNED: "CHANNEL_ASSIGNED",
  CHANNEL_TRANSFERRED: "CHANNEL_TRANSFERRED",
  CHANNEL_UNASSIGNED: "CHANNEL_UNASSIGNED",
  CHANNEL_ARCHIVED: "CHANNEL_ARCHIVED",
  CHANNEL_RESTORED: "CHANNEL_RESTORED",
  REPORT_CREATED: "REPORT_CREATED",
  REPORT_UPDATED: "REPORT_UPDATED",
  REPORT_SUBMITTED: "REPORT_SUBMITTED",
  REPORT_APPROVED: "REPORT_APPROVED",
  REVENUE_ADJUSTMENT_REQUESTED: "REVENUE_ADJUSTMENT_REQUESTED",
  REVENUE_ADJUSTMENT_APPROVED: "REVENUE_ADJUSTMENT_APPROVED",
  REVENUE_ADJUSTMENT_REJECTED: "REVENUE_ADJUSTMENT_REJECTED",
  API_SYNCED: "API_SYNCED",
  MANUAL_OVERRIDE: "MANUAL_OVERRIDE",
  RESPONSIBLE_USER_ASSIGNED: "RESPONSIBLE_USER_ASSIGNED",
  RESPONSIBLE_USER_CORRECTED: "RESPONSIBLE_USER_CORRECTED",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export async function logAudit(
  firestore: any,
  params: {
    action: AuditAction | string;
    entityType: string;
    entityId: string;
    performedBy: string;
    detail: string;
    fieldChanged?: string;
    oldValue?: any;
    newValue?: any;
    reason?: string;
  },
) {
  const now = new Date().toISOString();
  await firestore.collection("auditLogs").add({
    // Field chuẩn theo đặc tả
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    performedBy: params.performedBy,
    performedAt: now,
    fieldChanged: params.fieldChanged ?? null,
    oldValue: params.oldValue ?? null,
    newValue: params.newValue ?? null,
    reason: params.reason ?? "",
    // Field cũ giữ tương thích ngược cho các chỗ code/UI cũ đang đọc
    actorEmail: params.performedBy,
    createdAt: now,
    detail: params.detail,
  });
}
