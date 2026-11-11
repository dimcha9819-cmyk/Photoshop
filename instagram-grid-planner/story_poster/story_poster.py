"""Daily Instagram Stories through Buffer.

Takes photos from a folder, uploads each one to Cloudinary (Buffer needs a public image URL),
creates a scheduled Story in Buffer through its GraphQL API and keeps the queue filled for
DAYS_AHEAD days. Run it once a day (cron / Synology Task Scheduler).

    python story_poster.py              # normal run
    python story_poster.py --dry-run    # show what would happen, no network calls

Folders inside STORIES_DIR
    (root)       photos waiting to be scheduled, taken in file-name order
    scheduled/   photos already queued in Buffer
    posted/      photos whose story time has passed
State is kept in STORIES_DIR/state.json. Secrets come from environment variables or a .env file
next to this script (see .env.example). Never commit .env.
"""
import argparse, hashlib, json, os, re, shutil, sys, time, uuid
import urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone, tzinfo
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import appdb                                    # error log + SQLite database (never raises)
EXT = {'.jpg', '.jpeg', '.png'}
MAX_BYTES = 8 * 1024 * 1024          # Instagram limit for images
BUFFER_URL = os.environ.get('BUFFER_URL', 'https://api.buffer.com')
CLD_BASE = os.environ.get('CLOUDINARY_BASE', 'https://api.cloudinary.com/v1_1')


class EUZone(tzinfo):
    """Fallback for hosts without a time zone database: Kyiv time, EU daylight saving rules."""
    def __init__(self, std_hours): self.std = timedelta(hours=std_hours)
    @staticmethod
    def _last_sunday(year, month):
        d = datetime(year, month, 31 if month in (3, 10) else 30)
        return d - timedelta(days=(d.weekday() + 1) % 7)
    def _dst_utc(self, naive_utc):      # EU rule: from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of October
        y = naive_utc.year
        return self._last_sunday(y, 3).replace(hour=1) <= naive_utc < self._last_sunday(y, 10).replace(hour=1)
    def _dst_local(self, naive):        # same rule written in local wall time (03:00 EET -> 04:00 EEST, back at 04:00 EEST -> 03:00 EET)
        y = naive.year
        return self._last_sunday(y, 3).replace(hour=3) <= naive < self._last_sunday(y, 10).replace(hour=4)
    def utcoffset(self, dt):
        if dt is None: return self.std
        return self.std + (timedelta(hours=1) if self._dst_local(dt.replace(tzinfo=None)) else timedelta(0))
    def dst(self, dt): return self.utcoffset(dt) - self.std
    def tzname(self, dt): return 'EEST' if self.dst(dt) else 'EET'
    def fromutc(self, dt):
        naive = dt.replace(tzinfo=None)
        return (naive + self.std + (timedelta(hours=1) if self._dst_utc(naive) else timedelta(0))).replace(tzinfo=self)


def get_zone(name):
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:
        if name in ('Europe/Kyiv', 'Europe/Kiev'):
            return EUZone(2)
        sys.exit(f"Time zone '{name}' not found and no zone database in this Python. Use TIMEZONE=Europe/Kyiv or install tzdata.")


