// DO TOC DO NAP VIDEO: CHEP GIUA VPS vs TAI TU GOOGLE DRIVE (CHI DOC, khong ghi gi).
// Chay: npx tsx scripts/rl-do-toc-do-nap.ts
//
// Vi sao co script nay (Chu Rise Group hoi 30/08/2026): V71.17 them duong tat "link da co san tren
// may khac thi chep thang giua hai may, khong tai lai Drive". Cau hoi dung: duong tat do co THAT SU
// nhanh hon khong? Neu cham hon han thi phai can nhac lai — vi tai lai tu Drive lau nay van chay.
//
// Cach do: moi ban ghi video co createdAt (luc them) va updatedAt (luc worker bao "san sang").
// Hieu hai moc = thoi gian NAP. Chia cho dung luong ra MB/phut.
// ⚠ HAN CHE PHAI NOI RO: khoang nay CO CA thoi gian xep hang cho toi luot va thoi gian ffmpeg chuan
//    audio, khong phai thuan thoi gian tai. Nen con so nay la CAN DUOI cua toc do that. Nhung ca hai
//    nhom deu chiu chung han che do, nen SO SANH giua hai nhom van co nghia.
import { firestore } from "@/lib/firestore";

const r1 = (n: number) => Math.round(n * 10) / 10;

function thongKe(ten: string, ds: { mbPhut: number; sizeMb: number; phut: number; name: string; may: string }[]) {
  if (!ds.length) { console.log(`\n=== ${ten} === KHONG CO MAU NAO`); return null; }
  const sap = [...ds].sort((a, b) => a.mbPhut - b.mbPhut);
  const giua = sap[Math.floor(sap.length / 2)].mbPhut;
  const tb = ds.reduce((s, x) => s + x.mbPhut, 0) / ds.length;
  console.log(`\n=== ${ten} === ${ds.length} mau`);
  console.log(`  trung vi : ${r1(giua)} MB/phut`);
  console.log(`  trung binh: ${r1(tb)} MB/phut`);
  console.log(`  cham nhat : ${r1(sap[0].mbPhut)} MB/phut  ("${sap[0].name.slice(0, 34)}" · ${r1(sap[0].sizeMb)} MB · ${r1(sap[0].phut)} phut · ${sap[0].may})`);
  console.log(`  nhanh nhat: ${r1(sap[sap.length - 1].mbPhut)} MB/phut  ("${sap[sap.length - 1].name.slice(0, 34)}" · ${r1(sap[sap.length - 1].sizeMb)} MB)`);
  return giua;
}

async function main() {
  const [aS, mS] = await Promise.all([
    firestore.collection("liveAssets").get(),
    firestore.collection("liveMachines").get(),
  ]);
  const tenMay: Record<string, string> = {};
  mS.docs.forEach((d) => { tenMay[d.id] = String((d.data() as any).name ?? d.id); });

  const chep: any[] = [], drive: any[] = [];
  let boQua = 0;
  for (const d of aS.docs) {
    const a: any = d.data();
    if (a.status !== "ready") continue;
    if (a.source === "upload") continue;                       // tai thang tu may tinh — khong so sanh duoc
    const t0 = Date.parse(String(a.createdAt ?? "")), t1 = Date.parse(String(a.updatedAt ?? ""));
    const mb = Number(a.sizeMb) || 0;
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0 || mb < 50) { boQua++; continue; }
    const phut = (t1 - t0) / 60000;
    if (phut < 0.05 || phut > 240) { boQua++; continue; }      // moc hong / cham qua lau -> bo
    const mau = { mbPhut: mb / phut, sizeMb: mb, phut, name: String(a.name ?? ""), may: tenMay[String(a.machineId)] ?? "?" };
    (a.copyFromUrl ? chep : drive).push(mau);
  }

  console.log("DO TOC DO NAP VIDEO — chi doc, khong ghi gi");
  console.log(`Bo qua ${boQua} ban ghi (thieu moc thoi gian, duoi 50 MB, hoac khoang thoi gian vo ly).`);
  const gChep = thongKe("CHEP GIUA VPS (copyFromUrl)", chep);
  const gDrive = thongKe("TAI TU GOOGLE DRIVE", drive);

  console.log("\n=== KET LUAN ===");
  if (gChep == null || gDrive == null) {
    console.log("Chua du mau o mot trong hai nhom — CHUA KET LUAN DUOC. Doi them du lieu roi do lai.");
    console.log("(Khong doan bua: thieu du lieu thi noi la thieu.)");
    return;
  }
  const lan = gChep / gDrive;
  if (lan >= 1.2) console.log(`Chep giua VPS NHANH HON ~${r1(lan)} lan (theo trung vi). Giu duong tat.`);
  else if (lan <= 0.8) console.log(`Chep giua VPS CHAM HON (chi bang ${r1(lan * 100)}% toc do tai Drive). NEN TAT duong tat.`);
  else console.log(`Hai cach XAP XI NHAU (${r1(lan * 100)}% ). Van nen giu duong tat vi no khong ton luot tai cua file tren Drive — do moi la thu gay loi "khong tai duoc".`);

  // Do them: mot link bi tai lai bao nhieu lan (day chinh la thu dot han muc Drive).
  const theoLink: Record<string, number> = {};
  aS.docs.forEach((d) => {
    const a: any = d.data();
    const u = String(a.sourceUrl ?? "").trim();
    if (u && !a.copyFromUrl) theoLink[u] = (theoLink[u] ?? 0) + 1;
  });
  const lap = Object.values(theoLink).filter((n) => n > 1);
  const thua = lap.reduce((s, n) => s + (n - 1), 0);
  console.log(`\nTai lai tu Drive: ${lap.length} link bi tai tu 2 lan tro len -> ${thua} luot tai THUA (moi luot deu tru vao han muc cua file do).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
