// DON XAC CAC LAN COPY VIDEO THAT BAI (Rise Live).
//
// Vi sao can: khi may NGUON khong toi duoc (mat mang), nguoi dung bam "Chuyen (tu copy)" ->
// may dich tao mot ban ghi video roi bao LOI. Ban ghi do nam lai mai, va vi trang thai la
// "error" nen no BAN LEN canh bao NGHIEM TRONG. Su co VPS 03 ngay 29/08/2026 de lai 16 cai
// nhu vay -> che mat canh bao that.
//
// CHI xoa dung loai xac do: co copyFromUrl (tuc la ban sao dang cho copy) + trang thai error
// + ly do la loi KET NOI. KHONG dung toi video hong that (loi tai/nen tu Drive) va KHONG dung
// toi video dang phuc vu luong.
//
// Chay thu (chi doc): npx tsx scripts/rl-clean-failed-copies.ts
// Xoa that:           npx tsx scripts/rl-clean-failed-copies.ts --commit
import { firestore } from "@/lib/firestore";
import { laXacCopyHong } from "@/lib/live-copy-cleanup";

async function main() {
  const commit = process.argv.includes("--commit");
  const [aS, sS, mS] = await Promise.all([
    firestore.collection("liveAssets").get(),
    firestore.collection("liveStreams").get(),
    firestore.collection("liveMachines").get(),
  ]);
  const ten = (id: string) => String((mS.docs.find((d) => d.id === id)?.data() as any)?.name ?? "?").slice(0, 22);
  // AN TOAN: khong xoa video dang duoc luong nao dung (du dang loi).
  const dangDung = new Set<string>();
  sS.docs.forEach((d) => {
    const s: any = d.data();
    (Array.isArray(s.assetIds) ? s.assetIds : (s.assetId ? [s.assetId] : [])).forEach((x: any) => dangDung.add(String(x)));
  });

  const xac = aS.docs
    .map((d) => ({ id: d.id, ...(d.data() as any) }))
    .filter((a: any) => laXacCopyHong(a) && !dangDung.has(a.id));

  console.log(`Tong video: ${aS.size} · xac copy hong: ${xac.length}${commit ? " (SE XOA)" : " (chay thu — chua xoa)"}`);
  xac.forEach((a: any) => console.log(`  · ${String(a.name ?? "").slice(0, 34).padEnd(35)} may:${ten(a.machineId).padEnd(23)} ${String(a.error ?? "").slice(0, 46)}`));
  const bi = aS.docs.map((d) => ({ id: d.id, ...(d.data() as any) })).filter((a: any) => laXacCopyHong(a) && dangDung.has(a.id));
  if (bi.length) console.log(`\nBO QUA ${bi.length} cai vi dang duoc luong su dung (khong tu y xoa).`);

  if (!commit) { console.log("\n=> Them --commit de xoa that."); return; }
  let n = 0;
  for (const a of xac) { await firestore.collection("liveAssets").doc(a.id).delete().catch(() => { /* da xoa */ }); n++; }
  console.log(`\nDA XOA ${n} ban ghi.`);
}
main().then(() => process.exit(0));
