// Uoc luong rui ro khi mo rong 300-500 luong (CHI DOC).
import { firestore } from "@/lib/firestore";
async function main() {
  const [aS, sS, mS] = await Promise.all([
    firestore.collection("liveAssets").get(),
    firestore.collection("liveStreams").get(),
    firestore.collection("liveMachines").get(),
  ]);
  const nA = aS.size, nS = sS.size, nM = mS.size;
  const tyLe = nA / Math.max(1, nS);
  console.log("HIEN TAI: video =", nA, "| luong =", nS, "| may =", nM, "| video/luong =", tyLe.toFixed(2));
  for (const muc of [300, 400, 500]) {
    const duBao = Math.round(tyLe * muc);
    console.log("  o " + muc + " luong -> ~" + duBao + " video  " + (duBao > 1000 ? "*** VUOT gioi han 1000 -> CAT AM THAM ***" : "(duoi 1000)"));
  }
  // video moi may (gioi han 500/may trong agent)
  const perM: Record<string, number> = {};
  aS.docs.forEach((d) => { const k = String((d.data() as any).machineId ?? "-"); perM[k] = (perM[k] ?? 0) + 1; });
  const max = Math.max(0, ...Object.values(perM));
  console.log("\nVideo tren MOT may — nhieu nhat hien nay:", max, "| gioi han agent: 500");
  console.log("  o 500 luong (giu nguyen so may):", Math.round(max * 500 / Math.max(1, nS)), (max * 500 / Math.max(1, nS) > 500 ? "*** VUOT ***" : "(duoi 500)"));
  // do phuc tap vong dat ban du phong
  const prio = sS.docs.map((d) => d.data() as any).filter((s) => { const i = String(s.importance || (s.priority ? "priority" : "normal")); return i === "priority" || i === "critical"; }).length;
  console.log("\nVong dat ban du phong chay ~", prio, "luong uu tien x", nM, "may x", nS, "luong =", (prio * nM * nS).toLocaleString(), "phep so/phut");
  const p500 = Math.round(prio * 500 / Math.max(1, nS)), m500 = 10;
  console.log("  o 500 luong (~" + p500 + " uu tien, " + m500 + " may):", (p500 * m500 * 500).toLocaleString(), "phep so/phut");
  // luot doc Firestore moi ngay cua 2 may quet
  const doc1Phut = nS + nA + nM;
  console.log("\nMoi may quet doc ~", doc1Phut, "ban ghi/phut. Hai may quet (canh bao + tu cuu) chay 1 phut/lan:");
  console.log("  hien tai: ~", (doc1Phut * 2 * 60 * 24).toLocaleString(), "luot doc/ngay");
  const d500 = 500 + Math.round(tyLe * 500) + m500;
  console.log("  o 500 luong: ~", (d500 * 2 * 60 * 24).toLocaleString(), "luot doc/ngay");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
