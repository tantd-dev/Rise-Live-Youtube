#!/usr/bin/env python3
# RISE LIVE — WORKER AGENT (chay tren moi VPS). Poll Rise Work ~10s: bao suc khoe + trang thai,
# nhan danh sach mong muon -> TU tai/nen video + chay/dung/khoi-dong-lai FFmpeg (copy-codec).
# Xac thuc bang TOKEN. KHONG luu mat khau. Chay nen qua systemd (script tu cai).
#
# Bien moi truong (dat truoc khi chay):
#   RISE_LIVE_URL     = https://<DIA-CHI-MAY-CHU-CUA-BAN>
#   RISE_LIVE_TOKEN   = <token trung voi RISE_LIVE_WORKER_TOKEN tren Cloud Run>
#   RISE_LIVE_MACHINE = <machineId lay tu giao dien Rise Live>
import os, sys, json, time, subprocess, threading, urllib.request, urllib.parse, shutil, uuid, http.server, random, base64
import re as _re, http.cookiejar

# Locale mot so VPS KHONG phai UTF-8 -> print dau "—"/tieng Viet gay UnicodeEncodeError (crash worker).
# Ep stdout/stderr sang UTF-8 ngay tu dau (Python 3.7+) de chay duoc tren moi locale.
try:
    sys.stdout.reconfigure(encoding="utf-8"); sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

AGENT_VERSION = "r2.43"
URL     = os.environ.get("RISE_LIVE_URL", "").rstrip("/")
TOKEN   = os.environ.get("RISE_LIVE_TOKEN", "")
MACHINE = os.environ.get("RISE_LIVE_MACHINE", "")
BASE    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)) )
ASSETS  = os.path.join(BASE, "assets")
RAW     = os.path.join(BASE, "raw")
THUMBS  = os.path.join(BASE, "thumbs")   # anh that dang phat (ghi de, 1 file/luong)
LOGS    = os.path.join(BASE, "logs")      # stderr ffmpeg (chi loi) -> doc LY DO khi luong rot
PLAYS   = os.path.join(BASE, "playlists") # file danh sach phat (concat) khi luong co nhieu video

if not (URL and TOKEN and MACHINE):
    print("Thieu RISE_LIVE_URL / RISE_LIVE_TOKEN / RISE_LIVE_MACHINE"); sys.exit(1)
for _d in (ASSETS, RAW, THUMBS, LOGS, PLAYS): os.makedirs(_d, exist_ok=True)

# Trang thai cuc bo
asset_local  = {}   # assetId -> {"status","path","sizeMb","durationSec","error","working"}
# CONG CU TAI (r2.34) — bao ve may chu de giao dien BIET may nao dang dung ban cu / tu cap nhat hong.
# Su co 29-30/08/2026: VPS 06 moi dung KHONG co pip3 -> ca khoi cai lan co che tu-cap-nhat hang ngay deu
# that bai IM LANG -> may chay yt-dlp ban 2022, tai Drive cham 56 LAN so voi kha nang that cua may, suot
# 1 ngay khong ai biet. Tu nay: hong thi PHAI bao ra (quy tac 5 — khong nuot loi).
tool_state = {"ytdlp": "", "gdown": False, "updateError": "", "updatedAt": 0}
# TAI DONG THOI (r2.34): gioi han so video CUNG tai tren 1 may. Nhieu video cung tai thi cung gianh
# bang thong roi CUNG cham — nhan su tuong "treo". Cho xep hang co thu tu, nguoi dung nhin thay
# "dang xep hang" chu khong phai mot cuc "cho xu ly" im lim.
MAX_TAI_CUNG_LUC = max(1, int(os.environ.get("RISE_LIVE_MAX_PARALLEL_DOWNLOADS", "2") or 2))
dl_sem = threading.Semaphore(MAX_TAI_CUNG_LUC)
dl_queue_lock = threading.Lock()
dl_waiting = []     # assetId dang xep hang (theo thu tu vao) -> bao "con N video truoc"
stream_procs = {}   # streamId -> {"proc","restarts","started","deadAt"}
# TAI DAY TUC THI (28/08/2026): truoc day luong chet phai cho vong giam sat ngu du 2s
# moi phat hien, cong xac nhan o nhip sau -> nguoi xem thay dut ~4s. Nay thread doc
# tien do bao TU NGAY khi ffmpeg dong ong (EOF) -> danh chuong wake_event -> vong
# giam sat tinh ngay va bat lai. Dut chi con thoi gian ffmpeg noi lai RTMP (<1s).
wake_event = threading.Event()
desired_live = {}   # streamId -> stream dict (cac luong PHAI song) -> cho giam sat phuc hoi nhanh
recently_stopped = set()  # streamId vua DUNG -> sync bao status=stopped 1 LAN cho server (tranh dong bang "live")
# DU PHONG NHIEU VPS (r2.22) — "TU DUNG KHI CO LAP". CHI ap cho luong bat leaseEnabled (server gui khi
# RISE_LIVE_LEASE=1 VA luong failoverMode=automatic). Neu mat lien lac may chu qua "grace" giay -> may
# nay co the DA bi chuyen luong sang may khac -> tu dung de KHONG phat trung. Luong thuong KHONG dinh.
# Mac dinh: khong luong nao enabled -> khong bao gio tu dung -> hanh vi Y HET r2.21.
lease_state = {"last_ok": time.time(), "grace": 60, "enabled": {}, "fenced": set()}
# Circuit breaker (RL-PRC-003): luong chop tat qua nhieu trong cua so ngan -> TAM NGUNG tu bat lai (chong
# vong lap tight vo han). KHAC truoc: khong ngung HAN cho tay nua, ma TU THU LAI sau RETRY_AFTER (5 phut);
# neu van chop tat -> ngat tiep -> cho 5 phut -> thu lai... lap mai (co kiem soat: 1 dot/5 phut, khong tight loop).
# Reset ngay khi nguoi dung Dung luong (stop_stream).
# NANG CAP (bro chot 2 quy tac):
#  - Loi NGUON/FILE (file video hong/thieu/decode loi): VINH VIEN -> DUNG NGAY, khong tu bat lai (khoi phi).
#  - Loi MANG / VPS su co (rot ket noi, timeout...): TAM THOI -> tu thu lai moi 5 phut MAI cho toi khi het su co.
RESTART_WINDOW = 120      # giay - cua so dem restart
RESTART_MAX = 5           # > so nay trong cua so -> ngat (chong tight-loop)
RETRY_AFTER = 300         # giay - TRAN cho toi da (bac cuoi cua thang duoi), giu ten cu cho tuong thich
# BAC THU LAI (r2.39, 30/08/2026) — Chu Rise Group duyet.
#
# TRUOC: ngat roi cho CUNG 300 giay moi thu lai, bat ke mang da ve hay chua. Mang chi chet 30 giay
# thi luong van nam im them 4 phut ruoi VO ICH. Do that ngay 29/08: 86 lan mat song 301 giay tren
# 3 may Lowendviet — trong do phan lon mang da ve tu lau, chi la dang cho het 5 phut.
#
# NAY: cho theo BAC TANG DAN. Mang chap 30 giay -> song len lai sau ~40 giay thay vi 5 phut.
# Mang chet that -> bac tu leo len 300 giay va O DO, lap mai cho toi khi song lai (khong bo cuoc).
#
#   ngat lan 1 -> cho  20s      ngat lan 4 -> cho 120s
#   ngat lan 2 -> cho  40s      ngat lan 5 tro di -> cho 300s, lap mai
#   ngat lan 3 -> cho  60s
#
# VI SAO VAN AN TOAN: bac van gian dan nen KHONG quay tit. Va thang nay chi cham toi loi TAM THOI
# (mang/VPS su co) — loi NGUON/FILE da bi chan tu truoc do (stopped_for_human: dung han, khong tu
# thu lai), loi Live Pub qua khung an han cung vay. Nen khong co chuyen thu lai vo ich mot file hong.
#
# BAC TU RESET khi luong chay on dinh qua STABLE_RESET_SEC (coi nhu da khoi phuc that) hoac khi
# nguoi dung bam Dung tay.
RETRY_LADDER = [20, 40, 60, 120, RETRY_AFTER]   # giay - cac bac cho, bac cuoi lap mai
STABLE_RESET_SEC = 300    # chay on dinh > nay -> coi nhu da khoi phuc, go trang thai DUNG-HAN neu co
PUB_GRACE_SEC = 90        # giay - luong Pub rot tin hieu: cho TU KET NOI LAI trong khung nay (broken pipe chop
                          # nhoang -> noi tiep buoi cu). Van rot suot ca khung -> luc ay moi coi la YouTube dong buoi.
SSD_MIN_FREE_GB = 15      # RL-RES-002: duoi nguong nay -> CHAN tai/nen video moi (bao ve luong dang chay)
# GOI MAY CHU — CHO BAO LAU, HUT THI THU LAI SAU BAO LAU (r2.38, 30/08/2026).
#
# VI SAO. Nhip hoi binh thuong la 20 giay. Nhung khi MOT lan goi bi rot, vong lap cu lam the nay:
#     ngu 20 -> goi -> treo het timeout (30) -> that bai -> ngu TIEP 20 -> goi lai -> duoc
#     = 20 + 30 + 20 + 1 = 71 giay IM LANG
# Trong khi may chu coi may la "mat ket noi" khi im qua 60 giay. Tuc la CHI CAN ROT MOT GOI TIN
# la du sinh BAO DONG AO — va te hon nhieu: dung nguong 60 giay do con dieu khien 2 co che tu dong
#   1. tu chuyen luong uu tien sang may khac,
#   2. worker TU DUNG luong vi tuong minh bi co lap (lease).
# Do that ngay 30/08 tai VPS 05: im dung 72 giay (18:14:04 -> 18:15:16), may song nguyen, luong phat
# lien tuc, nhung van bao "28 luong dang tat". Khop chinh xac cong thuc tren.
#
# (Truoc 20/08 nhip hoi la 10 giay nen cong thuc ra 51 giay < 60 -> khong bao gi. Viec gian nhip
#  10->20 de cat ~50% chi phi Firestore da an mat khoang an toan do. Sua o day de GIU duoc phan
#  tiet kiem ma van rong hon truoc.)
#
# CACH SUA. May chu tra loi thuc te ~0,6 giay, nen cho 15 giay da rong rai gap 25 lan, du ca luc
# may chu vua khoi dong nguoi. Goi hut thi thu lai sau 5 giay — nhung chi 3 lan lien tiep, sau do
# ve nhip thuong de KHONG doi may chu khi no chet that.
#     Khoang im toi da con: 20 + 15 + 5 + 1 = 41 giay  <  60  -> con du 19 giay.
# Khong doi nguong 60 giay nao, khong ton them mot luot doc Firestore nao (chi chay khi CO LOI).
SYNC_TIMEOUT = 15         # giay - cho may chu tra loi
SYNC_RETRY_SEC = 5        # giay - goi hut thi thu lai nhanh (thay vi ngu du nhip)
SYNC_RETRY_MAX = 3        # so lan thu nhanh lien tiep, qua so nay coi nhu may chu chet that -> ve nhip thuong
restart_history = {}      # sid -> [timestamp restart gan day]
restart_halted = {}       # sid -> timestamp luc bi NGAT (de biet khi nao du gio thi thu lai)
restart_bac = {}          # sid -> BAC thang cho da dung (0..len-1), tang dan moi lan ngat, reset khi on dinh
restart_cho = {}          # sid -> so giay PHAI cho cua dot ngat HIEN TAI (lay tu RETRY_LADDER)
stopped_for_human = set() # sid DUNG HAN vi LOI NGUON/FILE -> khong tu thu, cho nguoi sua nguon/Dung-Bat lai
pub_grace   = {}          # sid Pub -> thoi diem BAT DAU rot (do khung an han PUB_GRACE_SEC truoc khi bo cuoc)
# ẢNH XEM TRƯỚC — TÁCH LÀM 2 NHỊP (r2.31). Trước đây gộp làm một (45s): vừa chụp+dò MÀN ĐEN, vừa ĐẨY
# ảnh lên máy chủ. Với ~100 luồng thì ~140 ảnh/phút dội về -> route nặng nhất, làm CHẬM TOÀN APP Rise Work.
#  • THUMB_SCAN_SEC  = chụp + DÒ MÀN ĐEN, chạy TẠI VPS, KHÔNG tốn máy chủ -> giữ DÀY (60s) để phát hiện
#    màn đen vẫn nhanh như cũ.
#  • THUMB_PUSH_SEC  = ĐẨY ảnh lên máy chủ (thứ gây tải) -> GIÃN HẲN (mặc định 300s = 5 phút).
# Ảnh chỉ để NHÌN cho biết luồng đang phát gì; còn luồng sống/khỏe/tụt đã có chỉ số riêng báo mỗi ~20s.
THUMB_SCAN_SEC = 60
THUMB_PUSH_DEFAULT = 300
thumb_state = {"push": THUMB_PUSH_DEFAULT}     # may chu chinh duoc qua sync (thumbPushSec)
thumb_last_push = {}                            # sid -> thoi diem day anh len may chu gan nhat
last_reason = {}          # sid -> ly do rot gan nhat (de phan loai loi nguon/file)

