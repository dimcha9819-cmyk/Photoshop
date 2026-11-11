"""Small web UI for the story folder (standard library only).

Shows what is queued in Buffer, what waits in the folder (with the expected date of each),
lets you upload photos, drag them into the order you want, move them to the trash and run the
poster right now. The page is meant for the home network only: set UI_PASSWORD to require a login.

    python ui.py          # listens on UI_PORT (default 8095)
"""
import base64, hmac, json, mimetypes, os, re, signal, subprocess, sys, threading, time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
import hashlib
try:
    from PIL import Image                                  # optional: small previews; without it full images are sent
except Exception:
    Image = None

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import story_poster as sp                                  # same folder logic, same ordering and slot rules
import appdb                                               # error log + SQLite database
import post_poster as PP                                   # feed posts: slot folders with photos and a caption file

sp.load_env()
FOLDER = Path(sp.cfg('STORIES_DIR', str(HERE / 'stories'))).expanduser()
PORT = int(sp.cfg('UI_PORT', '8095'))
PASSWORD = sp.cfg('UI_PASSWORD', '')
TZNAME = sp.cfg('TIMEZONE', 'Europe/Kyiv')
RUN_LOCK = threading.Lock()
FEED = Path(sp.cfg('FEED_DIR', str(FOLDER.parent / 'feed'))).expanduser()      # photos for the feed planner (separate from stories)
PLANNER = Path(sp.cfg('PLANNER_DIR', str(HERE / 'planner'))).expanduser()      # index.html of the feed planner + feed_crops/feed.js
PLANNER_STATE = FOLDER.parent / 'planner.json'                                # saved planner setup (photos, order, view settings), shared by all browsers
PLANNER_FILES = {'index.html', 'feed_crops/feed.js'}                            # only these are served
THUMBS = FOLDER.parent / 'thumbs'                                                # cache of small previews
THUMB_SEM = threading.Semaphore(2)                                             # at most two previews are built at the same time (memory)
THUMB_KEEP_DAYS = 30


def thumb_bytes(f, w):
    """JPEG preview no wider than w px (cached on disk); None when Pillow is missing or the file cannot be read."""
    if Image is None or not 40 <= w <= 1600:
        return None
    try:
        st = f.stat()
        key = hashlib.sha1(f'{f}|{st.st_mtime_ns}|{st.st_size}|{w}'.encode()).hexdigest()
        c = THUMBS / (key + '.jpg')
        if c.is_file():
            try:
                os.utime(c)                                  # remember the last use, for the cleanup below
            except OSError:
                pass
            return c.read_bytes()
        with THUMB_SEM:
            if not c.is_file():
                with Image.open(f) as im:
                    im.draft('RGB', (w * 2, w * 3))          # JPEG: decode at reduced size, keeps memory small
                    im = im.convert('RGB')
                    im.thumbnail((w, w * 2))
                    THUMBS.mkdir(parents=True, exist_ok=True)
                    tmp = c.with_suffix('.tmp')
                    im.save(tmp, 'JPEG', quality=80, optimize=True)
                    tmp.replace(c)
        return c.read_bytes()
    except Exception:
        return None


def prune_thumbs_loop():
    """Once a day delete previews that were not used for THUMB_KEEP_DAYS days (photos replaced or removed)."""
    while True:
        try:
            limit = time.time() - THUMB_KEEP_DAYS * 86400
            if THUMBS.is_dir():
                for p in THUMBS.iterdir():
                    if p.suffix in ('.jpg', '.tmp') and p.stat().st_mtime < limit:
                        p.unlink()
        except Exception:
            appdb.exc('ui', 'помилка очищення мініатюр')
        time.sleep(86400)


SECTIONS = {'waiting': FOLDER, 'scheduled': FOLDER / 'scheduled', 'posted': FOLDER / 'posted', 'feed': FEED}

FAVICON = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2f5be0"/>'
           '<circle cx="32" cy="32" r="13" fill="none" stroke="#fff" stroke-width="5"/><circle cx="46" cy="18" r="3.5" fill="#fff"/></svg>')


def safe_name(name):
    name = os.path.basename(name.replace('\\', '/')).strip()
    name = re.sub(r'[^\w .()\-]', '_', name, flags=re.U)
    return name


def unique(folder, name):
    p = folder / name
    i = 1
    while p.exists():
        p = folder / f'{Path(name).stem}_{i}{Path(name).suffix}'
        i += 1
    return p


def read_state():
    f = FOLDER / 'state.json'
    return json.loads(f.read_text(encoding='utf-8')) if f.exists() else {'items': []}


