import { getSession } from "@/lib/session";
import LiveClient from "./live-client";

export const dynamic = "force-dynamic";

export default async function Page() {
  let user: any = null;
  try {
    user = await getSession();
  } catch (e: any) {
    return (
      <main className="wrap">
        <div className="card">
          <div className="cardhead"><h2>Không kết nối được Firestore</h2></div>
          <p className="plain">{String(e?.message ?? e)}</p>
          <p className="plain">Kiểm tra đã chạy <code>npm run emulator</code> và đặt FIRESTORE_EMULATOR_HOST trong .env.local chưa.</p>
        </div>
      </main>
    );
  }
  if (!user) {
    return (
      <main className="wrap">
        <div className="card">
          <div className="cardhead"><h2>Chưa đăng nhập</h2></div>
          {process.env.ALLOW_DEV_LOGIN === "1"
            ? <p className="plain"><a className="primary" href="/api/dev/login">Đăng nhập thử (tài khoản dev, vai trò admin)</a></p>
            : <p className="plain">Bản khôi phục không có màn đăng nhập thật. Đặt ALLOW_DEV_LOGIN=1 trong .env.local để dùng đăng nhập thử.</p>}
        </div>
      </main>
    );
  }
  return <LiveClient user={user} />;
}