def http_json(url, data=None, headers=None, timeout=60):
    """POST a body (bytes) and return parsed JSON; raises RuntimeError with the server's message on HTTP errors."""
    req = urllib.request.Request(url, data=data, headers=headers or {}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')[:300]
        raise RuntimeError(f'HTTP {e.code} from {urllib.parse.urlparse(url).netloc}: {body}')
    except urllib.error.URLError as e:
        raise RuntimeError(f'network error to {urllib.parse.urlparse(url).netloc}: {e.reason}')


def multipart(fields, file_field, file_path):
    b = uuid.uuid4().hex
    out = bytearray()
    for k, v in fields.items():
        out += f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    out += (f'--{b}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'
            f'Content-Type: application/octet-stream\r\n\r\n').encode()
    out += file_path.read_bytes() + f'\r\n--{b}--\r\n'.encode()
    return bytes(out), f'multipart/form-data; boundary={b}'


def load_env():
    f = HERE / '.env'
    if f.exists():
        for line in f.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def cfg(name, default=None, required=False):
    v = os.environ.get(name, default)
    if required and not v:
        sys.exit(f'Missing setting {name}. Fill it in .env (see .env.example).')
    return v


def _conf_path():
    return Path(cfg('STORIES_DIR', str(HERE / 'stories'))).expanduser().parent / 'schedule.json'


def schedule_conf():
    """Frequency settings: values saved on the Calendar page (data/schedule.json) win over the env defaults."""
    allw = [0, 1, 2, 3, 4, 5, 6]
    conf = {'stories': {'time': cfg('POST_TIME', '12:00'), 'per_day': int(cfg('PER_DAY', '1')), 'days_ahead': int(cfg('DAYS_AHEAD', '7')),
                        'every_days': 1, 'weekdays': allw},
            'posts': {'time': cfg('POSTS_TIME', '18:00'), 'per_day': 1, 'every_days': int(cfg('POSTS_EVERY_DAYS', '1')), 'weekdays': allw}}
    try:
        saved = json.loads(_conf_path().read_text(encoding='utf-8'))
        for k in conf:
            conf[k].update(saved.get(k, {}))
    except Exception:
        pass
    return conf


def save_schedule_conf(new):
    """Validate and store the settings; returns the stored dict."""
    def num(v, lo, hi):
        v = int(v)
        if not lo <= v <= hi:
            raise ValueError(f'значення має бути від {lo} до {hi}')
        return v

    def hhmm(v):
        if not re.fullmatch(r'([01]\d|2[0-3]):[0-5]\d', str(v)):
            raise ValueError('час має бути у форматі ГГ:ХХ')
        return str(v)
    def wdays(v):
        v = sorted({int(x) for x in v})
        if not v or v[0] < 0 or v[-1] > 6:
            raise ValueError('оберіть хоча б один день тижня')
        return v
    s, p = new.get('stories', {}), new.get('posts', {})
    out = {'stories': {'time': hhmm(s['time']), 'per_day': num(s['per_day'], 1, 10), 'days_ahead': num(s['days_ahead'], 1, 60),
                       'every_days': num(s['every_days'], 1, 30), 'weekdays': wdays(s['weekdays'])},
           'posts': {'time': hhmm(p['time']), 'per_day': num(p['per_day'], 1, 5), 'every_days': num(p['every_days'], 1, 30),
                     'weekdays': wdays(p['weekdays'])}}
    path = _conf_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)
    return out


def natural_key(p):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', p.name)]


def sorted_waiting(folder):
    """Waiting photos: first those listed in order.json (set from the web UI), then the rest by natural file-name order."""
    files = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in EXT]
    try:
        order = json.loads((folder / 'order.json').read_text(encoding='utf-8'))
    except Exception:
        order = []
    pos = {n: i for i, n in enumerate(order)}
    return sorted(files, key=lambda p: (pos.get(p.name, len(pos)), natural_key(p)))


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


# ---------- state ----------
def load_state(path):
    if path.exists():
        return json.loads(path.read_text(encoding='utf-8'))
    return {'items': []}   # item: {file, due, post_id, public_id}


def save_state(path, st):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)


# ---------- schedule ----------
def next_slot(after_utc, tz, hhmm):
    """First daily slot (local time hhmm) strictly later than after_utc, returned as UTC."""
    h, m = map(int, hhmm.split(':'))
    d = after_utc.astimezone(tz)
    cand = d.replace(hour=h, minute=m, second=0, microsecond=0)
    if cand <= d:
        cand += timedelta(days=1)
    return cand.astimezone(timezone.utc)