def build_state():
    FOLDER.mkdir(parents=True, exist_ok=True)
    tz = sp.get_zone(TZNAME)
    sc = sp.schedule_conf()['stories']
    post_time, per_day = sc['time'], int(sc['per_day'])
    now = datetime.now(timezone.utc)
    items = sorted(read_state()['items'], key=lambda i: i['due'])
    waiting = sp.sorted_waiting(FOLDER)
    # expected dates for waiting photos: same slot rule as the poster
    dues = [datetime.fromisoformat(i['due'].replace('Z', '+00:00')) for i in items]
    out = []
    for p in waiting:
        due = sp.plan_next(dues, now, tz, sc)
        out.append({'name': p.name, 'size': p.stat().st_size, 'expected': sp.iso(due)})
        dues.append(due)
    posted = sorted([p.name for p in (FOLDER / 'posted').glob('*') if p.suffix.lower() in sp.EXT]) if (FOLDER / 'posted').exists() else []
    return {
        'waiting': out,
        'scheduled': [{'file': i['file'], 'due': i['due']} for i in items],
        'posted': posted,
        'history': read_state().get('history', []),
        'settings': {'post_time': post_time, 'days_ahead': sc['days_ahead'], 'per_day': per_day, 'tz': TZNAME},
    }


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        et = sys.exc_info()[0]
        if et and issubclass(et, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError)):
            return
        appdb.exc('ui', f'необроблена помилка з’єднання від {client_address[0]}')


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _auth(self):
        if not PASSWORD:
            return True
        h = self.headers.get('Authorization', '')
        if h.startswith('Basic '):
            try:
                user_pass = base64.b64decode(h[6:]).decode('utf-8', 'replace')
                if hmac.compare_digest(user_pass.split(':', 1)[-1], PASSWORD):
                    return True
            except Exception:
                pass
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="Stories"')
        self.send_header('Content-Length', '0')
        self.end_headers()
        return False

    def _json(self, obj, code=200, _log=True):
        if _log and code >= 400:
            appdb.log('error' if code >= 500 else 'warning', 'ui', f'{self.command} {urlparse(self.path).path} -> {code}', json.dumps(obj, ensure_ascii=False)[:500])
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _fail(self):
        try:
            self._json({'error': 'внутрішня помилка сервера, дивіться журнал'}, 500, _log=False)
        except Exception:
            pass

    def do_GET(self):
        try:
            self._do_GET()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass                                                  # the browser closed the page while loading
        except Exception:
            appdb.exc('ui', f'GET {urlparse(self.path).path}')
            self._fail()

    def do_POST(self):
        try:
            self._do_POST()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception:
            appdb.exc('ui', f'POST {urlparse(self.path).path}')
            self._fail()

    def _do_GET(self):
        if urlparse(self.path).path == '/healthz':           # for the container health check: no login needed
            b = b'ok'
            self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.send_header('Content-Length', '2'); self.end_headers(); self.wfile.write(b)
            return
        if not self._auth():
            return
        u = urlparse(self.path)
        path = u.path
        try:
            tw = int(parse_qs(u.query).get('w', ['0'])[0])
        except ValueError:
            tw = 0
        if path in ('/', '/index.html'):
            self.send_response(302); self.send_header('Location', '/calendar/'); self.send_header('Content-Length', '0'); self.end_headers()
        elif path == '/stories':
            self.send_response(302); self.send_header('Location', '/stories/'); self.send_header('Content-Length', '0'); self.end_headers()
        elif path == '/stories/':
            b = PAGE_FILE.read_text(encoding='utf-8').encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        elif path == '/favicon.svg':
            b = FAVICON.encode()
            self.send_response(200); self.send_header('Content-Type', 'image/svg+xml'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
        elif path == '/favicon.ico':
            self.send_response(204); self.end_headers()
        elif path == '/api/state':
            self._json(build_state())
        elif path == '/planner':
            self.send_response(302); self.send_header('Location', '/planner/'); self.send_header('Content-Length', '0'); self.end_headers()
        elif path.startswith('/planner/'):
            rel = unquote(path[len('/planner/'):]) or 'index.html'
            f = PLANNER / rel
            if rel in PLANNER_FILES and f.is_file():
                b = f.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8' if rel.endswith('.html') else 'application/javascript; charset=utf-8')
                self.send_header('Content-Length', str(len(b)))
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(b)
            else:
                self.send_error(404)
        elif path == '/api/planner-state':
            if PLANNER_STATE.is_file():
                b = PLANNER_STATE.read_bytes()
                self.send_response(200); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
            else:
                self.send_error(404)
        elif path == '/api/feed':
            FEED.mkdir(parents=True, exist_ok=True)
            files = sorted([p for p in FEED.iterdir() if p.is_file() and p.suffix.lower() in sp.EXT], key=sp.natural_key)
            self._json({'files': [p.name for p in files]})
        elif path in ('/posts', '/posts/'):                    # the posts page moved into the feed planner
            self.send_response(302); self.send_header('Location', '/planner/'); self.send_header('Content-Length', '0'); self.end_headers()
        elif path in ('/calendar', '/calendar/'):
            if path == '/calendar':
                self.send_response(302); self.send_header('Location', '/calendar/'); self.send_header('Content-Length', '0'); self.end_headers()
            else:
                b = (HERE / 'calendar_page.html').read_text(encoding='utf-8').encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(b)))
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(b)
        elif path == '/api/schedule':
            self._json({**sp.schedule_conf(), 'tz': TZNAME})
        elif path == '/api/log':                              # ?limit=100&level=error
            q = parse_qs(u.query)
            self._json({'events': appdb.recent_events(int((q.get('limit') or ['100'])[0] or 100), (q.get('level') or [None])[0])})
        elif path == '/api/db':                               # what the database holds
            self._json(appdb.summary())
        elif path == '/api/posts/state':
            try:
                self._json(PP.build_state())
            except Exception as e:
                self._json({'error': str(e)}, 500)
        elif path.startswith('/pimg/'):
            parts = [unquote(x) for x in path.split('/')[2:]]          # ['slot'|'posted', folder, name]
            f = PP.safe_file(parts[0], parts[1], parts[2]) if len(parts) == 3 and parts[0] in ('slot', 'posted') else None
            if f:
                tb = thumb_bytes(f, tw) if tw else None
                b = tb or f.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'image/jpeg' if tb else (mimetypes.guess_type(f.name)[0] or 'image/jpeg'))
                self.send_header('Content-Length', str(len(b)))
                self.send_header('Cache-Control', 'max-age=300')
                self.end_headers()
                self.wfile.write(b)
            else:
                self.send_error(404)
        elif path.startswith('/img/'):
            parts = path.split('/', 3)                     # ['', 'img', section, name]
            if len(parts) == 4 and parts[2] in SECTIONS:
                f = SECTIONS[parts[2]] / safe_name(unquote(parts[3]))
                if f.is_file() and f.suffix.lower() in sp.EXT:
                    tb = thumb_bytes(f, tw) if tw else None
                    b = tb or f.read_bytes()
                    self.send_response(200)
                    self.send_header('Content-Type', 'image/jpeg' if tb else (mimetypes.guess_type(f.name)[0] or 'image/jpeg'))
                    self.send_header('Content-Length', str(len(b)))
                    self.send_header('Cache-Control', 'max-age=3600')
                    self.end_headers()
                    self.wfile.write(b)
                    return
            self.send_error(404)
        else:
            self.send_error(404)

    def _same_origin(self):
        """A browser always sends Origin on cross-site POSTs: it must be this very server (blocks forms on other sites)."""
        origin = self.headers.get('Origin')
        if origin is None:
            return True                                       # scripts such as curl
        host = (self.headers.get('Host') or '').lower()
        return origin.lower() in ('http://' + host, 'https://' + host)

    def _do_POST(self):
        if not self._auth():
            return
        if not self._same_origin():
            return self._json({'error': 'запит з іншого сайту відхилено'}, 403)
        path = urlparse(self.path).path
        try:
            n = max(0, int(self.headers.get('Content-Length', 0)))
        except ValueError:
            return self._json({'error': 'bad Content-Length'}, 400)
        is_upload = path in ('/api/upload', '/api/feed/upload')
        if not is_upload and not (self.headers.get('Content-Type') or '').lower().startswith('application/json'):
            return self._json({'error': 'очікується application/json'}, 415)
        if path in ('/api/upload', '/api/feed/upload'):
            target = FEED if path == '/api/feed/upload' else FOLDER
            if n > 25 * 1024 * 1024:
                return self._json({'error': 'file larger than 25 MB'}, 413)
            name = safe_name(unquote(self.headers.get('X-Filename', 'photo.jpg')))
            if Path(name).suffix.lower() not in sp.EXT:
                self.rfile.read(n)
                return self._json({'error': 'only jpg, jpeg, png'}, 400)
            data = self.rfile.read(n)
            target.mkdir(parents=True, exist_ok=True)
            dst = unique(target, name)
            dst.write_bytes(data)
            appdb.log('info', 'ui', f'завантажено файл {dst.name} ({len(data) // 1024} КБ) у {target.name}')
            warn = 'larger than 8 MB: the poster will skip it' if (target is FOLDER and len(data) > sp.MAX_BYTES) else ''
            return self._json({'ok': True, 'name': dst.name, 'warning': warn})
        if n > 80 * 1024 * 1024:
            return self._json({'error': 'too large'}, 413)
        raw = self.rfile.read(n) or b'{}'
        try:
            body = json.loads(raw)
        except ValueError:
            return self._json({'error': 'некоректний JSON'}, 400)
        if not isinstance(body, dict):
            return self._json({'error': 'очікується об’єкт JSON'}, 400)
        if path == '/api/planner-state':
            if not isinstance(body.get('cells'), list):
                return self._json({'error': 'bad state'}, 400)
            tmp = PLANNER_STATE.with_suffix('.tmp')
            tmp.write_text(json.dumps(body, ensure_ascii=False), encoding='utf-8')
            tmp.replace(PLANNER_STATE)
            appdb.planner_snapshot(raw.decode('utf-8', 'replace'))
            appdb.log('info', 'ui', f"стрічку збережено на сервері: {len(body['cells'])} клітинок, {len(body.get('archive', []))} в архіві")
            return self._json({'ok': True})
        if path in ('/api/delete', '/api/feed/delete'):
            base = FEED if path == '/api/feed/delete' else FOLDER
            f = base / safe_name(body.get('name', ''))
            if not (f.is_file() and f.suffix.lower() in sp.EXT):
                return self._json({'error': 'not found'}, 404)
            trash = base / 'trash'
            trash.mkdir(exist_ok=True)
            f.rename(unique(trash, f.name))
            appdb.log('info', 'ui', f'файл {f.name} переміщено в кошик ({base.name})')
            return self._json({'ok': True})
        if path == '/api/order':
            names = [safe_name(x) for x in body.get('names', [])]
            existing = {p.name for p in sp.sorted_waiting(FOLDER)}
            (FOLDER / 'order.json').write_text(json.dumps([x for x in names if x in existing], ensure_ascii=False), encoding='utf-8')
            return self._json({'ok': True})
        if path == '/api/schedule':
            try:
                conf = sp.save_schedule_conf(body)
                appdb.schedule_changed(conf)
                appdb.log('info', 'ui', 'налаштування розкладу змінено', json.dumps(conf, ensure_ascii=False))
                return self._json({**conf, 'tz': TZNAME})
            except (ValueError, KeyError, TypeError) as e:
                return self._json({'error': 'некоректні налаштування: ' + str(e)}, 400)
        if path == '/api/posts/schedule':
            try:
                it = PP.schedule(str(body.get('folder', '')))
                return self._json({'ok': True, 'due': it['due'], 'photos': len(it['public_ids'])})
            except (ValueError, RuntimeError) as e:
                return self._json({'error': str(e)}, 400)
            except Exception as e:
                return self._json({'error': 'помилка: ' + str(e)}, 500)
        if path == '/api/feed-meta':
            hid = body.get('hidden')
            if not isinstance(hid, list):
                return self._json({'error': 'очікується список hidden'}, 400)
            saved = PP.save_hidden(hid)
            appdb.feed_meta_changed(saved)
            return self._json({'ok': True, 'hidden': saved})
        if path == '/api/posts/forget':
            try:
                PP.forget(str(body.get('folder', '')))
                return self._json({'ok': True})
            except ValueError as e:
                return self._json({'error': str(e)}, 404)
        if path == '/api/run':
            if not RUN_LOCK.acquire(blocking=False):
                return self._json({'error': 'already running'}, 409)
            try:
                r = subprocess.run([sys.executable, str(HERE / 'story_poster.py')], capture_output=True, text=True, timeout=300, env=os.environ.copy())
                appdb.log('info' if r.returncode == 0 else 'error', 'ui', f'ручний запуск скрипту сторіс завершено з кодом {r.returncode}', (r.stdout + r.stderr)[-1500:])
                return self._json({'ok': r.returncode == 0, 'output': (r.stdout + r.stderr)[-3000:]})
            except subprocess.TimeoutExpired:
                return self._json({'ok': False, 'output': 'timeout after 300 s'})
            finally:
                RUN_LOCK.release()
        self.send_error(404)


PAGE_FILE = HERE / 'stories_page.html'      # the stories page markup lives next to this script


if __name__ == '__main__':
    print(f'UI on port {PORT}, folder {FOLDER}', 'with password' if PASSWORD else 'WITHOUT password (home network only)', flush=True)
    PP.ensure_slots()
    appdb.log('info', 'ui', f'сервер запущено, порт {PORT}')
    threading.Thread(target=appdb.backfill, daemon=True).start()   # first start only: imports queues, history and settings into app.db
    threading.Thread(target=prune_thumbs_loop, daemon=True).start()
    threading.Thread(target=PP.cleanup_loop, daemon=True).start()   # moves published posts to Posted every 30 minutes
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))      # clean stop from `docker stop`: exit code 0
    Server(('0.0.0.0', PORT), H).serve_forever()
