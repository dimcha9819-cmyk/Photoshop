"""Local helper for the Instagram Grid Planner.

Run:   python scraper.py [--login YOUR_USERNAME] [--port 8787]
Open:  http://127.0.0.1:8787/   (this server also serves index.html)

It reads a profile's posts with instaloader and streams them to the page
as NDJSON (one JSON object per line), newest first, same order as the grid.

Notes
- Works without login only for some public profiles and stops early when Instagram
  rate-limits. For the full feed log in once in a terminal:  instaloader --login YOUR_USERNAME
  then start this script with  --login YOUR_USERNAME  (the saved session file is reused;
  the password is never typed into the page).
- Automated reading breaks Instagram's terms of use and the account may get a temporary block.
  Use it only on your own account, with the built-in delays, and not in bulk.
- Listens on 127.0.0.1 only.
"""
import argparse, base64, json, mimetypes, os, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import instaloader

HERE = os.path.dirname(os.path.abspath(__file__))
ARGS = None
LOADER = None


def get_loader():
    global LOADER
    if LOADER is None:
        LOADER = instaloader.Instaloader(download_pictures=False, download_videos=False,
                                         download_video_thumbnails=False, save_metadata=False,
                                         compress_json=False, quiet=True)
        if ARGS.login:
            LOADER.load_session_from_file(ARGS.login)  # created by: instaloader --login USER
    return LOADER


def fetch_data_url(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        mime = r.headers.get_content_type() or "image/jpeg"
        return f"data:{mime};base64," + base64.b64encode(r.read()).decode()


def post_type(p):
    if getattr(p, "is_pinned", False):
        return "pin"
    if p.typename == "GraphSidecar":
        return "multi"
    if p.is_video or getattr(p, "product_type", "") == "clips":
        return "reel"
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")

    def do_OPTIONS(self):
        self.send_response(204); self._cors()
        self.send_header("Access-Control-Allow-Headers", "*"); self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            body = open(os.path.join(HERE, "index.html"), "rb").read()
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        elif u.path.startswith("/feed_crops/") and ".." not in u.path:  # reference column images
            fp = os.path.join(HERE, u.path.lstrip("/"))
            if not os.path.isfile(fp):
                return self.send_error(404)
            body = open(fp, "rb").read()
            self.send_response(200); self.send_header("Content-Type", mimetypes.guess_type(fp)[0] or "image/jpeg")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        elif u.path == "/feed":
            self.feed(parse_qs(u.query).get("user", [""])[0].strip().lstrip("@"),
                      int(parse_qs(u.query).get("limit", ["0"])[0] or 0))
        else:
            self.send_error(404)

    def emit(self, obj):
        self.wfile.write((json.dumps(obj) + "\n").encode()); self.wfile.flush()

    def feed(self, user, limit):
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "application/x-ndjson"); self.end_headers()
        try:
            L = get_loader()
            profile = instaloader.Profile.from_username(L.context, user)
            total = profile.mediacount
            if profile.is_private and not profile.followed_by_viewer and not ARGS.login:
                raise RuntimeError("Profile is private: start the scraper with --login and a saved session.")
            self.emit({"event": "start", "username": profile.username, "total": total})
            n = 0
            for p in profile.get_posts():
                self.emit({"event": "post", "i": n, "type": post_type(p),
                           "img": fetch_data_url(p.url), "shortcode": p.shortcode})
                n += 1
                if limit and n >= limit:
                    break
                time.sleep(0.6)  # be gentle: fewer rate-limit blocks
            self.emit({"event": "done", "count": n})
        except instaloader.exceptions.ProfileNotExistsException:
            hint = ("Instagram often answers 'does not exist' to anonymous requests. "
                    "Log in once: instaloader --login YOUR_USERNAME, then run: python scraper.py --login YOUR_USERNAME"
                    if not ARGS.login else "Check the username spelling.")
            self.emit({"event": "error", "message": f"Profile {user} not found. {hint}"})
        except Exception as e:  # report to the page instead of dropping the connection
            try:
                self.emit({"event": "error", "message": f"{type(e).__name__}: {e}"})
            except Exception:
                pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--login", help="username with a saved instaloader session")
    ap.add_argument("--port", type=int, default=8787)
    ARGS = ap.parse_args()
    print(f"Open http://127.0.0.1:{ARGS.port}/  (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler).serve_forever()
