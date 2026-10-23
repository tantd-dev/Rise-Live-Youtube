// SOI: bao nhiêu bản ghi sự cố CŨ đang gán SAI máy — CHỈ ĐỌC, không sửa gì.
// npx tsx scripts/rl-soi-may-su-co.ts
//
// Bản ghi sự cố lưu machineId = máy HIỆN TẠI của luồng lúc TẠO bản ghi, còn startedAt là lúc sự cố
// XẢY RA. Luồng nào chuyển máy giữa hai mốc đó thì lịch sử bị gán cho máy MỚI. V71.25 đã sửa cho
// bản ghi MỚI; script này đếm xem bản ghi CŨ sai bao nhiêu, để quyết có nên sửa ngược không.
import { firestore } from "@/lib/firestore";

async function main() {
  const [icS, mvS, mS] = await Promise.all([
    firestore.collection("liveIncidentLog").get(),
    firestore.collection("liveMoveExecutions").get(),
    firestore.collection("liveMachines").get(),
  ]);
  const ten: Record<string, string> = {};
  mS.docs.forEach((d) => { ten[d.id] = String((d.data() as any).name ?? d.id); });

  // Sổ chuyển máy theo luồng, sắp theo thời gian.
  const theoLuong = new Map<string, { at: string; nguon: string; dich: string }[]>();
  mvS.docs.forEach((d) => {
    const x: any = d.data();
    const sid = String(x.streamId ?? ""); if (!sid) return;
    if (!theoLuong.has(sid)) theoLuong.set(sid, []);
    theoLuong.get(sid)!.push({ at: String(x.startedAt ?? ""), nguon: String(x.sourceMachineId ?? ""), dich: String(x.targetMachineId ?? "") });
  });
  theoLuong.forEach((v) => v.sort((a, b) => a.at.localeCompare(b.at)));

  let tong = 0, sai = 0;
  const doi: Record<string, number> = {};
  const viDu: string[] = [];
  icS.docs.forEach((d) => {
    const e: any = d.data();
    const sid = String(e.streamId ?? ""); const moc = String(e.startedAt ?? "");
    const dangGhi = String(e.machineId ?? "");
    if (!sid || !moc || !dangGhi) return;
    tong++;
    const sau = (theoLuong.get(sid) ?? []).filter((m) => m.at > moc && m.nguon);
    if (!sau.length) return;
    const dung = sau[0].nguon;
    if (dung === dangGhi) return;
    sai++;
    const k = (ten[dangGhi] ?? dangGhi) + "  →  " + (ten[dung] ?? dung);
    doi[k] = (doi[k] ?? 0) + 1;
    if (viDu.length < 5) viDu.push(`  "${String(e.streamName ?? "").slice(0, 26)}"  ${moc.slice(0, 16)}  đang ghi ${ten[dangGhi] ?? dangGhi} → đúng ra là ${ten[dung] ?? dung}`);
  });

  console.log("Tổng bản ghi sự cố có đủ dữ kiện để kiểm: " + tong);
  console.log("Trong đó GÁN SAI MÁY: " + sai + (tong ? "  (" + Math.round((sai / tong) * 100) + "%)" : ""));
  if (sai) {
    console.log("\n=== SỬA NGƯỢC SẼ CHUYỂN ===");
    Object.entries(doi).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log("  " + String(v).padStart(4) + "  " + k));
    console.log("\n=== VÍ DỤ ===");
    viDu.forEach((x) => console.log(x));
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("LỖI:", e?.message ?? e); process.exit(1); });