def plan_next(dues, now_utc, tz, rule, gap_min=30):
    """Next publication time under a rule {time, every_days, per_day, weekdays} given the already scheduled times (UTC datetimes).
    Extra items of the same day follow the previous one after gap_min; otherwise the next allowed day is
    last day + every_days (moved forward to an allowed weekday), at the rule time. Never earlier than now + 10 min."""
    h, m = map(int, rule['time'].split(':'))
    every, per = max(1, int(rule.get('every_days', 1))), max(1, int(rule.get('per_day', 1)))
    wd = set(rule.get('weekdays') or range(7))
    floor = now_utc + timedelta(minutes=10)

    def at(d):
        return datetime(d.year, d.month, d.day, h, m, tzinfo=tz).astimezone(timezone.utc)
    local = sorted(x.astimezone(tz) for x in dues)
    if local:
        last = local[-1]
        if sum(1 for x in local if x.date() == last.date()) < per:
            c = last + timedelta(minutes=gap_min)
            if c.date() == last.date() and c.astimezone(timezone.utc) >= floor:
                return c.astimezone(timezone.utc)
        d = last.date() + timedelta(days=every)
    else:
        d = now_utc.astimezone(tz).date()
    for _ in range(800):
        if d.weekday() in wd and at(d) >= floor:
            return at(d)
        d += timedelta(days=1)
    return floor


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')


# ---------- Cloudinary (signed REST) ----------
def cld_sign(params, secret):
    s = '&'.join(f'{k}={params[k]}' for k in sorted(params) if params[k] not in (None, ''))
    return hashlib.sha1((s + secret).encode()).hexdigest()


def cld_upload(path, cloud, key, secret):
    ts = int(time.time())
    pid = 'stories_' + hashlib.sha1(f'{path.name}{ts}{uuid.uuid4().hex}'.encode()).hexdigest()[:16]   # unguessable name
    params = {'public_id': pid, 'timestamp': ts}
    fields = {**params, 'api_key': key, 'signature': cld_sign(params, secret)}
    body, ctype = multipart(fields, 'file', path)
    j = http_json(f'{CLD_BASE}/{cloud}/image/upload', body, {'Content-Type': ctype}, timeout=180)
    if 'secure_url' not in j:
        raise RuntimeError('Cloudinary: ' + json.dumps(j)[:300])
    return j['secure_url'], j['public_id']


def cld_delete(public_id, cloud, key, secret):
    ts = int(time.time())
    params = {'public_id': public_id, 'timestamp': ts}
    data = urllib.parse.urlencode({**params, 'api_key': key, 'signature': cld_sign(params, secret)}).encode()
    http_json(f'{CLD_BASE}/{cloud}/image/destroy', data, {'Content-Type': 'application/x-www-form-urlencoded'})