def _is_source_error(reason):
    # Loi NGUON/FILE (khong tu lanh): file hong/thieu/dinh dang la/decode loi.
    r = (reason or "").lower()
    keys = ["no such file", "invalid data", "moov atom", "error opening", "does not contain",
            "invalid argument", "could not find codec", "unable to", "khong doc", "file video"]
    return any(k in r for k in keys)
incidents    = []   # [{streamId,kind,at,downSec}] su co -> gui kem heartbeat roi xoa
stream_lock  = threading.Lock()   # noi tiep ensure/stop giua giam sat + reconcile (tranh chay dua)
upload_mbps  = None # bang thong DAY toi da (do 1 lan bang speedtest, best-effort)
_last_tx     = None # (tong byte TX, thoi diem) -> tinh throughput DANG dung thuc
lock = threading.Lock()
# HANG DOI NEN: gioi han so video nen (re-encode) DONG THOI de CPU khong qua tai khi nhieu
# nguoi cung them video. So con lai xep hang cho. Chinh qua env RISE_LIVE_MAX_ENCODE.
try:
    MAX_ENCODE = int(os.environ.get("RISE_LIVE_MAX_ENCODE") or max(1, (os.cpu_count() or 4) // 8))
except Exception:
    MAX_ENCODE = 2
_encode_sem = threading.Semaphore(max(1, MAX_ENCODE))

# UP THANG TU MAY: tool o may nhan vien NEN san roi TAI THANG file da chuan len VPS -> VPS KHONG
# nen lai (chi phat). Server nhan file (PUT /upload) xac thuc bang TOKEN. File duoc luu san sang;
# worker bao ve Rise Work de tao ban ghi video (o lan sync ke tiep).
pending_uploads = []  # [{id,name,uploaderEmail,presetId,sizeMb}]
UPLOAD_PORT = int(os.environ.get("RISE_LIVE_UPLOAD_PORT") or 8099)
# Token RIENG cho tai len (khac token worker) -> an toan de hien cho nguoi van hanh: chi cho
# TAI FILE len, khong cho truy cap API worker. Khong dat -> tat tinh nang upload.
UPLOAD_TOKEN = (os.environ.get("RISE_LIVE_UPLOAD_TOKEN") or "").strip()

def probe_media(path):
    # Doc do phan giai (width,height) + thoi luong bang ffprobe — de hien trong Kho video.
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "stream=width,height", "-show_entries", "format=duration",
                            "-of", "json", path], capture_output=True, text=True, timeout=30)
        j = json.loads(r.stdout or "{}")
        st = (j.get("streams") or [{}])[0]
        w = int(st.get("width") or 0); h = int(st.get("height") or 0)
        dur = float((j.get("format") or {}).get("duration") or 0)
        return w, h, round(dur)
    except Exception:
        return 0, 0, 0

def _doc_ban_cong_cu():
    # Doc ban yt-dlp + co gdown chua -> ghi vao tool_state de bao ve may chu.
    try:
        r = subprocess.run(["yt-dlp", "--version"], capture_output=True, text=True, timeout=30)
        tool_state["ytdlp"] = (r.stdout or "").strip().splitlines()[0][:40] if r.returncode == 0 else ""
    except Exception:
        tool_state["ytdlp"] = ""
    tool_state["gdown"] = bool(shutil.which("gdown"))
    tool_state["updatedAt"] = time.time()

