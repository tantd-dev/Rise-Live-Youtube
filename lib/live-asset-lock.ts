// KHOÁ VIDEO ĐANG (HOẶC SẼ) LÀM DỰ PHÒNG CHO LUỒNG ƯU TIÊN — chống xoá nhầm.
//
// Vì sao (Chủ Rise Group 27/08/2026): "khoá luôn video đang dự phòng hoặc sẽ là dự phòng cho
// luồng ưu tiên kẻo xoá nhầm". Chặn từ đầu tốt hơn dọn về sau — vì hệ CHỈ chuyển máy được khi
// máy đích ĐÃ CÓ SẴN video; xoá nhầm bản dự phòng là luồng ưu tiên mất lưới an toàn ngay lập tức,
// mà người xoá không hề biết mình vừa làm gì.
//
// PHẠM VI KHOÁ — cố ý hẹp, chỉ đúng chỗ rủi ro thật:
//   · Luồng phải là ƯU TIÊN (Ưu tiên / Rất quan trọng) VÀ đang chạy (hoặc trong khung giờ).
//   · Luồng Pub KHÔNG khoá — Pub không dùng cơ chế dự phòng.
//   · Khoá cả BẢN GỐC lẫn BẢN SAO, vì sau khi chuyển máy thì bản "gốc" lại thành dự phòng và
//     ngược lại — không có bản nào là "thừa".
// Luồng thường / đã dừng / đã xoá → KHÔNG khoá, dọn thoải mái (xem thẻ "Dọn bản dự phòng").

export type AssetLock = { locked: boolean; reason: string; streamName: string };

function isPriorityRunning(s: any): boolean {
  if (!s) return false;
  if (s.mode === "live-pub") return false;                       // Pub không dùng dự phòng
  const imp = String(s.importance || (s.priority ? "priority" : "normal"));
  if (imp !== "priority" && imp !== "critical") return false;
  // Luồng HẸN GIỜ cũng phải khoá dù chưa tới khung giờ — vì hệ tải sẵn dự phòng TRƯỚC giờ chạy,
  // và tới giờ là cần ngay. Chỉ luồng thực sự DỪNG HẲN (bật/tắt tay, đang tắt) mới mở khoá.
  return s.desiredState === "live" || !!s.scheduleActive || s.control === "schedule";
}

/** Mọi id video "thuộc về" một luồng: bản luồng đang dùng + mọi bản sao/bản gốc cùng nội dung. */
function relatedAssetIds(stream: any, assets: any[]): Set<string> {
  const out = new Set<string>();
  const direct = (Array.isArray(stream.assetIds) && stream.assetIds.length
    ? stream.assetIds
    : (stream.assetId ? [stream.assetId] : [])).map(String);
  direct.forEach((id: string) => out.add(id));

  // Bản GỐC của những bản luồng đang dùng (khi luồng đã chuyển sang chạy bằng bản sao).
  direct.forEach((id: string) => {
    const a = assets.find((x: any) => String(x.id) === id);
    const src = String(a?.copyFromAssetId ?? "").trim();
    if (src) out.add(src);
  });

  // Mọi bản SAO trỏ về bất kỳ id nào ở trên + mọi bản cùng link nguồn (video tải từ Drive).
  const urls = new Set<string>();
  Array.from(out).forEach((id) => {
    const a = assets.find((x: any) => String(x.id) === id);
    const su = String(a?.sourceUrl ?? "").trim();
    if (su) urls.add(su);
  });
  assets.forEach((x: any) => {
    const cf = String(x.copyFromAssetId ?? "").trim();
    const su = String(x.sourceUrl ?? "").trim();
    if ((cf && out.has(cf)) || (su && urls.has(su))) out.add(String(x.id));
  });
  return out;
}

/**
 * VIDEO HỎNG THÌ KHÔNG PHẢI LÀ BẢN DỰ PHÒNG (30/08/2026 — Chủ Rise Group phát hiện).
 *
 * Bản chép THẤT BẠI không có file, không cứu được luồng nào. Khoá nó lại chẳng bảo vệ được gì, mà
 * còn chặn đúng việc cần làm là dọn nó đi. Ca thật: luồng "30.08 Quiet Mind Live 247" nằm ở VPS 03
 * (máy chết), chép sang VPS 06 hỏng vì không tới được máy nguồn → dòng lỗi đó bị khoá, xoá không
 * được, dù nó chẳng che chở cho ai.
 *
 * Đây là cách hiểu ĐÃ ĐÚNG ở chỗ CHUYỂN MÁY (lib/live-move.ts chỉ nhận `status === "ready"`), chỉ
 * hai chỗ này quên xét: khoá-không-cho-xoá và tạo-bản-dự-phòng-tự-động.
 */
const banHong = (id: string, assets: any[]): boolean =>
  String((assets ?? []).find((a: any) => String(a?.id) === String(id))?.status ?? "") === "error";

/** Video này có đang bị khoá vì phục vụ luồng ưu tiên không? */
export function assetLockOf(assetId: string, streams: any[], assets: any[]): AssetLock {
  const id = String(assetId);
  if (banHong(id, assets)) return { locked: false, reason: "", streamName: "" };   // hỏng → cho dọn
  for (const s of streams ?? []) {
    if (!isPriorityRunning(s)) continue;
    if (relatedAssetIds(s, assets ?? []).has(id)) {
      const nm = String(s.name ?? "").slice(0, 60);
      return {
        locked: true,
        streamName: nm,
        reason: `Video này đang là bản chạy hoặc bản DỰ PHÒNG của luồng ưu tiên "${nm}". Xoá đi thì khi máy gặp sự cố sẽ KHÔNG chuyển máy được (mất sóng). Muốn xoá: hạ mức luồng về "Thường", hoặc dừng luồng trước.`,
      };
    }
  }
  return { locked: false, reason: "", streamName: "" };
}

/** Bản đồ khoá cho cả danh sách — dùng cho màn Kho video (khỏi tính lại từng dòng). */
export function assetLockMap(streams: any[], assets: any[]): Record<string, AssetLock> {
  const map: Record<string, AssetLock> = {};
  for (const s of streams ?? []) {
    if (!isPriorityRunning(s)) continue;
    const nm = String(s.name ?? "").slice(0, 60);
    relatedAssetIds(s, assets ?? []).forEach((id) => {
      if (map[id]) return;
      if (banHong(id, assets ?? [])) return;   // bản chép HỎNG không che chở ai → để dọn được
      map[id] = {
        locked: true,
        streamName: nm,
        reason: `Đang phục vụ luồng ưu tiên "${nm}" (bản chạy hoặc bản dự phòng).`,
      };
    });
  }
  return map;
}
