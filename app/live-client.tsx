"use client";
import { useRef, useState } from "react";
import { RiseLive } from "@/components/domains/a7-live/RiseLive";

// RiseLive cần hàm flash (thông báo nhanh) — hàm không truyền được từ server component nên bọc ở client.
export default function LiveClient({ user }: { user: any }) {
  const [msg, setMsg] = useState("");
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (m: string) => {
    setMsg(m);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setMsg(""), 4500);
  };
  return (
    <div className="wrap">
      <div className="topbar">
        <b>Rise Live</b>
        <span>{user.fullName} · {user.role}</span>
        <a href="/api/dev/logout" style={{ marginLeft: "auto" }}>Đăng xuất</a>
      </div>
      <RiseLive user={user} flash={flash} active />
      {msg && <div className="toast" role="status">{msg}</div>}
    </div>
  );
}
