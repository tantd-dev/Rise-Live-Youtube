// CAN BANG LAI BAN DU PHONG GIUA CAC VPS (Rise Live).
//
// Vi sao can: truoc V71.9, luat chon may dat ban du phong chi xet DIEM TONG roi lay O CUNG lam
// tieu chi phu -> ban don het vao may nhieu o nhat, du may do bang thong THAP NHAT. Do that
// 29/08/2026: 30/48 ban nam tren VPS 01 (tran 400 Mbps, thap nhat cum).
// V71.9 da sua LUAT DAT, nhung cac ban DA NAM LECH thi he khong tu don. Script nay xoa bot ban
// thua tren may VUOT QUY, de vong chay ke tiep he tu dat lai dung cho (may con nhieu quy nhat).
//
// QUY CUU HO = 50% bang thong may (V71.9). Chi 1 may chet moi lan nen muc chiem cho tinh theo
// MAY NGUON NANG NHAT, khong cong gop.
//
// BON CHAN AN TOAN — chi xoa ban thoa DU ca 4:
//   1. La ban he TU TAO (source=auto-backup) — khong bao gio dung video nguoi dung tu tai len.
//   2. KHONG bi KHOA (assetLockMap) — day la CHOT AN TOAN CUA GIAO DIEN, script chay tay TUYET DOI
//      khong duoc lach. Khoa ap cho video cua luong UU TIEN dang chay, ca ban goc lan ban sao.
//      (Thieu sot 29/08/2026: ban dau script chi kiem "co nam trong assetIds khong" — hep hon khoa,
//      nen da xoa 4 ban ma giao dien le ra chan. Kiem lai KHONG luong uu tien nao mat du phong, nhung
//      do la MAY chu khong phai lam dung. Nay dung dung ham khoa cua giao dien.)
//   3. KHONG duoc luong nao dang dung (khong nam trong assetIds cua bat ky luong nao).
//   4. Luong goc VAN CON ban tren may cua no -> xoa ban sao khong lam mat video.
//   5. Chi xoa VUA DU de may ve duoi quy — khong xoa sach.
//
// Chay thu: npx tsx scripts/rl-rebalance-backups.ts
// Xoa that: npx tsx scripts/rl-rebalance-backups.ts --commit
import { firestore } from "@/lib/firestore";
import { quyDuPhongMbps } from "@/lib/live-capacity";
import { streamBandwidthMbps, resolveLivePreset } from "@/lib/live-catalog";
import { assetLockMap } from "@/lib/live-asset-lock";

