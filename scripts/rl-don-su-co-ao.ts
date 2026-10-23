// DỌN BẢN GHI SỰ CỐ ẢO do lỗi worker r2.36 (30/08/2026).
// Xem trước:  npx tsx scripts/rl-don-su-co-ao.ts
// Xoá thật:   npx tsx scripts/rl-don-su-co-ao.ts --xoa
//
// LỖI: r2.36 thêm phần "nhận lại luồng" khi kéo worker. Luồng nhận lại không có ống đọc tiến độ nên
// mốc "lần cuối biết nó còn sống" bị đóng băng ở lúc nhận lại. Luồng chỉ cần chớp một cái là hệ tính
// "mất sóng = toàn bộ thời gian từ lúc nhận lại" → ra 119, 155, 162, 172 phút. Toàn bộ là SỐ ẢO;
// luồng chỉ chớp vài giây. Đã sửa ở r2.37, nhưng bản ghi đã lưu thì phải dọn tay.
//
// CHỈ XOÁ bản ghi thoả CẢ HAI điều kiện — không đụng bất kỳ bản ghi thật nào:
//   1. Xảy ra TRONG cửa sổ lỗi (sau khi worker nhận lại luồng, trước khi lên r2.37)
//   2. Số "mất sóng" vượt ngưỡng vô lý (mặc định 10 phút)
import { firestore } from "@/lib/firestore";

const XOA = process.argv.includes("--xoa");
// Cửa sổ lỗi: từ lúc worker r2.36 được kéo (29/08 17:26 UTC) tới lúc chạy script.
const TU = process.env.RL_CUA_SO_TU || "2026-08-29T17:00:00.000Z";
const NGUONG_GIAY = Number(process.env.RL_NGUONG_GIAY) || 600;   // >10 phút = vô lý

async function main() {
  const s = await firestore.collection("liveStreams").get();
  let soLuong = 0, soBanGhi = 0;
  const viDu: string[] = [];
  const canSua: { id: string; ten: string; giu: any[]; bo: any[] }[] = [];

  s.docs.forEach((d) => {
    const x: any = d.data();
    const evs: any[] = Array.isArray(x.recentIncidents) ? x.recentIncidents : [];
    if (!evs.length) return;
    const bo = evs.filter((e: any) => String(e.at ?? "") >= TU && Number(e.downSec ?? 0) > NGUONG_GIAY);
    if (!bo.length) return;
    const giu = evs.filter((e: any) => !bo.includes(e));
    soLuong++; soBanGhi += bo.length;
    canSua.push({ id: d.id, ten: String(x.name ?? d.id), giu, bo });
    bo.forEach((e: any) => {
      if (viDu.length < 12) viDu.push(`  "${String(x.name ?? "").slice(0, 28).padEnd(30)}" ${String(e.at).slice(0, 19)}  mất sóng ${(Number(e.downSec) / 60).toFixed(1)} phút`);
    });
  });

  console.log(`Cửa sổ lỗi: từ ${TU}   ·   ngưỡng vô lý: > ${NGUONG_GIAY} giây (${(NGUONG_GIAY / 60).toFixed(0)} phút)\n`);
  console.log(`Sẽ xoá ${soBanGhi} bản ghi sự cố ảo, trên ${soLuong} luồng.\n`);
  if (viDu.length) { console.log("=== VÍ DỤ ==="); viDu.forEach((v) => console.log(v)); }

  // Đối chứng: còn bao nhiêu bản ghi THẬT được giữ lại (để chắc là không xoá nhầm cả kho).
  const tongGiu = canSua.reduce((a, c) => a + c.giu.length, 0);
  console.log(`\nGiữ nguyên ${tongGiu} bản ghi khác trên chính các luồng đó.`);

  if (!XOA) { console.log("\n(Chạy thử — CHƯA xoá gì. Thêm --xoa để xoá thật.)"); return; }

  let xong = 0;
  for (const c of canSua) {
    await firestore.collection("liveStreams").doc(c.id)
      .update({ recentIncidents: c.giu, incidentCount: Math.max(0, c.giu.length) })
      .catch((e) => { console.error("  lỗi ở luồng " + c.ten + ": " + String(e?.message ?? e).slice(0, 60)); });
    xong++;
  }
  console.log(`\nĐÃ XOÁ. Cập nhật ${xong}/${canSua.length} luồng.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("LỖI:", e?.message ?? e); process.exit(1); });
