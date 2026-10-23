// RISE LIVE — GIAI ĐOẠN 2, BƯỚC 1 (THỬ NGHIỆM): BỘ ĐẨY DÙNG CHUNG CHO MỖI BẢN SAO MÁY CHỦ.
//
// VẤN ĐỀ ĐANG CÓ: mỗi màn hình Live cứ 20 giây lại hỏi máy chủ TOÀN BỘ danh sách
// (tối đa 200 máy + 1.000 video + 2.000 luồng ≈ 400 lượt đọc/lần/người). Chi phí nhân theo
// số luồng × số người đang xem. Ở 300 luồng thì nổ (xem D-RL-03).
//
// CÁCH B (D-RL-03 đã khóa): máy chủ TỰ ĐẨY về màn hình phần nào vừa đổi.
//
// ĐIỂM MẤU CHỐT — vì sao KHÔNG cần cho các bản sao nói chuyện với nhau:
//   Bản thiết kế cũ lo "Cloud Run chạy nhiều bản sao, worker đẩy vào bộ nhớ bản sao này thì
//   bản sao kia không biết". Nhưng worker KHÔNG đẩy vào bộ nhớ — nó GHI XUỐNG FIRESTORE
//   (đang làm vậy sẵn rồi). Nên chỉ cần MỖI bản sao tự nghe thẳng Firestore là xong:
//   Firestore chính là đường truyền chung. Không cần Pub/Sub, không cần Redis, không cần
//   ghim phiên. Đây là lý do chọn B mà không phải C.
//
// TIẾT KIỆM: một bản sao chỉ mở MỘT tai nghe cho cả N người đang xem trên bản sao đó.
// Firestore tính tiền theo SỐ BẢN GHI THỰC SỰ ĐỔI, không theo nhịp hỏi. Với "ghi-khi-đổi"
// (đã bật) thì số bản ghi đổi mỗi phút rất ít.
//
// BẪY PHẢI TRÁNH (quan trọng): lần mở tai nghe đầu tiên Firestore trả VỀ TOÀN BỘ bản ghi
// (~400 lượt đọc). Nếu mở/đóng theo từng người vào-ra thì còn TỐN HƠN cách cũ. Vì vậy:
//   - Người cuối cùng rời đi thì KHÔNG đóng ngay, giữ thêm một khoảng ân hạn (mặc định 5 phút).
//   - Đợt trả về đầu tiên KHÔNG phát ra ngoài (nó là ảnh chụp ban đầu, không phải thay đổi).
//
// THUẦN CỘNG THÊM: file mới, không ai gọi tới khi cờ RISE_LIVE_REALTIME chưa bật.

import { firestore } from "@/lib/firestore";

export const REALTIME_ON = () => process.env.RISE_LIVE_REALTIME === "1";

/** Khoảng ân hạn giữ tai nghe sau khi người cuối rời đi (giây). Giữ để lần vào lại không phải trả tiền ảnh chụp ban đầu. */
export const IDLE_KEEP_SEC = Math.max(30, Number(process.env.RISE_LIVE_REALTIME_IDLE_SEC) || 300);
/** Một kết nối đẩy sống tối đa bao lâu (giây). PHẢI nhỏ hơn hạn giờ của Cloud Run (đang là 60s). */
export const CONN_MAX_SEC = Math.max(10, Number(process.env.RISE_LIVE_REALTIME_CONN_SEC) || 50);

const COLS = ["liveMachines", "liveStreams", "liveAssets"] as const;
export type LiveCol = (typeof COLS)[number];

/** Một thay đổi vừa xảy ra. `by` chỉ dùng để LỌC PHẠM VI ở phía máy chủ — không gửi ra ngoài. */
export type LiveChange = {
  col: LiveCol;
  id: string;
  kind: "added" | "modified" | "removed";
  by: string;              // createdBy (đã hạ chữ thường), "" nếu không có
  status?: string;         // chỉ với luồng — trạng thái thô, không nhạy cảm
  at: string;              // ISO
};

type Sub = (c: LiveChange) => void;

