// CHI DOC — xem luong nao chua co createdByUnit, va loc "test" dang an mat bao nhieu luong.
import { firestore } from "@/lib/firestore";
const isTest = (n: string) => /(^|[^a-z])test([^a-z]|$)|thử nghiệm|thử /i.test(String(n ?? ""));
async function main() {
  const [sS, uS] = await Promise.all([
    firestore.collection("liveStreams").get(),
    firestore.collection("users").get(),
  ]);
  const users = new Map<string, any>();
  uS.docs.forEach((d) => { const u: any = d.data(); users.set(String(u.email ?? d.id).toLowerCase(), u); });
  const streams = sS.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  console.log("Tong luong:", streams.length);
  const test = streams.filter((s: any) => isTest(s.name));
  console.log("Bi loc vi ten co chu 'test':", test.length);
  const donVi: Record<string, { tong: number; test: number }> = {};
  streams.forEach((s: any) => {
    const k = String(s.createdByUnit ?? "").trim() || "(chua gan don vi)";
    const u = donVi[k] ?? { tong: 0, test: 0 };
    u.tong++; if (isTest(s.name)) u.test++;
    donVi[k] = u;
  });
  console.log("\n=== THEO DON VI (tong / trong do bi loc vi ten test) ===");
  Object.entries(donVi).sort((a, b) => b[1].tong - a[1].tong)
    .forEach(([k, v]) => console.log(`${k.padEnd(24)} ${String(v.tong).padStart(4)}   test ${v.test}`));
  const trong = streams.filter((s: any) => !String(s.createdByUnit ?? "").trim());
  console.log("\n=== LUONG CHUA GAN DON VI (" + trong.length + ") ===");
  trong.forEach((s: any) => {
    const u = users.get(String(s.createdBy ?? "").toLowerCase());
    console.log(`#${s.seq ?? s.id} "${s.name}" | nguoi tao=${s.createdBy ?? "-"} | don vi HIEN NAY cua ho="${u?.unit ?? "(khong tim thay nguoi)"}" | trang thai=${s.status}`);
  });
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
