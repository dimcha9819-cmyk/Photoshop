"""Feed posts through Buffer (standard library only).

Layout on disk (POSTS_DIR, default <data>/posts):
    01 ... 10/        slot folders, fixed, empty or holding one post:
                      photos in order (01.jpg, 02.jpg ...) and one text file with the caption
    Posted/           files of published posts are moved here, one sub-folder per post
    posts_state.json  what is scheduled in Buffer

"Schedule" uploads the photos to Cloudinary (Buffer needs public links), creates one scheduled
Instagram post in Buffer (one photo = single post, several = carousel) with the caption, and records it.
One hour after the publication time the public copies are deleted and the files move to Posted/.
"""
import json, os, re, shutil, struct, threading, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import story_poster as sp
import appdb

sp.load_env()
ROOT = Path(sp.cfg('POSTS_DIR', str(Path(sp.cfg('STORIES_DIR', str(sp.HERE / 'stories'))).expanduser().parent / 'posts'))).expanduser()
POSTED = ROOT / 'Posted'
STATE = ROOT / 'posts_state.json'
TZNAME = sp.cfg('TIMEZONE', 'Europe/Kyiv')
SLOTS = int(sp.cfg('POSTS_SLOTS', '25'))   # number of numbered folders for posts (01..25)
MAX_PHOTOS = 10            # Instagram carousel limit
MAX_CAPTION = 2200         # Instagram caption limit
RATIO_MIN, RATIO_MAX = 0.8, 1.91   # 4:5 .. 1.91:1, the range Buffer publishes automatically
LOCK = threading.RLock()     # held only for short reads/writes of the state file, never during network calls
BUSY = set()                 # folders that are being scheduled right now (uploads in progress)
RESERVED = {}                # folder -> due time reserved for a post that is being scheduled
SKIP = {'posted', 'trash'}


def _tz():
    return sp.get_zone(TZNAME)


_SIZES = {}


