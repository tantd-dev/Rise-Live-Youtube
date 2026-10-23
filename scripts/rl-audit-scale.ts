// RA SOAT HIEN TRANG RISE LIVE truoc khi mo rong 300-500 luong (CHI DOC).
// Chay: npx tsx scripts/rl-audit-scale.ts
import { firestore } from "@/lib/firestore";
import { LIVE_QUALITY_PRESETS, streamBandwidthMbps, DEFAULT_SAFETY_FACTOR } from "@/lib/live-catalog";

const r1 = (n: number) => Math.round(n * 10) / 10;

async function main() {
  const [mS, sS, aS] = await Promise.all([
    firestore.collection("liveMachines").get(),
    firestore.collection("liveStreams").get(),
    firestore.collection("liveAssets").get(),
  ]);
  const machines = mS.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const streams = sS.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const assets = aS.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const pm: Record<string, number> = {};
  LIVE_QUALITY_PRESETS.forEach((p) => { pm[p.id] = streamBandwidthMbps(p); });

  console.log("=== MAY PHAT (" + machines.length + ") ===");
  console.log(["TEN", "agent", "NCC", "KhuVuc", "Mbps", "tx", "%", "oTrong", "luong"].join(" | "));
  for (const m of machines) {
    const on = streams.filter((s) => s.machineId === m.id);
    const up = Number(m.uploadMbps) || 0, tx = Number(m.txMbps) || 0;
    console.log([
      String(m.name ?? "").slice(0, 22).padEnd(22),
      String(m.agentVersion ?? "?").padEnd(7),
      String(m.provider ?? "-").slice(0, 12).padEnd(12),
      String(m.region ?? "-").slice(0, 6).padEnd(6),
      String(up).padStart(5),
      String(Math.round(tx)).padStart(5),
      (up ? Math.round((tx / up) * 100) + "%" : "-").padStart(5),
      (m.diskFreeGb != null ? Math.round(Number(m.diskFreeGb)) + "G" : "-").padStart(6),
      String(on.length).padStart(5),
    ].join(" | "));
  }

  const live = streams.filter((s) => String(s.status) === "live");
  const wantLive = streams.filter((s) => s.desiredState === "live" || s.control === "schedule");
  console.log("\n=== LUONG ===");
  console.log("tong:", streams.length, "| dang phat:", live.length, "| muon phat:", wantLive.length);
  const byMode: Record<string, number> = {};
  streams.forEach((s) => { const k = String(s.mode ?? "stream-247"); byMode[k] = (byMode[k] ?? 0) + 1; });
  console.log("theo loai:", JSON.stringify(byMode));
  const byCtl: Record<string, number> = {};
  streams.forEach((s) => { const k = String(s.control ?? "manual"); byCtl[k] = (byCtl[k] ?? 0) + 1; });
  console.log("theo dieu khien:", JSON.stringify(byCtl));
  const prio = streams.filter((s) => { const i = String(s.importance || (s.priority ? "priority" : "normal")); return i === "priority" || i === "critical"; });
  console.log("uu tien:", prio.length, "| trong do bat tu-chuyen:", prio.filter((s) => String(s.failoverMode) === "automatic").length);

  console.log("\n=== VIDEO ===");
  console.log("tong:", assets.length, "| ban du phong he thong:", assets.filter((a) => String(a.source) === "auto-backup").length);
  const byStatus: Record<string, number> = {};
  assets.forEach((a) => { const k = String(a.status ?? "?"); byStatus[k] = (byStatus[k] ?? 0) + 1; });
  console.log("theo trang thai:", JSON.stringify(byStatus));

  console.log("\n=== SUC CHUA TONG ===");
  let tongMax = 0, tongDung = 0;
  for (const m of machines) {
    const up = Number(m.uploadMbps) || 0;
    tongMax += up; tongDung += Number(m.txMbps) || 0;
  }
  console.log("tran tong:", r1(tongMax), "Mbps | dang dung:", r1(tongDung), "Mbps ~", tongMax ? Math.round((tongDung / tongMax) * 100) + "%" : "-");
  console.log("suc chua AN TOAN (70%):", r1(tongMax * DEFAULT_SAFETY_FACTOR), "Mbps");
  const bwMoi = pm[LIVE_QUALITY_PRESETS.find((p) => p.id.includes("1080p"))?.id ?? ""] || 0;
  if (bwMoi > 0) console.log("=> con cho ~", Math.floor((tongMax * DEFAULT_SAFETY_FACTOR - tongDung) / bwMoi), "luong 1080p nua (bwMoi=" + bwMoi + " Mbps/luong)");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