def _pip_chay():
    # Tim cach goi pip. Tra ve list lenh, hoac None neu may KHONG co pip nao ca.
    #  1) pipx (neu yt-dlp da cai qua pipx) -> khong sua package do Ubuntu/Debian quan ly.
    #  2) pip3 (chuan)  3) python3 -m pip (khi thieu lenh pip3 nhung co module).
    # Truoc day CHI tim ~/.local/bin/pipx -> may co pip3 van bi bao "KHONG co pip3" (bao oan).
    pipx = shutil.which("pipx") or os.path.expanduser("~/.local/bin/pipx")
    if os.path.isfile(pipx):
        return [pipx, "runpip", "yt-dlp"]
    if shutil.which("pip3"):
        return ["pip3"]
    try:
        r = subprocess.run([sys.executable or "python3", "-m", "pip", "--version"], capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            return [sys.executable or "python3", "-m", "pip"]
    except Exception:
        pass
    return None

def _goi_can_cai():
    # Danh sach goi lay tu requirements.txt: canh file worker, hoac tai tu may chu ($RISE_LIVE_URL/requirements.txt).
    # Khong co file -> dung danh sach mac dinh.
    req = os.path.join(os.path.dirname(os.path.abspath(__file__)), "requirements.txt")
    if not os.path.isfile(req):
        try:
            urllib.request.urlretrieve(URL + "/requirements.txt", req)
        except Exception:
            return ["yt-dlp", "gdown"]
    return ["-r", req]

def _auto_update_tools():
    # Google HAY doi cach tai Drive -> yt-dlp/gdown cu la HONG. Tu cap nhat khi khoi dong + moi ngay
    # (best-effort, chay nen, khong chan luong chinh). Nho vay tai Drive it hong dan theo thoi gian.
    #
    # r2.34 — KHONG NUOT LOI NUA. Truoc day khoi nay goi thang "pip3"; may khong co pip3 thi
    # FileNotFoundError bi nuot, vong lap ngu tiep 24h, khong ai biet. Do dung la thu gay ra su co
    # VPS 06 (29-30/08/2026). Nay: thieu pip -> ghi ly do vao tool_state -> sync bao ve may chu ->
    # giao dien Live hien canh bao. Ban cong cu cung duoc bao ve moi nhip.
    while True:
        _doc_ban_cong_cu()
        pip = _pip_chay()
        if not pip:
            tool_state["updateError"] = ("May KHONG co pip3 (va cung khong goi duoc python3 -m pip) nen "
                                         "KHONG tu cap nhat duoc yt-dlp/gdown. Cach xu: SSH vao may chay "
                                         "'apt-get install -y python3-pip' roi restart rise-live.")
            print("CANH BAO: " + tool_state["updateError"])
        else:
            loi = ""
            for extra in ([], ["--break-system-packages"]):
                try:
                    r = subprocess.run([*pip, "install", "-U", *extra, *_goi_can_cai()], capture_output=True, text=True, timeout=600)
                    if r.returncode == 0:
                        loi = ""; print("auto-update yt-dlp/gdown OK"); break
                    loi = ((r.stderr or r.stdout or "").strip()[-200:]) or "pip bao loi khong ro"
                except Exception as e:
                    loi = str(e)[-200:]
            tool_state["updateError"] = ("Tu cap nhat yt-dlp/gdown that bai: " + loi) if loi else ""
            if loi: print("CANH BAO: " + tool_state["updateError"])
            _doc_ban_cong_cu()
        # Thieu han cong cu tai -> noi ro (day la loi lam Drive tai cham/hong).
        if not tool_state["ytdlp"]:
            tool_state["updateError"] = (tool_state["updateError"] + " · " if tool_state["updateError"] else "") + "May CHUA CO yt-dlp — tai video tu Drive se cham hoac hong."
        time.sleep(24 * 3600)

class UploadHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # de tu xu ly "Expect: 100-continue" cua Windows khi tai file lon
    def log_message(self, *a):
        pass
    def _reply(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")   # CORS (r2.25): cho trang Rise Work (khac host) doc ket qua
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        # GUI THAN CAU TRA LOI (r2.42, 30/08/2026 — sua loi co tu r2.25).
        # LOI CU: dong nay bi lac xuong cuoi do_OPTIONS (noi khong he co bien `body`, nen no nem loi
        # va bi try/except nuot im). Hau qua: _reply HUA "Content-Length: N" roi KHONG GUI GI. Ben goi
        # doi du N byte -> TREO MAI. Do that 30/08: goi /upload nhan dung ma 404 nhung treo 10 giay.
        # Anh huong MOI cau tra loi cua worker, ke ca cau bao "tai len THANH CONG" (dong ~293) — nen
        # tai-thang tu may tinh chay xong van nhin nhu dang treo. Lau nay khong lo vi tai-thang chua
        # bao gio noi duoc toi worker (thieu HTTPS); nay dung xong Caddy thi lo ra.
        try:
            self.wfile.write(body)
        except Exception:
            pass
    def do_OPTIONS(self):
        # CORS PREFLIGHT (r2.25): trinh duyet gui OPTIONS truoc khi PUT chuyen tiep (trang Rise Work khac
        # host). Khong co ham nay -> BaseHTTP tra 501 -> trinh duyet CHAN tai len (loi tren may KHONG co
        # Caddy tu xu ly CORS, vd cac VPS moi). Tra 204 + header CORS de qua preflight.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "PUT, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()
        # (Da go dong "self.wfile.write(body)" lac o day — xem giai thich trong _reply. OPTIONS tra
        #  204 khong than, Content-Length: 0, nen ket thuc o day la dung.)
    def do_PUT(self):
        dest = None; aid = None
        try:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if not UPLOAD_TOKEN or q.get("token", [""])[0] != UPLOAD_TOKEN:
                self._reply(401, {"ok": False, "error": "unauthorized"}); return
            name = (q.get("name", ["video"])[0])[:120]
            email = (q.get("email", [""])[0]).lower()
            preset = q.get("preset", [""])[0]
            length = int(self.headers.get("Content-Length") or 0)
            aid = uuid.uuid4().hex
            os.makedirs(ASSETS, exist_ok=True)   # tu tao lai neu thu muc bi xoa -> khong loi "No such file"
            dest = os.path.join(ASSETS, aid + ".mp4")
            with lock:   # DANH DAU BAO VE TRUOC KHI GHI -> ham don (reconcile) khong xoa nham file dang tai
                asset_local[aid] = {"status": "uploading", "path": dest, "working": True}
            remaining = length
            with open(dest, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    f.write(chunk); remaining -= len(chunk)
            if length and remaining > 0:   # nhan thieu -> khong luu file hong, bao loi that
                raise IOError("nhan thieu du lieu (con %d/%d byte) - ket noi bi ngat" % (remaining, length))
            size_mb = round(os.path.getsize(dest) / 1e6, 1)
            w, h, dur = probe_media(dest)   # do phan giai + thoi luong -> hien trong Kho video
            with lock:
                asset_local[aid] = {"status": "ready", "path": dest, "sizeMb": size_mb, "working": False, "width": w, "height": h, "durationSec": dur}
                pending_uploads.append({"id": aid, "name": name, "uploaderEmail": email, "presetId": preset, "sizeMb": size_mb, "width": w, "height": h, "durationSec": dur})
            print("UPLOAD OK: %s (%s MB) tu %s" % (name, size_mb, email or "?"))
            self._reply(200, {"ok": True, "id": aid})
        except Exception as e:
            import traceback
            print("UPLOAD LOI:", repr(e)); traceback.print_exc()
            if aid:
                with lock: asset_local.pop(aid, None)   # bo dau bao ve neu upload that bai
            if dest:
                try: os.remove(dest)
                except Exception: pass
            self._reply(500, {"ok": False, "error": str(e)[:200]})
    def _serve_asset(self, q):
        # COPY VPS->VPS: phuc vu file .mp4 DA CHUAN cho VPS khac keo ve (copy luong uu tien khong qua Drive).
        # Xac thuc bang UPLOAD_TOKEN (token tai-len) vi day la token DUNG CHUNG moi VPS. (KHONG dung TOKEN
        # worker vi moi may co token worker RIENG -> may dich va may nguon khac token -> 401.) Chi phuc vu READY.
        # basename(id) -> chong path traversal. Stream theo khoi 1MB (file co the vai GB, khong doc het vao RAM).
        if not UPLOAD_TOKEN or q.get("token", [""])[0] != UPLOAD_TOKEN:
            self._reply(401, {"ok": False, "error": "unauthorized"}); return
        aid = os.path.basename(q.get("id", [""])[0])
        fp = os.path.join(ASSETS, aid + ".mp4"); loc = asset_local.get(aid)
        if not aid or not os.path.exists(fp) or not (loc and loc.get("status") == "ready"):
            self._reply(404, {"ok": False, "error": "asset not ready"}); return
        try:
            size = os.path.getsize(fp)
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(size))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            with open(fp, "rb") as f:
                while True:
                    chunk = f.read(1024 * 1024)
                    if not chunk: break
                    self.wfile.write(chunk)
        except Exception:
            pass
    def do_GET(self):
        # Phuc vu ANH THAT dang phat: GET /thumb?id=<streamId>&token=<upload token> -> anh JPG.
        # Xac thuc bang token upload; CORS mo de trang Rise Work (khac host) tai duoc anh.
        try:
            u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
            if u.path.rstrip("/") == "/asset":
                self._serve_asset(q); return   # COPY VPS->VPS: phuc vu file .mp4 da chuan cho VPS khac
            if u.path.rstrip("/") != "/thumb":
                self._reply(404, {"ok": False, "error": "not found"}); return
            if not UPLOAD_TOKEN or q.get("token", [""])[0] != UPLOAD_TOKEN:
                self._reply(401, {"ok": False, "error": "unauthorized"}); return
            sid = os.path.basename(q.get("id", [""])[0])   # basename -> chong path traversal
            fp = os.path.join(THUMBS, sid + ".jpg")
            if not sid or not os.path.exists(fp):
                self.send_response(404); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Content-Length", "0"); self.end_headers(); return
            with open(fp, "rb") as f: data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try: self.wfile.write(data)
            except Exception: pass
        except Exception:
            try:
                self.send_response(500); self.send_header("Content-Length", "0"); self.end_headers()
            except Exception: pass

def start_upload_server():
    try:
        http.server.ThreadingHTTPServer(("0.0.0.0", UPLOAD_PORT), UploadHandler).serve_forever()
    except Exception as e:
        print("upload server loi:", str(e)[:120])

def tx_bytes():
    # Tong byte da GUI RA tren cac card mang (bo loopback) -> de tinh throughput thuc.
    total = 0
    try:
        with open("/proc/net/dev") as f:
            for ln in f.readlines()[2:]:
                p = ln.replace(":", " ").split()
                if not p or p[0] == "lo":
                    continue
                total += int(p[9])   # cot TX bytes
    except Exception:
        pass
    return total

def measure_upload():
    # Do toc do DAY (upload) 1 LAN luc khoi dong — best-effort (khong do lap -> khong dung luong dang phat).
    # Uu tien Ookla speedtest (tu chon server GAN + do DA LUONG -> chinh xac cho link toc do cao);
    # khong co Ookla thi lui ve speedtest-cli python (co the chon server xa -> kem chinh xac).
    global upload_mbps
    # 1) Ookla speedtest: -f json -> upload.bandwidth (bytes/giay).
    try:
        r = subprocess.run(["speedtest", "--accept-license", "--accept-gdpr", "-f", "json"], capture_output=True, text=True, timeout=180)
        if r.returncode == 0 and (r.stdout or "").strip():
            bw = float(json.loads(r.stdout).get("upload", {}).get("bandwidth", 0))  # bytes/s
            if bw > 0:
                upload_mbps = round(bw * 8 / 1e6)
                return
    except Exception:
        pass
    # 2) Fallback: speedtest-cli python.
    try:
        r = subprocess.run(["speedtest-cli", "--simple"], capture_output=True, text=True, timeout=120)
        for ln in (r.stdout or "").splitlines():
            if ln.strip().startswith("Upload"):
                upload_mbps = round(float(ln.split()[1]))
                return
    except Exception:
        pass

def sh(args, timeout=None):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)

_YT_TIEN_DO = _re.compile(r"\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)\s*(KiB|MiB|GiB)", _re.I)
_DON_VI = {"kib": 1024.0, "mib": 1024.0 ** 2, "gib": 1024.0 ** 3}

def sh_ytdlp_tien_do(args, timeout=None, tien_do=None):
    # CHAY yt-dlp VA DOC TIEN DO (r2.35). Vi sao can: tien do % ban r2.34 CHI gan duoc vao duong tai
    # tu viet; khi duong do khong an va lui ve yt-dlp thi nguoi dung lai thay "Dang tai" dung im nhu cu
    # (do that 30/08/2026: video TEST 2 tren VPS 06 tai het 3,6 phut ma khong hien mot % nao).
    # yt-dlp CO in tien do ra man hinh — chi can doc dong do. Tra ve doi tuong giong subprocess.run.
    if not tien_do:
        return sh(args, timeout=timeout)
    try:
        p = subprocess.Popen([*args, "--newline"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    except Exception:
        return sh(args, timeout=timeout)     # khong chay duoc kieu nay -> ve cach cu, khong lam hong gi
    han = time.time() + (timeout or 3600)
    duoi = []
    try:
        for dong in p.stdout:
            duoi.append(dong)
            if len(duoi) > 40: duoi.pop(0)   # chi giu vai dong cuoi de bao loi
            k = _YT_TIEN_DO.search(dong)
            if k:
                try:
                    pct = float(k.group(1)); tong = float(k.group(2)) * _DON_VI[k.group(3).lower()]
                    tien_do(int(tong * pct / 100.0), int(tong))
                except Exception:
                    pass
            if time.time() > han:
                p.kill(); break
    except Exception:
        pass
    try: err = p.stderr.read()
    except Exception: err = ""
    p.wait()
    class _KQ: pass
    kq = _KQ(); kq.returncode = p.returncode; kq.stdout = "".join(duoi); kq.stderr = err or ""
    return kq

def heartbeat():
    hb = {}
    try: hb["vcpu"] = os.cpu_count() or 0
    except Exception: pass
    try:
        with open("/proc/meminfo") as f:
            for ln in f:
                if ln.startswith("MemTotal"): hb["ramGb"] = round(int(ln.split()[1]) / 1024 / 1024, 1); break
    except Exception: pass
    try:
        t, u, fr = shutil.disk_usage("/"); hb["diskGb"] = round(t/1e9); hb["diskFreeGb"] = round(fr/1e9)
    except Exception: pass
    try: hb["loadAvg"] = round(os.getloadavg()[0], 2)
    except Exception: pass
    if upload_mbps: hb["uploadMbps"] = upload_mbps
    # Throughput DANG dung thuc (Mbps) giua 2 lan bao -> cho "con X luong" real-time.
    global _last_tx
    try:
        cur = tx_bytes(); now = time.time()
        if _last_tx and now > _last_tx[1]:
            rate = (cur - _last_tx[0]) / (now - _last_tx[1])   # bytes/s
            if rate >= 0: hb["txMbps"] = round(rate * 8 / 1e6, 1)
        _last_tx = (cur, now)
    except Exception:
        pass
    # CONG CU TAI (r2.34) — de giao dien biet may nao dung ban cu / tu cap nhat hong.
    if tool_state.get("ytdlp"): hb["ytdlpVersion"] = tool_state["ytdlp"]
    hb["gdownOk"] = bool(tool_state.get("gdown"))
    hb["toolError"] = str(tool_state.get("updateError") or "")[:300]
    return hb

def _drive_tu_tai(fid, raw, timeout=3600, tien_do=None):
    # TAI DRIVE BANG CHINH MINH — khong phu thuoc yt-dlp/gdown.
    #
    # Vi sao can (Chu Rise Group 29/08/2026 — "tim cach xu ly triet de"):
    #  · File LON (>~100MB) thi Google KHONG tra file ngay, ma tra TRANG XAC NHAN
    #    "Virus scan warning" bat bam nut. Cong cu ngoai khung o day -> nhan ve 1 trang
    #    HTML 2KB thay vi video, roi bao loi kieu "check permissions" (gay hieu nham la
    #    thieu quyen, trong khi quyen VAN MO).
    #  · yt-dlp/gdown ban CU con tai rat cham: do that VPS 06 chi 58 MB/phut trong khi
    #    3 may kia ~1.100 MB/phut (cham 20 LAN) — vi ban apt cu chay duong 1 luong.
    #  · Va Google hay doi cach tai -> cong cu ngoai hong theo, phai cho ho cap nhat.
    #
    # Cach nay: tai thang bang thu vien co san cua Python, TU xu trang xac nhan (doc form
    # an roi goi lai dung dia chi + tham so). Khong cai them gi, khong ai lam hong duoc.
    # Van GIU yt-dlp/gdown lam duong lui phia sau.
    try:
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        op.addheaders = [("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) RiseLiveAgent")]
        url = "https://drive.google.com/uc?export=download&id=%s" % fid

        for vong in range(3):                      # toi da 3 vong: goc -> trang xac nhan -> file
            r = op.open(url, timeout=120)
            ctype = (r.headers.get("Content-Type") or "").lower()
            if "text/html" not in ctype:
                # Da la FILE -> ghi thang ra dia theo tung khuc (khong nap het vao RAM).
                tmp = raw + ".part"
                got = 0
                tong = 0
                try: tong = int(r.headers.get("Content-Length") or 0)
                except Exception: tong = 0
                han = time.time() + timeout
                bao_lan_cuoi = 0.0
                with open(tmp, "wb") as f:
                    while True:
                        if time.time() > han:
                            try: os.remove(tmp)
                            except Exception: pass
                            return False, "tai qua lau (qua %ds)" % timeout
                        chunk = r.read(1024 * 1024)
                        if not chunk: break
                        f.write(chunk); got += len(chunk)
                        # TIEN DO (r2.34): bao toi da 1 lan/2 giay — du muot cho nguoi xem, khong ton gi.
                        if tien_do and time.time() - bao_lan_cuoi >= 2:
                            bao_lan_cuoi = time.time(); tien_do(got, tong)
                if got <= 0:
                    try: os.remove(tmp)
                    except Exception: pass
                    return False, "file rong"
                os.replace(tmp, raw)
                return True, ""

            # Con la HTML -> hoac TRANG XAC NHAN, hoac trang BAO LOI cua Google.
            html = r.read(200000).decode("utf-8", "ignore")
            thap = html.lower()
            # DOC THANG LY DO THAT tu Google — quan trong hon moi thu. Truoc day chi thay cau chung
            # chung cua gdown ("check connections and permissions") nen ca doi di kiem quyen ca buoi
            # trong khi that ra Google chan HAN MUC TAI (Chu Rise phat hien 29/08/2026).
            if "quota exceeded" in thap or "too many users have viewed" in thap:
                return False, ("Google KHOA HAN MUC TAI file nay (bi tai qua nhieu lan trong ngay). "
                               "KHONG phai loi quyen, cung khong phai file hong. Cach xu: tao BAN SAO cua file "
                               "tren Drive roi dan link ban sao (ban sao co han muc rieng), hoac cho ~24 gio, "
                               "hoac dung 'Tai video len' keo-tha tu may tinh.")
            if "cannot be scanned" in thap or "virus scan warning" in thap:
                pass                                     # trang xac nhan binh thuong -> di tiep
            elif "access denied" in thap or "request access" in thap or "you need access" in thap:
                return False, "File CHUA MO QUYEN: mo tren Drive -> Chia se -> 'Bat ky ai co duong lien ket' (Nguoi xem)."
            # Chi lay form TAI (id=download-form) — trang co the co form khac.
            khoi = _re.search(r'<form[^>]*id="download-form"[^>]*>.*?</form>', html, _re.I | _re.S)
            vung = khoi.group(0) if khoi else html
            act = _re.search(r'action="([^"]+)"', vung)
            if not act:
                return False, "Google tra ve trang la (khong tim thay nut tai) — thu lai sau, hoac dung 'Tai video len'"
            dia_chi = act.group(1).replace("&amp;", "&")
            # Doc TUNG the <input> roi lay name/value — khong phu thuoc THU TU thuoc tinh
            # (Google doi thu tu la regex ghep doi se hong ngay).
            tham_so = {}
            for the in _re.findall(r'<input[^>]*>', html, _re.I):
                ten = _re.search(r'name="([^"]*)"', the)
                gia = _re.search(r'value="([^"]*)"', the)
                if ten and ten.group(1) and ten.group(1) != "submit":
                    tham_so[ten.group(1)] = gia.group(1) if gia else ""
            url = dia_chi + ("&" if "?" in dia_chi else "?") + urllib.parse.urlencode(tham_so)

        return False, "qua nhieu vong xac nhan"
    except Exception as e:
        return False, str(e)[-200:]


def _download_drive(fid, raw, tien_do=None):
    # Tai file Drive cong khai. Thu NHIEU cach cho ben (Google hay doi cach tai, gdown hay hong):
    #  1) yt-dlp (khoe nhat, bao tri tot) -> tai vao thu muc rieng roi lay file ra.
    #  2) gdown (giu tuong thich cu) — 2 kieu goi.
    # Tra (True, "") neu duoc; (False, loi) neu het cach.
    last = ""
    # CACH 0 (uu tien): tu tai, tu xu trang xac nhan file lon. Nhanh + khong phu thuoc cong cu ngoai.
    ok0, err0 = _drive_tu_tai(fid, raw, tien_do=tien_do)
    if ok0:
        return True, ""
    last = err0 or ""
    view_url = "https://drive.google.com/file/d/%s/view" % fid
    dl_url = "https://drive.google.com/uc?id=%s&export=download" % fid
    tmpdir = raw + ".ytdl"
    try:
        shutil.rmtree(tmpdir, ignore_errors=True); os.makedirs(tmpdir, exist_ok=True)
        r = sh_ytdlp_tien_do(["yt-dlp", "--no-playlist", "--no-part", "-o", os.path.join(tmpdir, "f.%(ext)s"), view_url], timeout=3600, tien_do=tien_do)
        got = [os.path.join(tmpdir, x) for x in os.listdir(tmpdir)] if os.path.isdir(tmpdir) else []
        got = [f for f in got if os.path.isfile(f) and os.path.getsize(f) > 0]
        if r.returncode == 0 and got:
            os.replace(max(got, key=os.path.getsize), raw)
            shutil.rmtree(tmpdir, ignore_errors=True)
            return True, ""
        last = (r.stderr or "")[-200:]
    except FileNotFoundError:
        last = "yt-dlp chua cai (dang thu gdown)"
    except Exception as e:
        last = str(e)[-200:]
    shutil.rmtree(tmpdir, ignore_errors=True)
    for cmd in (["gdown", fid, "-O", raw], ["gdown", dl_url, "-O", raw, "--no-cookies"]):
        try:
            r = sh(cmd, timeout=3600)
            if r.returncode == 0 and os.path.exists(raw) and os.path.getsize(raw) > 0:
                return True, ""
            last = (r.stderr or "")[-200:] or last
        except FileNotFoundError:
            last = "gdown chua cai"
        except Exception as e:
            last = str(e)[-200:]
    return False, last

def _http_pull(url, dest, tien_do=None):
    # COPY VPS->VPS: keo file .mp4 DA CHUAN tu VPS nguon ve -> ghi file TAM roi KIEM TRA du byte
    # (Content-Length). Thieu byte -> bo file, bao loi (KHONG luu file hong). Tra (ok, err).
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=120) as r:
            total = int(r.headers.get("Content-Length") or 0)
            got = 0
            bao_lan_cuoi = 0.0
            with open(dest, "wb") as f:
                while True:
                    chunk = r.read(1024 * 1024)
                    if not chunk: break
                    f.write(chunk); got += len(chunk)
                    if tien_do and time.time() - bao_lan_cuoi >= 2:
                        bao_lan_cuoi = time.time(); tien_do(got, total)
        if total and got < total:
            try: os.remove(dest)
            except Exception: pass
            return False, "nhan thieu (%d/%d byte)" % (got, total)
        if got == 0:
            try: os.remove(dest)
            except Exception: pass
            return False, "file rong"
        return True, ""
    except Exception as e:
        try: os.remove(dest)
        except Exception: pass
        return False, str(e)[:200]

def normalize(asset):
    # r2.34 — XEP HANG TAI. Toi da MAX_TAI_CUNG_LUC video cung tai tren 1 may; con lai xep hang co
    # THU TU va bao ra "dang xep hang, con N video truoc". Truoc day 10 video cung tai thi cung gianh
    # bang thong roi CUNG cham, giao dien chi hien "Cho xu ly" -> nhan su tuong he thong treo.
    # Video CHEP tu VPS khac cung tinh vao han nay (cung an bang thong may).
    aid = asset["id"]
    with lock: asset_local[aid] = {"status": "waiting", "working": True}
    with dl_queue_lock: dl_waiting.append(aid)
    try:
        while not dl_sem.acquire(timeout=5):
            with dl_queue_lock:
                truoc = dl_waiting.index(aid) if aid in dl_waiting else 0
            with lock:
                v = asset_local.get(aid) or {}
                v.update({"status": "waiting", "working": True, "queueAhead": truoc})
                asset_local[aid] = v
    finally:
        with dl_queue_lock:
            if aid in dl_waiting: dl_waiting.remove(aid)
    try:
        _normalize_run(asset)
    finally:
        dl_sem.release()

def _normalize_run(asset):
    aid = asset["id"]; p = asset.get("preset") or {}
    fid = asset.get("driveFileId", "")
    out = os.path.join(ASSETS, aid + ".mp4"); raw = os.path.join(RAW, aid + ".src"); outp = out + ".part"
    bat_dau_tai = time.time()
    def bao_tien_do(got, tong):
        # TIEN DO % (r2.34): nguoi dung nhin thay video dang chay toi dau, khong con doan gia.
        with lock:
            v = asset_local.get(aid) or {}
            v.update({"status": "downloading", "working": True,
                      "downloadedMb": round(got / 1e6, 1),
                      "totalMb": (round(tong / 1e6, 1) if tong else 0),
                      "progressPct": (max(0, min(100, int(got * 100 / tong))) if tong else None)})
            asset_local[aid] = v
    def toc_do_mb_phut(duong_dan):
        # MB/phut cua lan tai nay -> may chu canh bao khi may nao tai cham bat thuong.
        try:
            giay = max(0.001, time.time() - bat_dau_tai)
            return round((os.path.getsize(duong_dan) / 1e6) / (giay / 60.0), 1)
        except Exception:
            return None
    try:
        with lock: asset_local[aid] = {"status": "downloading", "working": True}
        # COPY THANG VPS->VPS (uu tien): neu asset la ban SAO tu VPS khac (co copyFrom) -> keo file DA CHUAN
        # tu VPS nguon ve, GIU NGUYEN chat luong goc, KHONG tai Drive (Drive ha file lon xuong 360p), KHONG
        # nen lai. Chi khi copyFrom that bai moi bao loi RO (khong am tham lui ve Drive 360p).
        cf = asset.get("copyFrom") or {}
        if cf.get("url") and cf.get("assetId"):
            try: free_gb = shutil.disk_usage(BASE).free / (1024**3)
            except Exception: free_gb = None
            if free_gb is not None and free_gb < SSD_MIN_FREE_GB:
                raise RuntimeError("SSD nguy hiem: chi con %.0fGB - da CHAN copy video moi de bao ve luong dang chay." % free_gb)
            # Xac thuc bang UPLOAD_TOKEN (DUNG CHUNG moi VPS) — token worker moi may moi khac.
            src = "%s/asset?id=%s&token=%s" % (str(cf["url"]).rstrip("/"), urllib.parse.quote(str(cf["assetId"])), urllib.parse.quote(UPLOAD_TOKEN))
            tmp = out + ".copy"
            ok, derr = _http_pull(src, tmp, tien_do=bao_tien_do)
            if ok:
                os.replace(tmp, out)   # ATOMIC: chi doi ten khi keo XONG
                size_mb = round(os.path.getsize(out) / 1e6, 1)
                w, h, dur = probe_media(out)
                with lock: asset_local[aid] = {"status": "ready", "path": out, "sizeMb": size_mb, "working": False, "width": w, "height": h, "durationSec": dur, "dlMbPerMin": toc_do_mb_phut(out)}
                print("COPY VPS->VPS OK: %s (%s MB) tu %s" % (aid, size_mb, cf.get("url")))
                return
            # CHEP HONG. Phan biet 2 loai (r2.34):
            #  · copy TAY (nguoi dung bam "Sao chep sang may...") -> BAO LOI RO, khong am tham lui ve
            #    Drive, vi Drive co the ha chat luong file lon xuong 360p.
            #  · copy TU DONG do may chu chon thay Drive (optional=True, muc E) -> chi la duong TAT cho
            #    nhanh + do ton han muc Drive. Chep hong thi LUI VE Drive dung nhu khi chua co muc E,
            #    KHONG duoc bien mot toi uu thanh mot cach lam hong them.
            if not (cf.get("optional") and fid):
                raise RuntimeError("Copy tu VPS nguon that bai (%s) - KHONG ket noi toi duoc may nguon. Cach xu: dung 'Them video' dan lai link Google Drive vao may dich, hoac 'Tai video len' tu may tinh. Cho may nguon hoi roi copy lai cung duoc. (ky thuat: cong %d)" % (derr, UPLOAD_PORT))
            try: os.remove(tmp)
            except Exception: pass
            print("Chep tu VPS nguon that bai (%s) -> lui ve tai tu Google Drive" % derr)
            bat_dau_tai = time.time()   # do lai tu dau cho lan tai Drive
        if not fid: raise RuntimeError("Khong doc duoc file id Google Drive")
        # RL-RES-002: SSD nguy hiem -> CHAN tai/nen video moi (bao ve luong dang chay).
        try: free_gb = shutil.disk_usage(BASE).free / (1024**3)
        except Exception: free_gb = None
        if free_gb is not None and free_gb < SSD_MIN_FREE_GB:
            raise RuntimeError("SSD nguy hiem: chi con %.0fGB - da CHAN tai/nen video moi de bao ve luong dang chay. Don bot video roi thu lai." % free_gb)
        ok, derr = _download_drive(fid, raw, tien_do=bao_tien_do)
        if not ok: raise RuntimeError("Tai Drive that bai: " + (derr or "khong ro"))
        toc_do_tai = toc_do_mb_phut(raw)   # MB/phut -> may chu canh bao khi may nao tai cham bat thuong
        ab = int(p.get("audioBitrateKbps", 256))
        # NICE: nen tren VPS chay o UU TIEN THAP -> luong dang phat luon duoc CPU truoc,
        # khong bi sap/lag khi vua phat vua nen. (nice -n 19 = thap nhat)
        nice = ["nice", "-n", "19"]
        if p.get("keepOriginal"):
            # GIU NGUYEN HINH: copy video (khong nen, net y het) + chi chuan audio AAC cho YouTube.
            args = nice + ["ffmpeg", "-y", "-i", raw, "-c:v", "copy", "-c:a", "aac", "-b:a", "%dk" % ab,
                    "-ar", "44100", "-movflags", "+faststart", "-f", "mp4", outp]
        else:
            fps = int(p.get("fps", 30)); gop = str(fps * 2); vb = int(p.get("videoBitrateKbps", 6000))
            # -threads 4: gioi han so nhan CPU cho 1 lan nen -> khong hut het may khi dang phat.
            args = nice + ["ffmpeg", "-y", "-i", raw, "-threads", "4",
                    "-vf", "scale=%d:%d" % (int(p.get("width",1920)), int(p.get("height",1080))),
                    "-r", str(fps), "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p",
                    "-b:v", "%dk" % vb, "-minrate", "%dk" % int(vb*0.83), "-maxrate", "%dk" % int(vb*1.17), "-bufsize", "%dk" % (vb*2),
                    "-g", gop, "-keyint_min", gop, "-sc_threshold", "0",
                    "-c:a", "aac", "-b:a", "%dk" % ab, "-ar", "44100", "-movflags", "+faststart", "-f", "mp4", outp]
        if p.get("keepOriginal"):
            # GIU NGUYEN GOC = COPY hinh (gan nhu khong ton CPU) -> KHONG xep hang nen, chay ngay
            # (khong phai cho sau cac video dang nen). Tai xong la gan nhu san sang.
            with lock:
                if asset_local.get(aid): asset_local[aid]["status"] = "normalizing"
            r = sh(args, timeout=14400)
        else:
            # HANG DOI: cho toi luot (toi da MAX_ENCODE video NEN cung luc) -> CPU khong qua tai.
            with lock: asset_local[aid]["status"] = "queued"
            with _encode_sem:
                with lock:
                    if asset_local.get(aid): asset_local[aid]["status"] = "normalizing"
                r = sh(args, timeout=14400)
        if r.returncode != 0 or not os.path.exists(outp):
            try: os.remove(outp)
            except Exception: pass
            raise RuntimeError("Nen that bai: " + (r.stderr or "")[-200:])
        os.replace(outp, out)   # ATOMIC: chi doi ten sang file dich khi nen XONG -> restart/mat dien giua
                                # chung KHONG bao gio de lai file dich hong (truoc day ghi thang -> dut la hong).
        size_mb = round(os.path.getsize(out) / 1e6, 1)
        try: os.remove(raw)
        except Exception: pass
        w, h, dur = probe_media(out)   # do phan giai + thoi luong -> hien trong Kho video (ca video Drive)
        with lock: asset_local[aid] = {"status": "ready", "path": out, "sizeMb": size_mb, "working": False, "width": w, "height": h, "durationSec": dur, "dlMbPerMin": toc_do_tai}
    except Exception as e:
        with lock: asset_local[aid] = {"status": "error", "error": str(e)[:280], "working": False}

def _iso(t=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t if t is not None else time.time()))

def _reason_from(path):
    # Doc dong LOI cuoi trong file stderr ffmpeg (chi ghi loi vi -loglevel error) -> LY DO rot.
    try:
        with open(path, "rb") as f:
            f.seek(0, 2); sz = f.tell(); f.seek(max(0, sz - 4000)); data = f.read().decode("utf-8", "ignore")
        lines = [ln.strip() for ln in data.splitlines() if ln.strip()]
        return lines[-1][:180] if lines else ""
    except Exception:
        return ""

def ensure_stream(s):
    sid = s["id"]
    # NGUON: 1 video (assetId) HOAC danh sach nhieu video (assetIds). Lay cac file DA SAN SANG, dung thu tu.
    aids = s.get("assetIds") or ([s.get("assetId")] if s.get("assetId") else [])
    items = []   # (path, thoi luong) cac video DA SAN SANG, dung thu tu
    for aid in aids:
        p = os.path.join(ASSETS, str(aid) + ".mp4"); a = asset_local.get(aid)
        if a and a.get("status") == "ready" and os.path.exists(p): items.append((p, float(a.get("durationSec") or 0)))
    if not items: return  # chua co video san sang
    with stream_lock:   # noi tiep: giam sat + reconcile khong cung khoi dong 1 luong (tranh day trung khoa)
        cur = stream_procs.get(sid)
        if cur and cur["proc"].poll() is None:
            # dang chay tot -> chay ON DINH du lau thi coi nhu DA KHOI PHUC: go trang thai DUNG-HAN (neu co).
            pub_grace.pop(sid, None)   # da bat lai duoc -> ket thuc khung an han Pub (rot tiep se mo khung moi)
            if time.time() - cur.get("started", 0) > STABLE_RESET_SEC:
                stopped_for_human.discard(sid); last_reason.pop(sid, None)
                restart_bac.pop(sid, None)   # chay on dinh 5 phut = da khoi phuc that -> ve lai bac 20s
            return
        if sid in stopped_for_human:
            return  # LOI NGUON/FILE -> DUNG HAN, khong tu thu (cho nguoi sua nguon / Dung-Bat lai tay)
        # RL-PRC-003 circuit breaker: chop tat qua nhieu -> tam NGAT; sau RETRY_AFTER thi TU THU LAI 1 dot,
        # lap MAI cho toi khi het su co (loi mang/VPS tam thoi tu lanh). Loi nguon/file da bi chan o duoi (dung ngay).
        if sid in restart_halted:
            cho = restart_cho.get(sid, RETRY_AFTER)
            if time.time() - restart_halted[sid] < cho:
                return  # con trong thoi gian cho cua BAC hien tai -> chua thu lai
            restart_halted.pop(sid, None); restart_cho.pop(sid, None); restart_history.pop(sid, None)
            print("circuit breaker: luong %s da cho %ds -> TU THU LAI" % (sid, cho))
        if cur is not None:
            now = time.time()
            hist = [t for t in restart_history.get(sid, []) if now - t < RESTART_WINDOW]
            hist.append(now); restart_history[sid] = hist
            if len(hist) > RESTART_MAX:
                # BAC THU LAI: lan ngat dau cho 20s, moi lan ngat tiep leo len mot bac, den 300s thi
                # dung o do va lap mai (khong bao gio bo cuoc). Xem khoi giai thich o RETRY_LADDER.
                bac = restart_bac.get(sid, 0)
                cho = RETRY_LADDER[min(bac, len(RETRY_LADDER) - 1)]
                restart_halted[sid] = now; restart_cho[sid] = cho
                restart_bac[sid] = min(bac + 1, len(RETRY_LADDER) - 1)
                print("circuit breaker: luong %s chop tat qua nhieu (%d lan/%ds) -> TAM NGUNG, tu thu lai sau %ds (bac %d/%d)"
                      % (sid, len(hist), RESTART_WINDOW, cho, min(bac + 1, len(RETRY_LADDER)), len(RETRY_LADDER)))
                return
            # RL-PRC-004: chac chan khong con ffmpeg cu cua luong nay truoc khi bat moi (tranh 2 ffmpeg/1 luong).
            try:
                if cur["proc"].poll() is None: cur["proc"].kill()
            except Exception: pass
        errpath = os.path.join(LOGS, sid + ".err")
        # Truoc do co chay (cur) ma gio chet -> KHONG ghi su co NGAY (luc nay chua phuc hoi, downtime ~0).
        # CHUYEN moc chet + ly do sang entry MOI (pendingDeadAt) -> supervisor se ghi su co voi downtime
        # THAT khi luong phuc hoi (tu luc con song lan cuoi -> luc len lai) -> khong con 0s sai.
        pending_dead = None; pending_reason = ""
        if cur is not None:
            try:
                if cur.get("errf"): cur["errf"].flush(); cur["errf"].close()
            except Exception: pass
            pending_dead = cur.get("deadAt") or time.time()
            pending_reason = "luong bi treo/do (dong ho ngung nhich) - tu khoi dong lai" if cur.get("stallKill") else _reason_from(errpath)
            if pending_reason: last_reason[sid] = pending_reason   # de phan loai loi nguon/file
            # LOI NGUON/FILE (file hong / decode loi) -> VINH VIEN, khoi dong lai vo ich -> DUNG NGAY ngay lan rot
            # DAU, khong tu bat lai; cho nguoi sua nguon (tai lai video / doi ban NEN). (Sai key thuong hien
            # dang loi mang -> khong bat duoc o day, se bi chan boi gioi han so dot thu lai o tren.)
            if pending_reason and _is_source_error(pending_reason):
                stopped_for_human.add(sid); restart_halted.pop(sid, None); restart_cho.pop(sid, None); restart_bac.pop(sid, None); restart_history.pop(sid, None)
                print("circuit breaker: luong %s LOI NGUON/FILE (%s) -> DUNG NGAY, khong tu bat lai" % (sid, pending_reason[:80]))
                return
            # LIVE PUB rot tin hieu: KHONG bo cuoc NGAY. YouTube chi TU DONG dong buoi phat sau ~60s KHONG co
            # tin hieu; mot cu broken pipe chop nhoang (nghen mang VPS<->YouTube) -> day lai TRONG khung an han
            # la NOI TIEP dung buoi cu. Vi vay: cho TU KET NOI LAI trong PUB_GRACE_SEC (~90s). Chi khi VAN rot
            # suot ca khung do -> luc ay moi coi la YouTube da dong buoi -> DUNG han (bao nguoi, tao buoi moi neu can).
            # (Truoc day bo cuoc ngay lan rot dau -> luong sap oan du YouTube chua dong buoi — Chu Rise Group bao.)
            if str(s.get("mode", "")) == "live-pub":
                now = time.time()
                first = pub_grace.get(sid)
                if first is None:
                    pub_grace[sid] = now   # lan rot dau -> MO khung an han, di tiep xuong duoi de BAT LAI
                elif now - first >= PUB_GRACE_SEC:
                    stopped_for_human.add(sid); restart_halted.pop(sid, None); restart_cho.pop(sid, None); restart_bac.pop(sid, None); restart_history.pop(sid, None); pub_grace.pop(sid, None)
                    if not last_reason.get(sid): last_reason[sid] = "Live Pub rot tin hieu qua %ds - YouTube coi nhu da dong buoi phat (ket thuc)" % PUB_GRACE_SEC
                    print("Live Pub %s rot qua %ds van khong len -> DUNG (buoi phat coi nhu ket thuc)" % (sid, PUB_GRACE_SEC))
                    return
                # con trong khung an han -> KHONG return, di tiep xuong duoi BAT LAI (noi tiep buoi phat)
        restarts = (cur["restarts"] if cur else 0) + (1 if cur else 0)
        url = "%s/%s" % (s.get("rtmpBase", ""), s.get("streamKey", ""))
        # 1 video -> lap; NHIEU video -> DANH SACH PHAT (concat) noi tiep + lap vong (random = xao thu tu).
        # plorder = THU TU PHAT THUC (path,dur) -> de chup ANH DUNG video dang phat (thumbnail_loop).
        if len(items) == 1:
            input_args = ["-stream_loop", "-1", "-i", items[0][0]]
            plorder = items
        else:
            order = items[:]
            if s.get("playMode") == "random": random.shuffle(order)
            plpath = os.path.join(PLAYS, sid + ".txt")
            with open(plpath, "w") as pf:
                for p, _ in order: pf.write("file '%s'\n" % p.replace("'", "'\\''"))
            input_args = ["-stream_loop", "-1", "-f", "concat", "-safe", "0", "-i", plpath]
            plorder = order
        errf = open(errpath, "w")   # ghi de moi lan chay; -loglevel error -> chi loi, khong phinh
        # -progress pipe:1 -> xuat dong ho tien do ra stdout (thread doc) de phat hien TREO (dong ho ngung nhich).
        proc = subprocess.Popen(["ffmpeg", "-nostdin", "-loglevel", "error", "-re"] + input_args + ["-c", "copy", "-progress", "pipe:1", "-f", "flv", url],
                                stdout=subprocess.PIPE, stderr=errf)
        entry = {"proc": proc, "restarts": restarts, "started": time.time(), "deadAt": None,
                 "errf": errf, "plorder": plorder, "lastAlive": time.time(),
                 "pendingDeadAt": pending_dead, "pendingReason": pending_reason,
                 "progAt": time.time(), "progUs": -1, "firstProgAt": None, "blackSince": None, "stallKill": False}
        stream_procs[sid] = entry
        threading.Thread(target=_progress_reader, args=(proc, entry), daemon=True).start()

def _progress_reader(proc, entry):
    # Doc dong ho tien do ffmpeg (-progress pipe:1). Moi lan out_time_us NHICH LEN -> cap nhat progAt.
    # Supervisor dua vao progAt de biet luong co TREO khong (con song nhung dong ho dung).
    try:
        for line in proc.stdout:
            s = line.decode("utf-8", "ignore").strip()
            if s.startswith("out_time_us="):
                try: us = int(s.split("=", 1)[1])
                except Exception: continue
                if us > entry.get("progUs", -1):
                    entry["progUs"] = us; entry["progAt"] = time.time()
                    # Moc TIEN DO DAU TIEN = luc video THAT SU chay lai (da bat tay xong
                    # voi YouTube). Dung lam moc "het mat song" thay vi cho nhip giam sat
                    # phat hien (cham toi 2s) -> so "mat song" bot phong len.
                    if entry.get("firstProgAt") is None: entry["firstProgAt"] = time.time()
            elif s.startswith("bitrate="):
                # vd "bitrate= 4576.0kbits/s" hoac "bitrate=N/A" -> so kbits/s de web hien + tinh suc khoe.
                v = s.split("=", 1)[1].strip().replace("kbits/s", "")
                try: entry["bitrateKbps"] = round(float(v), 1)
                except Exception: entry["bitrateKbps"] = None
            elif s.startswith("speed="):
                # vd "speed=1.0x" -> so lan thoi gian thuc (1x = binh thuong; <1x = dang tut/treo).
                v = s.split("=", 1)[1].strip().rstrip("x")
                try: entry["speed"] = round(float(v), 2)
                except Exception: entry["speed"] = None
    except Exception:
        pass
    # Toi day nghia la ong stdout DA DONG = ffmpeg vua chet -> danh thuc vong giam
    # sat NGAY de tai day lap tuc, khong cho het nhip ngu 2s.
    wake_event.set()

def stop_stream(sid):
    # DUNG HAN: terminate proc + DONG file log + QUEN han entry. Nho quen entry nen lan bat sau la
    # phien MOI (khong bi tinh nham thanh "crash -> restart" -> khong sinh su co gia cho luong hen gio).
    with stream_lock:
        restart_halted.pop(sid, None); restart_cho.pop(sid, None); restart_bac.pop(sid, None); restart_history.pop(sid, None); stopped_for_human.discard(sid); last_reason.pop(sid, None); pub_grace.pop(sid, None)   # Dung tay -> reset circuit breaker (ke ca DUNG-HAN + khung an han Pub)
        cur = stream_procs.pop(sid, None)
        if not cur: return
        try:
            if cur["proc"].poll() is None:
                cur["proc"].terminate(); cur["proc"].wait(timeout=5)
        except Exception:
            try: cur["proc"].kill()
            except Exception: pass
        try:
            if cur.get("errf"): cur["errf"].close()   # dong file log ffmpeg -> khong ro file descriptor
        except Exception: pass
        recently_stopped.add(sid)   # bao 'stopped' 1 lan o sync ke tiep -> giao dien hien dung (Sua/Xoa)

def moc_song_gan_nhat(cur):
    # MOC "LAN CUOI BIET NO CON SONG" — lay cai TUOI NHAT trong hai nguon, KHONG uu tien cung mot cai.
    #
    # LOI DA GAY RA (r2.36, phat hien 30/08/2026): truoc day luon uu tien `progAt` (bo doc tien do,
    # chinh xac duoi 1 giay). Dung voi luong THUONG. Nhung luong NHAN LAI sau khi keo worker thi
    # KHONG co ong doc tien do — `progAt` bi dat mot lan luc nhan lai roi DUNG YEN mai mai.
    # Hau qua: luong nhan lai chi can chop mot cai la he tinh "mat song = toan bo thoi gian tu luc
    # nhan lai". Do that: keo worker luc 00:26, su co luc 02:25 -> bao "mat song 119,6 phut";
    # su co luc 03:00 -> bao "155,5 phut". Toan bo la SO AO, luong chi chop vai giay.
    # Va so ao do lam he coi moi chop nhe la "gian doan dang ke" -> DAY THONG BAO ve dien thoai.
    #
    # `lastAlive` duoc cap nhat moi nhip giam sat (~2 giay) cho MOI luong con song, ke ca luong nhan
    # lai -> lay cai tuoi nhat la dung cho ca hai truong hop.
    return max(float(cur.get("progAt") or 0), float(cur.get("lastAlive") or 0)) or time.time()

def canh_luong_nhan_lai():
    # CANH LUONG NHAN LAI (r2.40, 30/08/2026) — Chu Rise Group duyet.
    #
    # VI SAO. Luong THUONG co ong doc tien do: ffmpeg chet la ong dong NGAY -> danh chuong wake_event
    # -> vong giam sat tinh day va bat lai tuc thi (do that: phuc hoi duoi 1 giay). Nhung luong NHAN
    # LAI (r2.36 — tien trinh co san tu lan chay truoc cua worker, giu nguyen de keo worker khong dut
    # song) KHONG noi lai duoc ong do -> KHONG CO AI DANH CHUONG -> phai cho het nhip ngu 2 giay moi
    # phat hien. Ma sau MOI lan keo worker thi TOAN BO luong dang phat deu la luong nhan lai.
    #
    # CACH LAM: MOT luong canh duy nhat (khong phai moi luong mot cai), cu 0,2 giay hoi he dieu hanh
    # xem tien trinh con song khong — os.kill(pid, 0), chi la mot cau hoi, KHONG doc file, KHONG goi
    # mang, KHONG ghi Firestore. Chet thi danh dung cai chuong co san, khong them co che moi nao.
    #
    # HAI DIEU BAT BUOC PHAI GIU (thieu la sinh loi moi):
    #  1. DANH CHUONG MOT LAN CHO MOI LAN CHET. Neu cu thay chet la danh thi luong dang bi CAU DAO giu
    #     lai (chua toi gio thu lai) se bi danh chuong 5 lan/giay MAI MAI -> vong giam sat quay 10 lan
    #     nhanh hon binh thuong mot cach vo ich. Do la viec cua `da_bao`.
    #  2. CHUP DANH SACH TRONG KHOA ROI MOI DUYET. Doc thang stream_procs trong khi vong giam sat dang
    #     them/bot se lam vang worker. Moi cho GHI stream_procs deu giu stream_lock (dong 787/919/1244)
    #     nen chup trong khoa la an toan.
    #
    # Luong bat lai duoc -> ban ghi bi thay bang tien trinh THAT (co ong doc tien do, khong con co
    # nhan `nhanLai`) -> tu roi khoi danh sach canh, va `da_bao` quen no di de lan chet sau con bao.
    da_bao = set()
    while True:
        try:
            with stream_lock:
                cap = [(sid, cur) for sid, cur in stream_procs.items() if cur.get("nhanLai")]
            if not cap:
                da_bao.clear()
                time.sleep(1)          # khong con luong nhan lai nao -> nghi day hon cho re
                continue
            con = set()
            for sid, cur in cap:
                con.add(sid)
                if sid in da_bao: continue        # lan chet nay da bao roi -> khong danh chuong nua
                try: chet = cur["proc"].poll() is not None
                except Exception: chet = False
                if chet:
                    da_bao.add(sid)
                    wake_event.set()              # danh dung chuong san co -> giam sat tinh NGAY
            da_bao &= con                         # luong da bat lai that -> quen di
        except Exception as e:
            print("canh luong nhan lai loi:", str(e)[:120])
        time.sleep(0.2)

def supervisor():
    # GIAM SAT PHUC HOI NHANH: cu ~2s soi cac luong PHAI song; cai nao chet -> khoi dong lai NGAY
    # (thay vi cho toi nhip reconcile ~10s) -> khan gia mat song chi vai giay. Ghi thoi diem chet
    # de tinh "phuc hoi sau bao lau".
    while True:
        try:
            # TU DUNG KHI CO LAP (r2.22): luong automatic + mat lien lac may chu qua grace -> co the DA
            # bi chuyen may -> tu dung, tranh phat trung. Luong thuong (khong enabled) bo qua hoan toan.
            iso = time.time() - lease_state["last_ok"]
            if iso > lease_state["grace"]:
                for sid in list(desired_live.keys()):
                    if not lease_state["enabled"].get(sid):
                        continue                   # luong thuong -> GIU PHAT du co lap
                    if sid not in lease_state["fenced"]:
                        print("TU DUNG luong %s: mat lien lac may chu %ds (co lap) -> tranh phat trung" % (sid, int(iso)))
                        lease_state["fenced"].add(sid)
                    stop_stream(sid); desired_live.pop(sid, None)
            for sid, s in list(desired_live.items()):
                cur = stream_procs.get(sid)
                if cur is None: continue          # chua chay (de reconcile khoi dong) / vua bi dung -> KHONG tu bat lai
                if cur["proc"].poll() is None:    # CON SONG
                    cur["lastAlive"] = time.time()
                    # Vua PHUC HOI sau su co (co pendingDeadAt) -> GHI su co voi downtime THAT:
                    # tu luc con song lan cuoi (pendingDeadAt) -> luc len lai (bay gio). Khong con 0s sai.
                    # Chi ghi khi ffmpeg moi DA CO TIEN DO (video that su dang chay lai).
                    # Truoc day lay time.time() cua NHIP GIAM SAT — cham toi 2s so voi luc
                    # song thuc su len -> "mat song" bao 3-4s trong khi thuc te ~1-2s.
                    if cur.get("pendingDeadAt") is not None and cur.get("firstProgAt") is not None:
                        gap = cur["firstProgAt"] - cur["pendingDeadAt"]
                        # SAN 0,1 GIAY (r2.40) — TRUOC LA 1 GIAY.
                        # San 1 giay duoc dat hoi cach do "mat song" con lay thoi diem NHIP GIAM SAT
                        # (sai toi 2 giay, hay ra 0s vo ly). Tu 28/08 cach do da doi sang firstProgAt
                        # (luc ffmpeg MOI thuc su day duoc hinh) nen so da chinh xac — do that: 0 lan
                        # 4 giay trong ca ngay 29/08, truoc do la 329 lan. Nhung san 1 giay van con,
                        # nen MOI lan phuc hoi nhanh hon 1 giay deu bi keo len hien "1s": 45 ban ghi
                        # dung 1.0s khong lech mot ly = dau hieu ro cua san, khong phai so do.
                        # Ha xuong 0,1 de thay so THAT (0.3s / 0.6s...). Van khong bao gio hien 0s.
                        incidents.append({"streamId": sid, "kind": "restart", "at": _iso(),
                                          "downSec": max(0.1, round(gap, 1)),
                                          "reason": cur.get("pendingReason", "")})
                        cur["pendingDeadAt"] = None
                    # TREO/DO: con song nhung dong ho ffmpeg NGUNG NHICH > 25s (da qua 15s khoi dong) ->
                    # GIET de bien thanh "chet" -> nhip sau tu khoi dong lai + ghi su co "treo".
                    if (not cur.get("nhanLai")) and (time.time() - cur["started"] > 15) and (time.time() - cur.get("progAt", cur["started"]) > 25):
                        cur["stallKill"] = True
                        cur["deadAt"] = moc_song_gan_nhat(cur)
                        try: cur["proc"].kill()
                        except Exception: pass
                    continue
                if sid not in desired_live: continue      # vua bi dung o nhip reconcile -> khong bat lai
                # Moc CHET = lan cuoi con biet con song (khong phai luc phat hien) -> tinh downtime dung hon.
                if cur.get("deadAt") is None: cur["deadAt"] = moc_song_gan_nhat(cur)
                ensure_stream(s)
        except Exception as e:
            print("giam sat loi:", str(e)[:120])
        # Ngu toi da 2s NHUNG tinh ngay khi co luong chet (wake_event tu reader).
        wake_event.wait(2)
        wake_event.clear()

def post_thumb(sid, path):
    # DAY ANH THAT DANG PHAT VE SERVER Rise Work (thay vi phuc vu qua HTTPS rieng tung VPS) ->
    # anh hien duoc voi MOI VPS. Anh nho (360px) -> base64 vai chuc KB. Loi thi bo qua.
    try:
        if not (os.path.exists(path) and os.path.getsize(path) > 0): return
        with open(path, "rb") as f: data = f.read()
        if len(data) > 650000: return   # ~650KB -> b64 ~870KB, duoi gioi han doc Firestore 1MB
        payload = {"machineId": MACHINE, "streamId": sid, "jpgB64": base64.b64encode(data).decode()}
        req = urllib.request.Request(URL + "/api/live/agent-thumb", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json", "x-rise-live-token": TOKEN}, method="POST")
        with urllib.request.urlopen(req, timeout=20) as resp: resp.read()
    except Exception:
        pass

def thumbnail_loop():
    # ANH THAT DANG PHAT: cu ~45s chup 1 khung hinh o DUNG VI TRI dang phat (uptime % thoi luong)
    # -> thumbs/<sid>.jpg (GHI DE, 1 file/luong -> khong phinh o). Chay uu tien THAP (nice 19),
    # 1 khung hinh -> nhe, khong lam giat luong dang phat.
    while True:
        try:
            for sid, v in list(stream_procs.items()):
                if v["proc"].poll() is not None: continue   # khong con phat -> bo qua
                # DUNG video dang phat: theo thu tu phat thuc (plorder) + tong thoi luong -> tim video + vi tri.
                plorder = v.get("plorder") or []
                plorder = [(p, d) for (p, d) in plorder if os.path.exists(p)]
                if not plorder: continue
                total = sum(d for _, d in plorder if d > 1)
                cur_path = plorder[0][0]; pos = 0.0
                if total > 1:
                    t = (time.time() - v["started"]) % total   # vi tri trong vong lap ca danh sach
                    acc = 0.0
                    for p, d in plorder:
                        if d <= 1: continue
                        if t < acc + d: cur_path = p; pos = t - acc; break
                        acc += d
                out = os.path.join(THUMBS, sid + ".jpg")
                # blackframe (mac dinh amount=98,thresh=32 = GAN NHU DEN TUYEN, khong phai chi toi mau) ->
                # neu khung hinh den, ffmpeg in "blackframe" ra stderr. Vua chup anh vua kiem den 1 lan.
                r = subprocess.run(["nice", "-n", "19", "ffmpeg", "-y", "-ss", str(round(pos, 1)), "-i", cur_path,
                                    "-frames:v", "1", "-vf", "blackframe,scale=360:-2", "-q:v", "6", out],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
                is_black = b"blackframe" in (r.stderr or b"")
                # ĐẨY ảnh lên máy chủ THƯA (THUMB_PUSH_SEC) — đây là phần gây tải. Việc DÒ MÀN ĐEN bên dưới
                # vẫn chạy mỗi vòng (60s) tại VPS nên KHÔNG chậm đi.
                if os.path.exists(out) and os.path.getsize(out) > 0:
                    _push_every = max(60, int(thumb_state.get("push") or THUMB_PUSH_DEFAULT))
                    if time.time() - float(thumb_last_push.get(sid) or 0) >= _push_every:
                        post_thumb(sid, out); thumb_last_push[sid] = time.time()
                # Dem DEN LIEN TUC: lan dau den -> ghi moc; het den -> xoa moc. sync bao black khi >= 60s.
                if is_black:
                    if v.get("blackSince") is None: v["blackSince"] = time.time()
                else:
                    v["blackSince"] = None
        except Exception as e:
            print("thumbnail loi:", str(e)[:120])
        # Nhip CHUP + DO MAN DEN (tai VPS, khong ton may chu) -> giu day de phat hien man den nhanh nhu cu.
        time.sleep(THUMB_SCAN_SEC)

def sync():
    # Gom bao cao trang thai hien tai
    a_report = [{"id": k, "status": v.get("status"), "normalizedPath": v.get("path"), "sizeMb": v.get("sizeMb"),
                 "durationSec": v.get("durationSec"), "width": v.get("width"), "height": v.get("height"), "error": v.get("error"),
                 # r2.34 — tien do tai + cho xep hang + toc do tai (MB/phut) de canh bao may tai cham.
                 "progressPct": v.get("progressPct"), "downloadedMb": v.get("downloadedMb"), "totalMb": v.get("totalMb"),
                 "queueAhead": v.get("queueAhead"), "dlMbPerMin": v.get("dlMbPerMin")} for k, v in list(asset_local.items())]
    s_report = []
    for sid, v in list(stream_procs.items()):
        alive = v["proc"].poll() is None
        should_live = sid in desired_live   # luong DANG PHAI phat (bat tay / trong khung gio)
        if alive:
            health = "good" if (time.time() - v["started"] > 8) else "starting"
        else:
            # Chet ma DANG PHAI phat -> LOI that (se tu bat lai). Con lai (dung dung lich/tay) -> "idle",
            # KHONG bao loi (tranh hieu lam Live Pub hen gio het gio la loi).
            health = "error" if should_live else "idle"
        black = bool(alive and v.get("blackSince") and time.time() - v["blackSince"] >= 60)   # den lien tuc >= 60s
        s_report.append({"id": sid, "status": "live" if alive else "stopped", "health": health,
                         "restarts": v["restarts"], "uptimeSec": int(time.time() - v["started"]) if alive else 0, "black": black,
                         "bitrateKbps": (v.get("bitrateKbps") if alive else None), "speed": (v.get("speed") if alive else None),
                         "restartHalted": sid in restart_halted, "needsHuman": sid in stopped_for_human,
                         "haltReason": (last_reason.get(sid) or None)})
    # Luong VUA DUNG (nut Dung / het khung gio / xoa) -> bao 'stopped' 1 LAN de server thoi dong bang "live"
    # (r2.12 sau khi dung thoi bao luon -> giao dien khong biet da dung). Bao xong thi quen.
    for sid in list(recently_stopped):
        s_report.append({"id": sid, "status": "stopped", "health": "idle", "restarts": 0, "uptimeSec": 0})
        recently_stopped.discard(sid)
    with lock: ups = list(pending_uploads)
    inc = incidents[:]   # su co chua gui (snapshot) — xoa sau khi POST thanh cong
    payload = {"machineId": MACHINE, "agentVersion": AGENT_VERSION, "heartbeat": heartbeat(),
               "assets": a_report, "streams": s_report, "uploaded": ups, "incidents": inc}
    req = urllib.request.Request(URL + "/api/live/agent", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json", "x-rise-live-token": TOKEN}, method="POST")
    with urllib.request.urlopen(req, timeout=SYNC_TIMEOUT) as resp:
        out = json.loads(resp.read().decode())
    if ups:   # da bao dang ky -> bo khoi hang cho (agent tao ban ghi idempotent)
        with lock:
            ids = {u["id"] for u in ups}
            pending_uploads[:] = [u for u in pending_uploads if u["id"] not in ids]
    if inc: del incidents[:len(inc)]   # da gui -> bo dung so da gui (cai moi phat sinh sau van giu)
    return out

def reconcile(desired):
    # 1) Asset: nen cai chua ready va chua dang xu ly
    for a in desired.get("assets", []):
        aid = a["id"]; loc = asset_local.get(aid)
        if a.get("status") == "ready" and not loc:
            out = os.path.join(ASSETS, aid + ".mp4")
            if os.path.exists(out):
                pw, ph, pdur = probe_media(out)
                asset_local[aid] = {"status": "ready", "path": out, "sizeMb": round(os.path.getsize(out)/1e6,1), "working": False, "width": pw, "height": ph, "durationSec": pdur}
            continue
        if (not loc or loc.get("status") in (None, "pending")) and not (loc and loc.get("working")):
            threading.Thread(target=normalize, args=(a,), daemon=True).start()
    # 1b) DON O: video da bi xoa khoi he thong -> xoa file tren VPS + quen.
    present_asset_ids = {a["id"] for a in desired.get("assets", [])}
    with lock:
        pending_ids = {u["id"] for u in pending_uploads}
    protected = present_asset_ids | pending_ids   # giu ca file vua upload dang cho dang ky
    for aid in list(asset_local.keys()):
        if aid not in protected and not asset_local[aid].get("working"):
            asset_local.pop(aid, None)
    try:
        for fn in os.listdir(ASSETS):
            if not fn.endswith(".mp4"):
                continue
            aid = fn[:-4]
            if aid in protected:
                continue
            loc = asset_local.get(aid)
            if loc and loc.get("working"):
                continue
            try:
                os.remove(os.path.join(ASSETS, fn))
            except Exception:
                pass
    except Exception:
        pass
    # 2) Luong: bat cai desired=live, dung cai desired=stopped. Cai da bi XOA khoi he thong
    #    (khong con trong danh sach) -> dung + QUEN HAN (pop) de khong bao lai -> khong "ma".
    present_ids = {s["id"] for s in desired.get("streams", [])}
    live_ids = set()
    for s in desired.get("streams", []):
        if s.get("desiredState") == "live":
            desired_live[s["id"]] = s; live_ids.add(s["id"])   # nuoi danh sach cho giam sat phuc hoi nhanh
            ensure_stream(s)
        else:
            stop_stream(s["id"]); desired_live.pop(s["id"], None)
    for sid in list(desired_live.keys()):
        if sid not in live_ids: desired_live.pop(sid, None)   # bo cai khong con phai song
    for sid in list(stream_procs.keys()):
        if sid not in present_ids:
            stop_stream(sid); stream_procs.pop(sid, None)
    # Don anh cua luong da bi xoa (khong con trong danh sach) -> khong ton o.
    try:
        for fn in os.listdir(THUMBS):
            if fn.endswith(".jpg") and fn[:-4] not in present_ids:
                os.remove(os.path.join(THUMBS, fn))
    except Exception:
        pass

class TienTrinhNhanLai:
    # Vo boc cho mot tien trinh ffmpeg CO SAN (khoi dong tu lan chay truoc cua worker). Khong co
    # Popen that nen khong co ong doc tien do — chi biet no CON SONG hay DA CHET, va giet duoc.
    # Du de giam sat: luong chet van bat lai duoc ngay nhu thuong.
    def __init__(self, pid):
        self.pid = int(pid)
        self.stdout = None
        self._ma = None
    def poll(self):
        if self._ma is not None: return self._ma
        try:
            os.kill(self.pid, 0)          # chi KIEM TRA, khong gui tin hieu that
            return None                   # con song
        except Exception:
            self._ma = 0; return 0        # da chet
    def terminate(self):
        try: os.kill(self.pid, 15)
        except Exception: pass
    def kill(self):
        try: os.kill(self.pid, 9)
        except Exception: pass
    def wait(self, timeout=None):
        han = time.time() + (timeout if timeout is not None else 10)
        while time.time() < han:
            if self.poll() is not None: return 0
            time.sleep(0.2)
        return None

def _ffmpeg_dang_chay():
    # Liet ke cac tien trinh ffmpeg dang day RTMP tren may: tra {pid: dong lenh day du}.
    ra = {}
    try:
        for ten in os.listdir("/proc"):
            if not ten.isdigit(): continue
            try:
                with open("/proc/%s/cmdline" % ten, "rb") as f:
                    dong = f.read().replace(bytes(1), b" ").decode("utf-8", "ignore")
            except Exception:
                continue
            if "ffmpeg" in dong and "rtmp" in dong:
                ra[int(ten)] = dong
    except Exception as e:
        print("doc danh sach tien trinh loi:", str(e)[:120])
    return ra

def nhan_lai_luong(desired):
    # NHAN LAI LUONG DANG PHAT sau khi worker khoi dong lai (r2.36).
    #
    # TRUOC DAY: worker vua bat len la chay `pkill -9 ffmpeg .*rtmp` — GIET SACH moi luong dang phat
    # roi bat lai tung cai. Nghia la MOI LAN keo worker ban moi, ca may DUT SONG vai giay. O 125 luong
    # thi do la 125 lan chop tat, va do la ly do lau nay cap nhat worker phai canh gio.
    # Ly do cua cau lenh giet do van DUNG: worker phai la NGUOI QUAN DUY NHAT; de sot tien trinh cu
    # thi hai ban cung day vao mot khoa -> YouTube bao trung luong -> giat.
    #
    # NAY: doi chieu tung tien trinh dang chay voi danh sach luong CAN phat (khop theo dia chi RTMP +
    # khoa luong — moi luong mot khoa rieng nen khong the nham). Khop dung -> GIU NGUYEN, khong dut
    # song. Khong khop, hoac trung (hai tien trinh cung mot khoa) -> GIET. Nguyen tac "mot khoa mot
    # tien trinh" van duoc giu y nguyen.
    #
    # DANH DOI da biet: luong nhan lai KHONG co ong doc tien do (khong noi lai duoc voi tien trinh cu)
    # -> khong bao duoc toc do day/bitrate cho toi khi no tu khoi dong lai. Danh dau nhanLai=True de
    # phan giam sat BO QUA phep kiem "treo" cho rieng cac luong nay (neu khong se bi giet oan sau 25s).
    dang = _ffmpeg_dang_chay()
    if not dang:
        return
    theoUrl = {}
    for s in desired.get("streams", []):
        u = "%s/%s" % (s.get("rtmpBase", ""), s.get("streamKey", ""))
        if s.get("streamKey"): theoUrl[u] = s
    nhan, giet = 0, 0
    daNhan = set()
    for pid, dong in dang.items():
        khop = None
        for u, s in theoUrl.items():
            if u and u in dong: khop = (u, s); break
        # Khong thuoc luong nao CAN phat, hoac da co tien trinh khac giu khoa nay -> tien trinh THUA.
        if not khop or khop[0] in daNhan:
            try: os.kill(pid, 9)
            except Exception: pass
            giet += 1
            continue
        u, s = khop
        daNhan.add(u)
        sid = str(s.get("id"))
        with stream_lock:
            stream_procs[sid] = {"proc": TienTrinhNhanLai(pid), "restarts": 0, "started": time.time(),
                                 "deadAt": None, "errf": None, "plorder": [], "lastAlive": time.time(),
                                 "pendingDeadAt": None, "pendingReason": None,
                                 "progAt": time.time(), "progUs": -1, "firstProgAt": time.time(),
                                 "blackSince": None, "stallKill": False, "nhanLai": True}
        nhan += 1
    if giet: time.sleep(1)
    print("nhan lai %d luong dang phat (khong dut song) · giet %d tien trinh thua" % (nhan, giet))

def cleanup_orphan_ffmpeg():
    # Duong lui: khi KHONG lay duoc danh sach luong can phat (may chu chua tra loi) thi khong co gi de
    # doi chieu -> quay ve cach cu, giet sach. Tha dut song con hon de hai ban cung day mot khoa.
    try:
        subprocess.run(["pkill", "-9", "-f", "ffmpeg .*rtmp"], check=False)
        time.sleep(1)
    except Exception as e:
        print("don ffmpeg mo coi loi:", str(e)[:120])

def main():
    print("Rise Live worker %s — may %s -> %s" % (AGENT_VERSION, MACHINE, URL))
    # QUAY VE CACH CU (r2.41, 30/08/2026) — CHU RISE GROUP QUYET.
    #
    # r2.36 tung doi sang "NHAN LAI luong dang phat": doi chieu tien trinh ffmpeg dang chay voi danh
    # sach luong can phat, khop thi GIU NGUYEN -> keo worker khong dut song. Cai gia phai tra: tien
    # trinh nhan lai KHONG noi lai duoc ong doc so lieu cua ffmpeg, nen mat SPEED va BITRATE. Ma
    # speed chinh la thu nuoi canh bao GIAT/LAG (RL-NET-004: speed < 0,92x lien tuc 90 giay) va nuoi
    # phep kiem TREO/DO. Do that 30/08: 106/119 luong dang phat khong co so -> ba lop bao ve im lang.
    #
    # Chu Rise Group chon: THA CHOP SONG MOI LAN KEO WORKER, con hon mat so lieu va mat canh bao.
    # Nen quay ve cach cu: khoi dong worker la don sach ffmpeg cu, roi tu bat lai tung luong. Moi
    # luong do worker TU SINH nen co day du ong doc so lieu -> speed/bitrate/treo/chuong deu tro lai.
    #
    # (Ham nhan_lai_luong + TienTrinhNhanLai VAN GIU trong file, khong goi toi — de sau nay neu tim
    #  duoc cach lay so lieu cho tien trinh nhan lai thi bat lai duoc ngay, khong phai viet lai.)
    cleanup_orphan_ffmpeg()
    threading.Thread(target=measure_upload, daemon=True).start()   # do bang thong nen (best-effort)
    threading.Thread(target=supervisor, daemon=True).start()       # giam sat phuc hoi nhanh (~2s)
    threading.Thread(target=thumbnail_loop, daemon=True).start()   # chup anh that dang phat (~45s)
    # LUON bat HTTP server: phuc vu /asset (copy VPS->VPS, xac thuc bang TOKEN worker) cho MOI may.
    # /upload va /thumb van chi hoat dong khi co UPLOAD_TOKEN (khong thi tra 401 -> upload van tat).
    threading.Thread(target=start_upload_server, daemon=True).start()
    threading.Thread(target=_auto_update_tools, daemon=True).start()   # tu cap nhat yt-dlp/gdown (Drive it hong)
    poll = 10
    hut_lien_tiep = 0      # so lan goi may chu HUT lien tiep (r2.38) - de thu lai nhanh dung luc can
    while True:
        try:
            desired = sync()
            # Ghi nhan LIEN LAC THANH CONG + thong tin lease (cho co che tu-dung-khi-co-lap).
            lease_state["last_ok"] = time.time()
            lease_state["grace"] = int(desired.get("leaseGraceSec", 60) or 60)
            try: thumb_state["push"] = int(desired.get("thumbPushSec") or THUMB_PUSH_DEFAULT)   # may chu chinh nhip DAY anh
            except Exception: pass
            lease_state["enabled"] = {s["id"]: bool(s.get("leaseEnabled")) for s in desired.get("streams", [])}
            lease_state["fenced"].clear()   # noi lai lien lac -> cho phep bao lai neu lai co lap
            reconcile(desired); poll = int(desired.get("pollSeconds", 10))
            hut_lien_tiep = 0                  # lien lac lai duoc -> reset
        except Exception as e:
            hut_lien_tiep += 1
            print("sync loi (lan %d lien tiep):" % hut_lien_tiep, str(e)[:200])
        # GOI HUT -> thu lai NHANH (5s) trong 3 lan dau, de tong thoi gian im khong vuot nguong 60 giay
        # ma may chu coi la "may mat ket noi". Hut dai hon 3 lan = may chu chet that -> ve nhip thuong,
        # khong doi may chu. Xem khoi giai thich o dau file (SYNC_TIMEOUT).
        time.sleep(SYNC_RETRY_SEC if 0 < hut_lien_tiep <= SYNC_RETRY_MAX else max(5, poll))

if __name__ == "__main__":
    main()