/** Số liệu để CHỨNG MINH cơ chế chạy đúng (bước thử nghiệm cần đo, không đoán). */
export type BusStats = {
  instanceId: string;
  listening: boolean;
  startedAt: string | null;
  primedDocs: number;        // số bản ghi của ảnh chụp ban đầu (= lượt đọc đã trả tiền)
  changes: number;           // số thay đổi THẬT đã đẩy từ lúc mở tai nghe
  skipped: number;           // số lần bỏ qua vì chỉ đổi nhịp báo về (không phải việc thật)
  subscribers: number;
  restarts: number;
  lastError: string | null;
  lastChangeAt: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Trạng thái theo TIẾN TRÌNH (mỗi bản sao Cloud Run có một bản riêng — đúng ý đồ).
// ─────────────────────────────────────────────────────────────────────────────
const INSTANCE_ID = (() => {
  try { return (globalThis.crypto as any).randomUUID().slice(0, 8); } catch { return "unknown"; }
})();

const subs = new Set<Sub>();
let detachers: Array<() => void> = [];
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const primed: Record<string, boolean> = {};
let stats = {
  listening: false, startedAt: null as string | null, primedDocs: 0,
  changes: 0, skipped: 0, restarts: 0, lastError: null as string | null, lastChangeAt: null as string | null,
};

// ─────────────────────────────────────────────────────────────────────────────
// CHỈ PHÁT THAY ĐỔI *CÓ NGHĨA*
//
// Vì sao bắt buộc phải có: mỗi nhịp báo cáo, worker cập nhật "lúc nào báo về gần nhất" cho máy và
// luồng. Đó KHÔNG phải thay đổi mà người dùng cần biết. Nếu phát hết ra thì màn Live sẽ tự làm mới
// liên tục — còn tệ hơn nhịp 20 giây cũ. Ở đây giữ một "chữ ký" gọn của từng bản ghi trong bộ nhớ,
// chỉ phát khi chữ ký ĐỔI.
//
// Cố ý BỎ QUA "lúc nào báo về gần nhất": máy chết được nhận ra bằng việc KHÔNG còn báo về, mà không
// báo về thì cũng không có thay đổi nào để phát — nhịp làm mới an toàn (60 giây) lo phần đó.
// ─────────────────────────────────────────────────────────────────────────────
const sig = new Map<string, string>();
const b = (v: any, buoc: number) => (v == null ? "" : String(Math.round(Number(v) / buoc)));   // gom về bậc, bớt nhiễu đo

function chuKy(col: LiveCol, d: any): string {
  if (col === "liveStreams")
    return [d.status, d.health, d.desiredState, d.machineId, d.moveTargetId, d.importance,
      d.error, d.liveSince, d.restartHalted, d.needsHuman, d.black, d.slow, d.ytIssue ? "yt" : ""].join("|");
  if (col === "liveMachines")
    return [d.status, d.forceOffline, d.name, d.uploadMbps, b(d.diskFreeGb, 5), b(d.txMbps, 10), b(d.loadAvg, 1)].join("|");
  return [d.status, d.name, d.error, b(d.sizeMb, 50), d.machineId].join("|");   // liveAssets
}

function emit(c: LiveChange) {
  stats.changes += 1;
  stats.lastChangeAt = c.at;
  for (const fn of Array.from(subs)) { try { fn(c); } catch { /* một người xem lỗi không được làm chết cả bộ */ } }
}

function attach() {
  if (stats.listening) return;
  stats.listening = true;
  stats.startedAt = new Date().toISOString();
  stats.primedDocs = 0;
  stats.lastError = null;
  COLS.forEach((col) => { primed[col] = false; });
  sig.clear();

  detachers = COLS.map((col) =>
    firestore.collection(col).onSnapshot(
      (snap) => {
        // Đợt đầu = ẢNH CHỤP BAN ĐẦU: chỉ đếm để biết đã trả bao nhiêu lượt đọc, KHÔNG phát ra ngoài.
        if (!primed[col]) {
          primed[col] = true;
          stats.primedDocs += snap.size;
          // Ghi nhớ chữ ký ban đầu — để lát nữa biết cái gì THỰC SỰ đổi.
          snap.docs.forEach((doc) => sig.set(`${col}:${doc.id}`, chuKy(col, doc.data() ?? {})));
          return;
        }
        const at = new Date().toISOString();
        snap.docChanges().forEach((ch) => {
          const d: any = ch.doc.data() ?? {};
          const key = `${col}:${ch.doc.id}`;
          if (ch.type === "removed") { sig.delete(key); }
          else {
            const moi = chuKy(col, d);
            if (sig.get(key) === moi) { stats.skipped += 1; return; }   // chỉ đổi nhịp báo về → bỏ qua
            sig.set(key, moi);
          }
          emit({
            col,
            id: ch.doc.id,
            kind: ch.type as LiveChange["kind"],
            by: String(d.createdBy ?? "").toLowerCase(),
            status: col === "liveStreams" ? String(d.status ?? "") : undefined,
            at,
          });
        });
      },
      (err) => {
        // KHÔNG nuốt lỗi im lặng (quy tắc 5 của dự án): ghi lại để màn thử nghiệm hiện ra,
        // và để người xem chuyển sang trạng thái "mất kết nối" thay vì tưởng là bình thường.
        stats.lastError = String(err?.message ?? err);
        stats.listening = false;
        detach(true);
      },
    ),
  );
}

function detach(fromError = false) {
  detachers.forEach((fn) => { try { fn(); } catch { /* bỏ qua */ } });
  detachers = [];
  stats.listening = false;
  if (!fromError) stats.startedAt = null;
}

/**
 * Đăng ký nhận thay đổi. Trả về hàm huỷ đăng ký.
 * Người ĐẦU TIÊN mở tai nghe; người CUỐI rời đi chỉ hẹn đóng sau khoảng ân hạn.
 */
export function subscribe(fn: Sub): () => void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  subs.add(fn);
  if (!stats.listening) {
    if (stats.startedAt) stats.restarts += 1;   // mở lại sau lỗi hoặc sau khi đã đóng
    attach();
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    subs.delete(fn);
    if (subs.size === 0 && !idleTimer) {
      idleTimer = setTimeout(() => { idleTimer = null; if (subs.size === 0) detach(); }, IDLE_KEEP_SEC * 1000);
    }
  };
}

export function busStats(): BusStats {
  return {
    instanceId: INSTANCE_ID,
    listening: stats.listening,
    startedAt: stats.startedAt,
    primedDocs: stats.primedDocs,
    changes: stats.changes,
    skipped: stats.skipped,
    subscribers: subs.size,
    restarts: stats.restarts,
    lastError: stats.lastError,
    lastChangeAt: stats.lastChangeAt,
  };
}
