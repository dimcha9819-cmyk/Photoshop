"""Error log and a small SQLite database with what happens on all pages (standard library only).

Files (next to the other data, folder /data in the container):
    app.db            SQLite database: events (log), stories, posts, schedule_changes, feed_meta_changes, planner_snapshots
    logs/app.log      the same log as text, rotated (1 MB x 5 files)

Nothing here may break the program: every function swallows its own errors and only prints them.
Both containers (the hourly stories loop and the web UI) write to the same file; writes are short,
SQLite waits up to 10 s for the other writer.
"""
import json, logging, logging.handlers, os, sqlite3, sys, threading, traceback
from datetime import datetime, timezone
from pathlib import Path

_LOCK = threading.Lock()
_READY = set()
_FILE_LOGGER = None
_INSERTS = 0
MAX_EVENTS = 5000            # older events are deleted
KEEP_SNAPSHOTS = 10          # last saved feeds kept in full

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS stories (id INTEGER PRIMARY KEY, file TEXT NOT NULL, status TEXT NOT NULL, due TEXT, post_id TEXT, public_id TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, folder TEXT NOT NULL, status TEXT NOT NULL, due TEXT, post_id TEXT, caption TEXT, files TEXT, public_ids TEXT, posted_set TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schedule_changes (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, config TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS feed_meta_changes (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, hidden TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS planner_snapshots (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, cells INTEGER, archive INTEGER, size INTEGER, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS ix_stories_file ON stories(file);
CREATE INDEX IF NOT EXISTS ix_posts_folder ON posts(folder);
"""


def _now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _base():
    import story_poster as sp                                 # lazy: story_poster imports this module
    return Path(sp.cfg('STORIES_DIR', str(sp.HERE / 'stories'))).expanduser().parent


def db_path():
    return Path(os.environ.get('DB_PATH') or (_base() / 'app.db'))


def _conn():
    p = db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(p), timeout=10)
    c.row_factory = sqlite3.Row
    if str(p) not in _READY:
        c.executescript(SCHEMA)
        _READY.add(str(p))
    return c


def _run(fn):
    """Run fn(connection) in a short transaction; never raises."""
    try:
        with _LOCK:
            c = _conn()
            try:
                r = fn(c)
                c.commit()
                return r
            finally:
                c.close()
    except Exception as e:
        print(f'[appdb] database error: {e}', file=sys.stderr, flush=True)
        return None


def _file_logger():
    global _FILE_LOGGER
    if _FILE_LOGGER is None:
        lg = logging.getLogger('stories-app')
        lg.setLevel(logging.INFO)
        lg.propagate = False
        try:
            d = _base() / 'logs'
            d.mkdir(parents=True, exist_ok=True)
            h = logging.handlers.RotatingFileHandler(d / 'app.log', maxBytes=1_000_000, backupCount=5, encoding='utf-8')
            h.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
            lg.addHandler(h)
        except Exception as e:
            print(f'[appdb] cannot open the log file: {e}', file=sys.stderr, flush=True)
        _FILE_LOGGER = lg
    return _FILE_LOGGER


# ---------- log ----------
def log(level, source, message, detail=None):
    """level: info | warning | error. Printed (docker logs), written to logs/app.log and to the events table."""
    level = level.lower()
    print(f'[{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}] {level.upper()} {source}: {message}', flush=True)
    try:
        _file_logger().log({'error': logging.ERROR, 'warning': logging.WARNING}.get(level, logging.INFO),
                           f'{source}: {message}' + (f' | {detail}' if detail else ''))
    except Exception:
        pass
    def ins(c):
        global _INSERTS
        c.execute('INSERT INTO events(ts, level, source, message, detail) VALUES (?,?,?,?,?)', (_now(), level, source, str(message)[:2000], None if detail is None else str(detail)[:8000]))
        _INSERTS += 1
        if _INSERTS % 200 == 0:
            c.execute('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?', (MAX_EVENTS,))
    _run(ins)


def exc(source, message):
    """Log the exception that is being handled, with its traceback."""
    log('error', source, f'{message}: {sys.exc_info()[1]}', traceback.format_exc())


# ---------- stories ----------
def story_event(file, status, due=None, post_id=None, public_id=None):
    """status: queued (in the Buffer queue) | published (time passed, moved to posted/)."""
    def f(c):
        t = _now()
        if status == 'queued':
            c.execute('INSERT INTO stories(file, status, due, post_id, public_id, created, updated) VALUES (?,?,?,?,?,?,?)', (file, status, due, post_id, public_id, t, t))
            return
        row = c.execute("SELECT id FROM stories WHERE file=? AND status='queued' ORDER BY id DESC LIMIT 1", (file,)).fetchone()
        if row:
            c.execute('UPDATE stories SET status=?, updated=? WHERE id=?', (status, t, row['id']))
        else:
            c.execute('INSERT INTO stories(file, status, due, post_id, public_id, created, updated) VALUES (?,?,?,?,?,?,?)', (file, status, due, post_id, public_id, t, t))
    _run(f)


# ---------- posts ----------
def post_event(folder, status, due=None, post_id=None, caption=None, files=None, public_ids=None, posted_set=None):
    """status: scheduled | published | forgotten (returned to waiting after deleting it in Buffer)."""
    def f(c):
        t = _now()
        if status == 'scheduled':
            c.execute('INSERT INTO posts(folder, status, due, post_id, caption, files, public_ids, posted_set, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)',
                      (folder, status, due, post_id, caption, json.dumps(files or [], ensure_ascii=False), json.dumps(public_ids or []), posted_set, t, t))
            return
        row = c.execute("SELECT id FROM posts WHERE folder=? AND status='scheduled' ORDER BY id DESC LIMIT 1", (folder,)).fetchone()
        if row:
            c.execute('UPDATE posts SET status=?, posted_set=COALESCE(?, posted_set), updated=? WHERE id=?', (status, posted_set, t, row['id']))
        else:
            c.execute('INSERT INTO posts(folder, status, due, post_id, caption, files, public_ids, posted_set, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)',
                      (folder, status, due, post_id, caption, json.dumps(files or [], ensure_ascii=False), json.dumps(public_ids or []), posted_set, t, t))
    _run(f)


# ---------- settings and feed ----------
def schedule_changed(conf):
    _run(lambda c: c.execute('INSERT INTO schedule_changes(ts, config) VALUES (?,?)', (_now(), json.dumps(conf, ensure_ascii=False))))


def feed_meta_changed(hidden):
    s = json.dumps(sorted(hidden), ensure_ascii=False)

    def f(c):
        last = c.execute('SELECT hidden FROM feed_meta_changes ORDER BY id DESC LIMIT 1').fetchone()
        if not last or last['hidden'] != s:
            c.execute('INSERT INTO feed_meta_changes(ts, hidden) VALUES (?,?)', (_now(), s))
    _run(f)


def planner_snapshot(raw_json):
    """The feed saved from the planner page (photos as data URLs); the last KEEP_SNAPSHOTS are kept."""
    try:
        d = json.loads(raw_json)
        cells, arch = len(d.get('cells', [])), len(d.get('archive', []))
    except Exception:
        cells = arch = None

    def f(c):
        c.execute('INSERT INTO planner_snapshots(ts, cells, archive, size, json) VALUES (?,?,?,?,?)', (_now(), cells, arch, len(raw_json), raw_json))
        c.execute('DELETE FROM planner_snapshots WHERE id <= (SELECT MAX(id) FROM planner_snapshots) - ?', (KEEP_SNAPSHOTS,))
    _run(f)


# ---------- reading ----------
def recent_events(limit=100, level=None):
    limit = max(1, min(int(limit), 1000))

    def f(c):
        if level:
            rows = c.execute('SELECT id, ts, level, source, message, detail FROM events WHERE level=? ORDER BY id DESC LIMIT ?', (level, limit)).fetchall()
        else:
            rows = c.execute('SELECT id, ts, level, source, message, detail FROM events ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
        return [dict(r) for r in rows]
    return _run(f) or []


def summary():
    def f(c):
        out = {t: c.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in ('events', 'stories', 'posts', 'schedule_changes', 'feed_meta_changes', 'planner_snapshots')}
        out['errors_24h'] = c.execute("SELECT COUNT(*) FROM events WHERE level='error' AND ts > strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day')").fetchone()[0]
        out['stories_by_status'] = {r[0]: r[1] for r in c.execute('SELECT status, COUNT(*) FROM stories GROUP BY status')}
        out['posts_by_status'] = {r[0]: r[1] for r in c.execute('SELECT status, COUNT(*) FROM posts GROUP BY status')}
        return out
    r = _run(f) or {}
    try:
        r['db_size_kb'] = round(db_path().stat().st_size / 1024)
    except OSError:
        pass
    return r


# ---------- one-time import of what already exists ----------
def backfill():
    """On the first start fill the database from the files that exist now (queues, history, settings, saved feed)."""
    def done(c):
        return c.execute("SELECT 1 FROM events WHERE source='db' AND message='backfill done'").fetchone()
    if _run(done):
        return
    import story_poster as sp
    base = _base()
    folder = Path(sp.cfg('STORIES_DIR', str(sp.HERE / 'stories'))).expanduser()
    n = {'stories': 0, 'posts': 0}
    try:
        st = json.loads((folder / 'state.json').read_text(encoding='utf-8')) if (folder / 'state.json').exists() else {}
        known = set()
        for it in st.get('items', []):
            story_event(it['file'], 'queued', it.get('due'), it.get('post_id'), it.get('public_id')); known.add(it['file']); n['stories'] += 1
        for it in st.get('history', []):
            story_event(it['file'], 'published', it.get('due')); known.add(it['file']); n['stories'] += 1
        if (folder / 'posted').is_dir():
            for p in sorted((folder / 'posted').iterdir()):
                if p.is_file() and p.suffix.lower() in sp.EXT and p.name not in known:
                    story_event(p.name, 'published'); n['stories'] += 1
    except Exception as e:
        log('warning', 'db', f'backfill of stories failed: {e}')
    try:
        root = Path(sp.cfg('POSTS_DIR', str(base / 'posts'))).expanduser()
        ps = json.loads((root / 'posts_state.json').read_text(encoding='utf-8')) if (root / 'posts_state.json').exists() else {}
        for it in ps.get('items', []):
            post_event(it['folder'], 'scheduled', it.get('due'), it.get('post_id'), it.get('caption'), it.get('files'), it.get('public_ids')); n['posts'] += 1
        if (root / 'Posted').is_dir():
            for d in sorted(x for x in (root / 'Posted').iterdir() if x.is_dir()):
                try:
                    meta = json.loads((d / 'meta.json').read_text(encoding='utf-8'))
                except Exception:
                    meta = {}
                files = sorted(p.name for p in d.iterdir() if p.is_file())
                cap = next((p.read_text(encoding='utf-8-sig', errors='replace') for p in d.iterdir() if p.suffix.lower() == '.txt'), None)
                t = _now()
                _run(lambda c: c.execute('INSERT INTO posts(folder, status, due, caption, files, posted_set, created, updated) VALUES (?,?,?,?,?,?,?,?)',
                                         (meta.get('folder') or d.name.split('_', 1)[-1], 'published', meta.get('due'), cap, json.dumps(files, ensure_ascii=False), d.name, t, t)))
                n['posts'] += 1
    except Exception as e:
        log('warning', 'db', f'backfill of posts failed: {e}')
    try:
        if (base / 'schedule.json').exists():
            schedule_changed(json.loads((base / 'schedule.json').read_text(encoding='utf-8')))
        if (base / 'feed_meta.json').exists():
            feed_meta_changed(json.loads((base / 'feed_meta.json').read_text(encoding='utf-8')).get('hidden', []))
        if (base / 'planner.json').exists():
            planner_snapshot((base / 'planner.json').read_text(encoding='utf-8'))
    except Exception as e:
        log('warning', 'db', f'backfill of settings failed: {e}')
    log('info', 'db', 'backfill done', json.dumps(n))
