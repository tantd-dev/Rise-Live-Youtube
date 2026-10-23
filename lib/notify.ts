// Gửi THÔNG BÁO KẾT QUẢ dùng chung cho mọi luồng duyệt (chuông + push). Để mọi
// yêu cầu (nghỉ, mở lại báo cáo, chuyển nhóm, lý do nộp muộn...) khi được duyệt/
// từ chối đều báo lại cho người gửi — không ai phải tự vào hỏi.
// import { sendPushToUser } from "./web-push";

export async function notifyOutcome(
  firestore: any,
  emails: (string | null | undefined)[],
  opts: {
    eventType: string; label: string; tone?: string; actorEmail?: string;
    pushCategory?: "urgent" | "evaluation" | "deadline" | "leave";
    // noPush = CHỈ tạo chuông trong app + badge, KHÔNG đẩy ra điện thoại (cho tin nhẹ/tự-hồi-phục,
    // tránh rung điện thoại vì mấy blip đã tự khỏi). Chuông vẫn có để tra cứu.
    noPush?: boolean;
    // GOM PUSH: khi nhiều việc CÙNG LOẠI dồn tới (VD nhiều bài nhạc chờ duyệt), mỗi người chỉ
    // rung điện thoại tối đa 1 lần / throttleMinutes cho cùng throttleKey. CHUÔNG trong app +
    // badge module VẪN tạo/đếm đủ (không mất việc) — chỉ giảm spam đẩy ra điện thoại.
    throttleKey?: string; throttleMinutes?: number;
    // GỘP CHUÔNG (V64.92 — Chủ Rise Group: "gán 20 bài nhạc thì nhận 20 thông báo"). Khi nhiều việc
    // CÙNG LOẠI dồn tới trong ít phút, thay vì đẻ 20 dòng chuông thì GỘP vào 1 dòng và đếm số lượng.
    //  • groupKey    : cùng khoá + cùng nhóm người nhận + còn trong cửa sổ + CHƯA AI ĐỌC → gộp.
    //  • groupMinutes: cửa sổ gộp (mặc định 10 phút).
    //  • groupLabel  : nhãn khi đã gộp, VD (n) => `Bạn được gán ${n} bài nhạc`. Không truyền thì
    //                  tự ghép "…(+N việc nữa)".
    // Lợi ích kép: chuông sạch + giảm số bản ghi ghi vào cơ sở dữ liệu (đỡ tốn, đỡ nặng).
    groupKey?: string; groupMinutes?: number; groupLabel?: (count: number) => string;
  },
) {
  const recipients = Array.from(new Set((emails || []).filter(Boolean).map((e) => String(e).toLowerCase())));
  if (recipients.length === 0) return;
  const now = new Date().toISOString();
  let merged = false;
  if (opts.groupKey) {
    // Khoá gộp gồm CẢ nhóm người nhận → không gộp nhầm chuông của người khác.
    const gk = `${opts.groupKey}|${recipients.slice().sort().join(",")}`;
    const winMs = Math.max(1, Number(opts.groupMinutes ?? 10)) * 60000;
    try {
      // Chỉ lọc 1 trường (không orderBy) → dùng chỉ mục có sẵn, không cần tạo chỉ mục ghép.
      const snap = await firestore.collection("channelEvents").where("groupKey", "==", gk).limit(10).get();
      const recent = (snap?.docs ?? [])
        .map((d: any) => ({ id: d.id, ...(d.data() as any) }))
        .filter((e: any) => Date.now() - (Date.parse(String(e.createdAt ?? "")) || 0) < winMs)
        .filter((e: any) => !((e.readBy ?? []).length))   // đã đọc rồi thì để yên, tạo dòng mới
        .sort((a: any, b: any) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0];
      if (recent) {
        const count = Number(recent.groupCount ?? 1) + 1;
        await firestore.collection("channelEvents").doc(recent.id).set({
          groupCount: count,
          label: opts.groupLabel ? opts.groupLabel(count) : `${opts.label} (+${count - 1} việc nữa)`,
          createdAt: now,   // đẩy lên đầu danh sách chuông
        }, { merge: true });
        merged = true;
      }
    } catch { /* gộp lỗi thì tạo dòng mới như cũ — không được mất thông báo */ }
  }
  if (!merged) {
    await firestore.collection("channelEvents").add({
      ownerEmail: null,
      assignedEmails: recipients,
      eventType: opts.eventType,
      label: opts.label,
      tone: opts.tone ?? "blue",
      createdAt: now,
      actorEmail: opts.actorEmail ?? null,
      readBy: [],
      ...(opts.groupKey ? { groupKey: `${opts.groupKey}|${recipients.slice().sort().join(",")}`, groupCount: 1 } : {}),
    });
  }
  if (opts.noPush) return;   // chỉ chuông trong app — không đẩy điện thoại
  const nowMs = new Date(now).getTime();
  const windowMs = Math.max(1, Number(opts.throttleMinutes ?? 30)) * 60000;
  await Promise.all(recipients.map(async (email) => {
    if (opts.throttleKey) {
      const ref = firestore.collection("pushThrottle").doc(`${email}__${opts.throttleKey}`);
      try {
        const last = Number((await ref.get()).data()?.lastPushMs ?? 0);
        if (nowMs - last < windowMs) return; // trong cửa sổ → bỏ PUSH (chuông + badge đã có)
        await ref.set({ email, key: opts.throttleKey, lastPushMs: nowMs, lastPushAt: now }, { merge: true });
      } catch { /* lỗi throttle không được chặn push */ }
    }
    // await sendPushToUser(firestore, email, opts.pushCategory ?? "urgent");
  }));
}
