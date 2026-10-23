import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "Rise Live — bản khôi phục để chạy thử" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
