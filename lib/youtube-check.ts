// Trích videoId (11 ký tự) từ URL YouTube: watch?v= · youtu.be/ · /live/ · /shorts/ · /embed/.
// KHÔNG lấy được từ /@channel/live (không có id rõ) — luồng đó sẽ bỏ qua kiểm tra.
export function extractYouTubeVideoId(url: string): string | null {
  const u = String(url || "").trim();
  if (!u) return null;
  let m = u.match(/[?&]v=([\w-]{11})(?:[&?/]|$)/); if (m) return m[1];
  m = u.match(/youtu\.be\/([\w-]{11})/); if (m) return m[1];
  m = u.match(/youtube\.com\/(?:live|shorts|embed)\/([\w-]{11})/); if (m) return m[1];
  return null;
}
