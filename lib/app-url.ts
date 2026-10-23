// Trên Cloud Run, request.url đôi khi phản ánh host nội bộ container (vd
// https://0.0.0.0:8080) chứ không phải domain công khai thật — đã gặp lỗi
// này với luồng OAuth YouTube trước đây. Lấy origin thật từ chính biến môi
// trường redirect URI đã cấu hình đúng domain công khai, dùng chung cho mọi
// link gửi qua email (không chỉ riêng YouTube).
export function appOrigin() {
  const candidates = [process.env.APP_BASE_URL, process.env.YOUTUBE_OAUTH_REDIRECT_URI];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      continue;
    }
  }
  return "";
}
