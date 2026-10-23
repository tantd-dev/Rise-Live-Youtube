// XEM VIDEO DANG TAI (CHI DOC). Chay: npx tsx scripts/rl-xem-dang-tai.ts
import { firestore } from "@/lib/firestore";
const r1 = (n: number) => Math.round(n * 10) / 10;
async function main() {
  const [aS, mS] = await Promise.all([
    firestore.collection("liveAssets").get(),
    firestore.collection("liveMachines").get(),
  ]);
  const ten: Record<string, string> = {}; const agent: Record<string, string> = {};
  mS.docs.forEach((d) => { const m: any = d.data(); ten[d.id] = String(m.name ?? d.id); agent[d.id] = String(m.agentVersion ?? "?"); });
  const dang = aS.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))
    .filter((a: any) => ["pending", "waiting", "downloading", "queued", "normalizing"].includes(String(a.status)));
  console.log("=== VIDEO DANG XU LY: " + dang.length + " ===");
  for (const a of dang as any[]) {
    const t0 = Date.parse(String(a.createdAt ?? ""));
    const phut = Number.isFinite(t0) ? (Date.now() - t0) / 60000 : 0;
    const da = Number(a.downloadedMb) || 0;
    const toc = phut > 0.05 && da > 0 ? r1(da / phut) : null;
    console.log([
      String(a.name ?? "").slice(0, 34),
      "may=" + (ten[String(a.machineId)] ?? "?") + " (" + (agent[String(a.machineId)] ?? "?") + ")",
      "trang thai=" + a.status,
      a.progressPct != null ? a.progressPct + "%" : "-",
      da ? r1(da) + "/" + r1(Number(a.totalMb) || 0) + " MB" : "-",
      "da " + r1(phut) + " phut",
      toc != null ? "=> " + toc + " MB/phut" : "",
      a.copyFromUrl ? "[CHEP TU MAY KHAC]" : "[TAI DRIVE]",
    ].join(" | "));
  }
  console.log("\n=== AGENT TUNG MAY ===");
  mS.docs.forEach((d) => { const m: any = d.data(); console.log("  " + String(m.name ?? d.id).padEnd(26) + " " + String(m.agentVersion ?? "?") + "  ytdlp=" + (m.ytdlpVersion ?? "chua bao") + (m.toolError ? "  LOI: " + String(m.toolError).slice(0, 90) : "")); });
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
