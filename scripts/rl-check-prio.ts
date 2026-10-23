import { firestore } from "@/lib/firestore";
async function main() {
  const sS = await firestore.collection("liveStreams").get();
  const st = sS.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const isPrio = (s: any) => { if (String(s.mode) === "live-pub") return false; const i = String(s.importance || (s.priority ? "priority" : "normal")); return i === "priority" || i === "critical"; };
  // LUAT THAT trong failover/run dong 208:
  const isAutoProtected = (s: any) => String(s.mode) !== "live-pub" && (s.failoverMode === "automatic" || isPrio(s));
  const prio = st.filter(isPrio);
  const khongDuocBaoVe = prio.filter((s) => !isAutoProtected(s));
  console.log("Luong uu tien (khong tinh Pub):", prio.length);
  console.log("  co truong failoverMode=automatic ghi san:", prio.filter((s) => s.failoverMode === "automatic").length);
  console.log("  CHUA ghi truong do:", prio.filter((s) => s.failoverMode !== "automatic").length);
  console.log(">>> THUC SU KHONG duoc tu cuu:", khongDuocBaoVe.length);
  if (khongDuocBaoVe.length) khongDuocBaoVe.slice(0, 10).forEach((s) => console.log("   -", s.name));
  // Nguoc lai: luong THUONG co bat tu-cuu tuong minh khong
  const thuongCoAuto = st.filter((s) => !isPrio(s) && s.failoverMode === "automatic" && String(s.mode) !== "live-pub");
  console.log("\nLuong THUONG nhung bat tu-cuu tuong minh:", thuongCoAuto.length, "(cung duoc cuu)");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