def image_size(path):
    """Cached by file time and size: the folders are rescanned often, the photos rarely change."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (str(path), st.st_mtime_ns, st.st_size)
    if key not in _SIZES:
        if len(_SIZES) > 2000:
            _SIZES.clear()
        _SIZES[key] = _image_size_uncached(path)
    return _SIZES[key]


def _image_size_uncached(path):
    """(width, height) of a JPEG or PNG without third-party libraries, or None."""
    try:
        with open(path, 'rb') as f:
            head = f.read(26)
            if head[:8] == b'\x89PNG\r\n\x1a\n':
                return struct.unpack('>II', head[16:24])
            if head[:2] == b'\xff\xd8':
                f.seek(2)
                while True:
                    b = f.read(1)
                    while b and b != b'\xff':
                        b = f.read(1)
                    while b == b'\xff':
                        b = f.read(1)
                    if not b:
                        return None
                    m = b[0]
                    if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
                        continue
                    ln = struct.unpack('>H', f.read(2))[0]
                    if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                        f.read(1)
                        h, w = struct.unpack('>HH', f.read(4))
                        return w, h
                    f.seek(ln - 2, 1)
    except Exception:
        return None
    return None


META = ROOT.parent / 'feed_meta.json'      # written by the feed planner: folders it keeps out of the feed (archive, removed)


def hidden_folders():
    try:
        return set(json.loads(META.read_text(encoding='utf-8')).get('hidden', []))
    except Exception:
        return set()


def save_hidden(folders):
    ROOT.parent.mkdir(parents=True, exist_ok=True)
    clean = sorted({str(f) for f in folders if isinstance(f, str) and len(f) < 64})
    tmp = META.with_suffix('.tmp')
    tmp.write_text(json.dumps({'hidden': clean}, ensure_ascii=False), encoding='utf-8')
    tmp.replace(META)
    return clean


def ensure_slots():
    """Create the numbered folders 01..SLOTS and Posted (existing ones are left alone)."""
    for i in range(1, SLOTS + 1):
        (ROOT / f'{i:02d}').mkdir(parents=True, exist_ok=True)
    POSTED.mkdir(parents=True, exist_ok=True)


def slot_folders():
    ROOT.mkdir(parents=True, exist_ok=True)
    return sorted([d for d in ROOT.iterdir() if d.is_dir() and d.name.lower() not in SKIP and not d.name.startswith(('.', '_'))],
                  key=sp.natural_key)


def folder_files(d):
    imgs = sorted([p for p in d.iterdir() if p.is_file() and p.suffix.lower() in sp.EXT], key=sp.natural_key)
    txts = sorted([p for p in d.iterdir() if p.is_file() and p.suffix.lower() == '.txt'], key=sp.natural_key)
    return imgs, txts


def read_caption(txts):
    if not txts:
        return ''
    return txts[0].read_text(encoding='utf-8-sig', errors='replace').replace('\r\n', '\n').strip()


def check(imgs, caption):
    """Returns (errors, warnings) as lists of Ukrainian messages."""
    err, warn = [], []
    if not imgs:
        err.append('Немає фото')
    if len(imgs) > MAX_PHOTOS:
        err.append(f'Фото більше {MAX_PHOTOS} (ліміт каруселі Instagram)')
    big = [p.name for p in imgs if p.stat().st_size > sp.MAX_BYTES]
    if big:
        err.append('Файл більше 8 МБ: ' + ', '.join(big[:3]))
    if len(caption) > MAX_CAPTION:
        err.append(f'Опис довший за {MAX_CAPTION} символів ({len(caption)})')
    if not caption:
        warn.append('Немає текстового файлу з описом')
    ratios = []
    for p in imgs:
        s = image_size(p)
        if s and s[1]:
            ratios.append(s[0] / s[1])
    if ratios:
        if any(r < RATIO_MIN - 0.005 or r > RATIO_MAX + 0.005 for r in ratios):
            warn.append('Співвідношення сторін поза 4:5 - 1,91:1: Buffer може не опублікувати автоматично, а надіслати сповіщення')
        if max(ratios) - min(ratios) > 0.02:
            warn.append('Фото мають різні пропорції: Instagram обріже за першим')
    return err, warn


def load_state():
    if STATE.exists():
        try:
            return json.loads(STATE.read_text(encoding='utf-8'))
        except Exception:
            pass
    return {'items': []}


def save_state(st):
    ROOT.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(STATE)


def _parse(iso_str):
    return datetime.fromisoformat(iso_str.replace('Z', '+00:00'))


def _next_due(st):
    now = datetime.now(timezone.utc)
    return sp.plan_next([_parse(i['due']) for i in st['items']], now, _tz(), sp.schedule_conf()['posts'], gap_min=120)


def build_state():
    with LOCK:
        st = load_state()
        reserved_map = dict(RESERVED)
        reserved = [{'due': v} for v in reserved_map.values()]
    scheduled = {i['folder']: i for i in st['items']}
    due = None
    sim = {'items': list(st['items']) + reserved}
    waiting = []
    hidden = hidden_folders()
    for d in slot_folders():
        if d.name in scheduled:
            continue
        imgs, txts = folder_files(d)
        if not imgs and not txts:
            continue                                  # empty slot: nothing to show
        cap = read_caption(txts)
        err, warn = check(imgs, cap)
        item = {'folder': d.name, 'images': [p.name for p in imgs], 'caption': cap, 'errors': err, 'warnings': warn, 'expected': None,
                'sig': '|'.join(f'{q.name}:{q.stat().st_size}:{int(q.stat().st_mtime)}' for q in list(imgs) + list(txts[:1]))}
        if d.name in reserved_map:                        # being scheduled right now: keeps the slot reserved for it
            item['expected'] = reserved_map[d.name]
        elif d.name in hidden:                              # archived or removed in the feed planner: takes no publication slot
            item['hidden'] = True
        elif not err:
            due = _next_due(sim)
            item['expected'] = sp.iso(due)
            sim['items'].append({'due': sp.iso(due)})  # next waiting post gets the following slot
        waiting.append(item)
    sched = []
    for i in sorted(st['items'], key=lambda x: x['due']):
        d = ROOT / i['folder']
        sched.append({'folder': i['folder'], 'due': i['due'], 'images': i['files'], 'caption': i.get('caption', '')})
    posted = []
    if POSTED.exists():
        for d in sorted([x for x in POSTED.iterdir() if x.is_dir()], key=lambda x: x.name, reverse=True)[:300]:
            imgs, txts = folder_files(d)
            try:
                due = json.loads((d / 'meta.json').read_text(encoding='utf-8')).get('due')
            except Exception:
                due = None
            posted.append({'set': d.name, 'images': [p.name for p in imgs], 'due': due})
    slots = [d.name for d in slot_folders()]
    return {'waiting': waiting, 'scheduled': sched, 'posted': posted, 'slots': slots,
            'settings': {'post_time': sp.schedule_conf()['posts']['time'], 'tz': TZNAME}}


def safe_file(kind, folder, name):
    """Path of an image to show, or None. kind: 'slot' or 'posted'."""
    base = ROOT if kind == 'slot' else POSTED
    f = (base / folder / os.path.basename(name))
    try:
        if f.resolve().parent.parent == base.resolve() and f.is_file() and f.suffix.lower() in sp.EXT:
            if kind == 'slot' and folder.lower() in SKIP:
                return None
            return f
    except Exception:
        pass
    return None


def _need(name):
    v = os.environ.get(name, '')
    if not v:
        raise RuntimeError(f'не задано {name} у stories.env')
    return v


def buffer_post(urls, caption, channel_id, due_iso, api_key):
    assets = ', '.join('{ image: { url: %s } }' % json.dumps(u) for u in urls)
    q = ('mutation CreatePost { createPost(input: { text: %s channelId: %s schedulingType: automatic '
         'mode: customScheduled dueAt: %s assets: [%s] '
         'metadata: { instagram: { type: post, shouldShareToFeed: true } } }) { '
         '... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }'
         % (json.dumps(caption, ensure_ascii=False), json.dumps(channel_id), json.dumps(due_iso), assets))
    j = sp.http_json(sp.BUFFER_URL, json.dumps({'query': q}).encode(),
                     {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}, timeout=90)
    if j.get('errors'):
        raise RuntimeError('Buffer: ' + '; '.join(e.get('message', '?') for e in j['errors']))
    res = j['data']['createPost']
    if 'post' not in res:
        raise RuntimeError('Buffer: ' + res.get('message', 'невідома помилка'))
    return res['post']['id']


def schedule(folder):
    """Validate under the lock, upload and call Buffer WITHOUT the lock (the pages keep answering), then record the result."""
    with LOCK:
        names = {d.name: d for d in slot_folders()}
        if folder not in names:
            raise ValueError('папку не знайдено')
        if folder in BUSY:
            raise ValueError('цей пост уже планується')
        st = load_state()
        if any(i['folder'] == folder for i in st['items']):
            raise ValueError('пост із цієї папки вже заплановано')
        d = names[folder]
        imgs, txts = folder_files(d)
        caption = read_caption(txts)
        err, _warn = check(imgs, caption)
        if err:
            raise ValueError('; '.join(err))
        api_key, channel = _need('BUFFER_API_KEY'), _need('BUFFER_CHANNEL_ID')
        cloud, ck, cs = _need('CLOUDINARY_CLOUD_NAME'), _need('CLOUDINARY_API_KEY'), _need('CLOUDINARY_API_SECRET')
        due = _next_due({'items': list(st['items']) + [{'due': v} for v in RESERVED.values()]})
        BUSY.add(folder)
        RESERVED[folder] = sp.iso(due)
    done = []
    try:
        try:
            for p in imgs:
                done.append(sp.cld_upload(p, cloud, ck, cs))
            post_id = buffer_post([u for u, _ in done], caption, channel, sp.iso(due), api_key)
        except Exception:
            for _u, pid in done:
                try:
                    sp.cld_delete(pid, cloud, ck, cs)
                except Exception:
                    pass
            raise
        item = {'folder': folder, 'due': sp.iso(due), 'post_id': post_id, 'public_ids': [pid for _u, pid in done],
                'files': [p.name for p in imgs] + [t.name for t in txts[:1]], 'caption': caption}
        with LOCK:
            st = load_state()
            st['items'].append(item)
            save_state(st)
        appdb.post_event(folder, 'scheduled', item['due'], post_id, caption, item['files'], item['public_ids'])
        appdb.log('info', 'posts', f"пост із папки {folder} заплановано на {item['due']} ({len(imgs)} фото)")
        return item
    except Exception:
        appdb.exc('posts', f'не вдалося запланувати пост із папки {folder}')
        raise
    finally:
        with LOCK:
            BUSY.discard(folder)
            RESERVED.pop(folder, None)


def _delete_public(ids):
    cloud, ck, cs = _need('CLOUDINARY_CLOUD_NAME'), _need('CLOUDINARY_API_KEY'), _need('CLOUDINARY_API_SECRET')
    for pid in ids:
        sp.cld_delete(pid, cloud, ck, cs)


def forget(folder):
    """Remove a scheduled post from our list (after it was deleted in Buffer): the folder returns to waiting."""
    with LOCK:
        st = load_state()
        it = next((i for i in st['items'] if i['folder'] == folder), None)
        if not it:
            raise ValueError('такого запланованого поста немає')
        st['items'].remove(it)
        save_state(st)
    appdb.post_event(folder, 'forgotten')
    appdb.log('info', 'posts', f'папку {folder} повернуто в очікування (запланований пост забуто)')
    try:
        _delete_public(it['public_ids'])                  # best effort, outside the lock
    except Exception as e:
        appdb.log('warning', 'posts', f'не вдалося видалити копії поста {folder} на Cloudinary', str(e))


def cleanup():
    """One hour after the publication time: delete the public copies, move the files to Posted/<date>_<folder>/."""
    moved = 0
    now = datetime.now(timezone.utc)
    with LOCK:
        due_items = [dict(i) for i in load_state()['items'] if _parse(i['due']) + timedelta(hours=1) < now]
    for it in due_items:
        try:
            _delete_public(it['public_ids'])              # network call, no lock held
        except Exception as e:
            appdb.log('warning', 'posts', f"не вдалося видалити копії поста {it['folder']} на Cloudinary, повторю", str(e))
            continue
        with LOCK:
            st = load_state()
            cur = next((i for i in st['items'] if i['folder'] == it['folder'] and i['due'] == it['due']), None)
            if not cur:
                continue                                  # forgotten meanwhile
            POSTED.mkdir(parents=True, exist_ok=True)
            stamp = _parse(it['due']).astimezone(_tz()).strftime('%Y-%m-%d')
            dst = POSTED / f"{stamp}_{it['folder']}"
            k = 1
            while dst.exists():
                dst = POSTED / f"{stamp}_{it['folder']}_{k}"
                k += 1
            dst.mkdir()
            for name in cur['files']:
                src = ROOT / cur['folder'] / name
                if src.exists():
                    shutil.move(str(src), str(dst / name))
            (dst / 'meta.json').write_text(json.dumps({'due': cur['due'], 'folder': cur['folder']}), encoding='utf-8')
            st['items'].remove(cur)
            save_state(st)
            moved += 1
            appdb.post_event(cur['folder'], 'published', posted_set=dst.name)
            appdb.log('info', 'posts', f"пост із папки {cur['folder']} опубліковано, файли перенесено в Posted/{dst.name}")
    return moved


def cleanup_loop(interval=1800):
    while True:
        try:
            n = cleanup()
        except Exception:
            appdb.exc('posts', 'помилка очищення опублікованих постів')
        time.sleep(interval)