async function main() {
  const commit = process.argv.includes("--commit");
  const [mS, sS, aS] = await Promise.all([
    firestore.collection("liveMachines").get(),
    firestore.collection("liveStreams").get(),
    firestore.collection("liveAssets").get(),
  ]);
  const M: any[] = mS.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const S: any[] = sS.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const A: any[] = aS.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const ten = (id: string) => String(M.find((m) => m.id === id)?.name ?? "?").slice(0, 22);
  const bw = (s: any) => { const p = resolveLivePreset(String(s.presetId ?? "")); return (p ? streamBandwidthMbps(p) : 0) || 6.57; };
  const idsCua = (s: any): string[] => Array.isArray(s.assetIds) && s.assetIds.length ? s.assetIds.map(String) : (s.assetId ? [String(s.assetId)] : []);

  // Video dang duoc luong nao do dung -> TUYET DOI khong dung toi.
  const dangDung = new Set<string>(); S.forEach((s) => idsCua(s).forEach((i) => dangDung.add(i)));
  // CHOT AN TOAN CUA GIAO DIEN — dung DUNG ham do, khong tu che luat rieng.
  const khoa = assetLockMap(S as any, A as any);

  // Lap ban do: ban du phong nao (asset) dang do luong nao (stream), nam tren may nao.
  type Ban = { asset: any; stream: any; giu: string; nguon: string; mbps: number };
  const bans: Ban[] = [];
  for (const st of S) {
    if (!(st.desiredState === "live" || st.control === "schedule")) continue;
    const daTinh = new Set<string>();
    for (const i of idsCua(st)) {
      const goc = A.find((x) => String(x.id) === i); if (!goc) continue;
      const su = String(goc.sourceUrl ?? "").trim();
      for (const x of A) {
        if (String(x.machineId) === String(st.machineId)) continue;
        const khop = String(x.copyFromAssetId ?? "") === i || (su !== "" && String(x.sourceUrl ?? "").trim() === su);
        if (!khop || daTinh.has(String(x.machineId))) continue;
        daTinh.add(String(x.machineId));
        bans.push({ asset: x, stream: st, giu: String(x.machineId), nguon: String(st.machineId), mbps: bw(st) });
      }
    }
  }

  const chiemTheoNguon = (giu: string, boQua: Set<string>) => {
    const t: Record<string, number> = {};
    bans.filter((b) => b.giu === giu && !boQua.has(b.asset.id)).forEach((b) => { t[b.nguon] = (t[b.nguon] ?? 0) + b.mbps; });
    return t;
  };
  const nangNhat = (t: Record<string, number>) => Math.max(0, ...Object.values(t));

  const seXoa = new Set<string>();
  console.log(`QUY CUU HO = 50% bang thong · chi tinh MAY NGUON NANG NHAT (khong cong gop)\n`);
  for (const m of M) {
    const quy = quyDuPhongMbps(m.uploadMbps);
    let t = chiemTheoNguon(m.id, seXoa);
    let dung = nangNhat(t);
    if (dung <= quy) { console.log(`${String(m.name).slice(0,22).padEnd(24)} quy ${String(quy).padEnd(7)} dang chiem ${Math.round(dung)} -> DAT, khong dong toi`); continue; }
    console.log(`${String(m.name).slice(0,22).padEnd(24)} quy ${String(quy).padEnd(7)} dang chiem ${Math.round(dung)} -> VUOT ${Math.round(dung - quy)} Mbps, xoa bot:`);
    // Xoa dan tu MAY NGUON NANG NHAT, uu tien ban NANG nhat de xoa it cai nhat.
    while (dung > quy) {
      const nguonNang = Object.entries(t).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!nguonNang) break;
      const ungVien = bans
        .filter((b) => b.giu === m.id && b.nguon === nguonNang && !seXoa.has(b.asset.id))
        .filter((b) => String(b.asset.source) === "auto-backup" || String(b.asset.createdBy).toLowerCase() === "system")   // chan 1
        .filter((b) => !khoa[String(b.asset.id)])                                                                          // chan 2: dang bi KHOA -> khong dung toi
        .filter((b) => !dangDung.has(String(b.asset.id)))                                                                  // chan 3
        .filter((b) => idsCua(b.stream).every((i) => A.some((x) => String(x.id) === i && String(x.machineId) === b.nguon))) // chan 4: luong goc con ban
        .sort((a, b) => b.mbps - a.mbps);
      if (!ungVien.length) { console.log(`   (khong con ban nao xoa duoc an toan tu ${ten(nguonNang)} — dung lai)`); break; }
      const b = ungVien[0];
      seXoa.add(b.asset.id);
      console.log(`   - "${String(b.asset.name ?? "").slice(0, 40)}" (${Math.round(b.mbps)} Mbps, do luong "${String(b.stream.name ?? "").slice(0,24)}" tu ${ten(b.nguon)})`);
      t = chiemTheoNguon(m.id, seXoa); dung = nangNhat(t);                                                                  // chan 4: tinh lai, dung ngay khi ve duoi quy
    }
    console.log(`   => sau khi xoa: chiem ${Math.round(dung)}/${quy} Mbps`);
  }

  console.log(`\nTONG SE XOA: ${seXoa.size} ban du phong${commit ? " (XOA THAT)" : " (chay thu — chua xoa)"}`);
  if (!commit) { console.log("=> Them --commit de xoa that."); return; }
  let n = 0;
  for (const id of seXoa) { await firestore.collection("liveAssets").doc(id).delete().catch(() => {}); n++; }
  console.log(`DA XOA ${n} ban ghi. He se tu dat lai o may con nhieu quy nhat trong vong chay ke tiep.`);
}
main().then(() => process.exit(0));