# ---------- Buffer ----------
def buffer_story(url, channel_id, due_iso, api_key):
    q = ('mutation CreatePost { createPost(input: { text: "" channelId: %s schedulingType: automatic '
         'mode: customScheduled dueAt: %s assets: [{ image: { url: %s } }] '
         'metadata: { instagram: { type: story, shouldShareToFeed: false } } }) { '
         '... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }'
         % (json.dumps(channel_id), json.dumps(due_iso), json.dumps(url)))
    j = http_json(BUFFER_URL, json.dumps({'query': q}).encode(),
                  {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'})
    if j.get('errors'):
        raise RuntimeError('Buffer: ' + '; '.join(e.get('message', '?') for e in j['errors']))
    res = j['data']['createPost']
    if 'post' not in res:
        raise RuntimeError('Buffer: ' + res.get('message', 'unknown error'))
    return res['post']['id']


_LOCK_HANDLE = None


def acquire_run_lock(folder):
    """Only one poster run at a time, also across the two containers that share /data (loop and the UI button)."""
    global _LOCK_HANDLE
    folder.mkdir(parents=True, exist_ok=True)
    f = open(folder / '.poster.lock', 'a+')
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return False
    _LOCK_HANDLE = f
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='no network calls, no file moves')
    args = ap.parse_args()
    load_env()

    folder = Path(cfg('STORIES_DIR', str(HERE / 'stories'))).expanduser()
    if not args.dry_run and not acquire_run_lock(folder):
        log('another run is in progress: nothing to do')
        return
    tz = get_zone(cfg('TIMEZONE', 'Europe/Kyiv'))
    sc = schedule_conf()['stories']
    days_ahead, per_day = int(sc['days_ahead']), int(sc['per_day'])
    if not args.dry_run:
        api_key = cfg('BUFFER_API_KEY', required=True)
        channel = cfg('BUFFER_CHANNEL_ID', required=True)
        cloud = cfg('CLOUDINARY_CLOUD_NAME', required=True)
        ck, cs = cfg('CLOUDINARY_API_KEY', required=True), cfg('CLOUDINARY_API_SECRET', required=True)

    for sub in ('scheduled', 'posted'):
        (folder / sub).mkdir(parents=True, exist_ok=True)
    state_file = folder / 'state.json'
    st = load_state(state_file)
    now = datetime.now(timezone.utc)

    # 1) clean up stories whose time has passed: delete the public copy, move the file to posted/
    for it in list(st['items']):
        if datetime.fromisoformat(it['due'].replace('Z', '+00:00')) + timedelta(hours=1) < now:
            log(f"time passed for {it['file']}: cleanup")
            if not args.dry_run:
                try:
                    cld_delete(it['public_id'], cloud, ck, cs)
                except Exception as e:
                    log(f"  could not delete Cloudinary copy ({e}), will retry next run")
                    appdb.log('warning', 'stories', f"не вдалося видалити копію {it['file']} на Cloudinary, повторю наступного разу", str(e))
                    continue
                src = folder / 'scheduled' / it['file']
                if src.exists():
                    shutil.move(str(src), str(folder / 'posted' / it['file']))
                st.setdefault('history', []).append({'file': it['file'], 'due': it['due']})   # kept for the Calendar page
                appdb.story_event(it['file'], 'published', it['due'])
                appdb.log('info', 'stories', f"{it['file']}: час публікації минув, копію видалено, файл у posted/")
                st['items'].remove(it)
                save_state(state_file, st)

    # 2) fill the queue
    waiting = sorted_waiting(folder)
    queued = len(st['items'])
    log(f'waiting photos: {len(waiting)}, already queued: {queued}, queue horizon: {days_ahead} days')
    dues = [datetime.fromisoformat(i['due'].replace('Z', '+00:00')) for i in st['items']]
    horizon = now + timedelta(days=days_ahead)

    added = 0
    for p in waiting:
        if p.stat().st_size > MAX_BYTES:
            log(f'skip {p.name}: larger than 8 MB')
            continue
        due = plan_next(dues, now, tz, sc)              # rule from the Calendar page: time, every N days, per day, weekdays
        if due > horizon:
            break
        log(f"{p.name} -> story at {due.astimezone(tz).strftime('%Y-%m-%d %H:%M')} ({cfg('TIMEZONE', 'Europe/Kyiv')})")
        if args.dry_run:
            dues.append(due)
            queued += 1; added += 1
            continue
        try:
            url, pid = cld_upload(p, cloud, ck, cs)
            try:
                post_id = buffer_story(url, channel, iso(due), api_key)
            except Exception:
                cld_delete(pid, cloud, ck, cs)          # do not leave an orphan public file
                raise
        except Exception as e:
            log(f'  FAILED: {e}. Stopping this run, nothing is lost, the file stays in place.')
            appdb.exc('stories', f'не вдалося запланувати {p.name}, запуск зупинено, файл на місці')
            break
        shutil.move(str(p), str(folder / 'scheduled' / p.name))
        st['items'].append({'file': p.name, 'due': iso(due), 'post_id': post_id, 'public_id': pid})
        save_state(state_file, st)
        appdb.story_event(p.name, 'queued', iso(due), post_id, pid)
        appdb.log('info', 'stories', f"{p.name} заплановано на {due.astimezone(tz).strftime('%Y-%m-%d %H:%M')}")
        dues.append(due)
        queued += 1; added += 1
    log(f'done: {added} story(ies) scheduled, queue now {queued}')
    if len(waiting) - added <= per_day * 2 and len(waiting) > 0:
        log(f'WARNING: only {max(0, len(waiting) - added)} photo(s) left in the folder, add more')
        if not args.dry_run:
            appdb.log('warning', 'stories', f'у теці лишилося фото: {max(0, len(waiting) - added)}, додайте нові')
    if not waiting and not queued:
        log('WARNING: folder is empty, nothing to schedule')
        if not args.dry_run:
            appdb.log('warning', 'stories', 'тека порожня, нічого планувати')


if __name__ == '__main__':
    try:
        main()
    except SystemExit as e:
        if e.code not in (0, None):
            appdb.log('error', 'stories', f'запуск завершено з помилкою: {e.code}')
        raise
    except Exception:
        appdb.exc('stories', 'необроблена помилка запуску')
        raise
