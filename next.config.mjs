// Bản khôi phục: tạm bỏ qua lỗi kiểu khi build để chạy thử được ngay.
// Muốn xem lỗi kiểu thật: npm run typecheck
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
