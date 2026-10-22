#!/usr/bin/env python3
r"""atn_tool.py — чтение и правка наборов операций Photoshop (.atn).

Зачем. Операция, запускающая скрипт, хранит внутри .atn АБСОЛЮТНЫЙ путь
к .jsx. Переименовали скрипт или перенесли папку — операция указывает в
пустоту, и Photoshop об этом молчит до запуска. Открыть .atn текстом
нельзя: формат двоичный. Этот инструмент показывает, что внутри, и
правит пути, не трогая остального.

Команды
    list    показать набор, операции и пути к скриптам
    check   проверить, что все пути ведут к существующим файлам
    rewrite заменить имена .jsx по карте переименований
    repath  сменить папку у всех путей к скриптам
    remove  удалить операцию из набора

Примеры
    python atn_tool.py list Export.atn
    python atn_tool.py check Export.atn
    python atn_tool.py rewrite Export.atn out.atn old.jsx=new.jsx
    python atn_tool.py repath Export.atn out.atn "C:\Scripts"
    python atn_tool.py remove Export.atn out.atn "Save JPG EDITED"

Формат .atn, версия 16
    4 байта   версия (16)
    ustring   имя набора
    1 байт    развёрнут ли набор
    4 байта   число операций
    операции подряд, каждая:
        2 байта  индекс
        1 байт   клавиша Shift
        1 байт   клавиша Ctrl
        2 байта  цвет
        ustring  имя операции
        1 байт   развёрнута ли
        4 байта  число шагов
        шаги ...

    ustring = 4 байта длины в символах + UTF-16BE, включая конечный ноль.

    Шаг запуска скрипта содержит дескриптор с ключом jsCt типа 'Pth ':
        'jsCt' 'Pth ' [4 байта длины блоба] 'txtu' … [4 байта длины
        строки] UTF-16BE(ведущий ноль + путь) [хвост блоба]

Тело шага не разбирается — оно и не нужно. Границы операций находятся
по именам: заголовок начинается ровно за 6 байт до поля длины имени.
Корректность разбора проверяется двумя способами, оба выполняются
автоматически перед записью:
    • холостая правка — замена каждого пути на самого себя обязана
      дать побайтово тот же файл;
    • разметка — операции обязаны вплотную покрывать файл от заголовка
      до последнего байта, без разрывов и нахлёстов.
Не сошлось — файл не записывается.

Известное ограничение. Разметка операций опирается на поиск заголовков
перебором, и в наборах, где внутри шагов попадаются байты, похожие на
заголовок, она не сходится: list покажет среди имён операций мусор, а
remove откажется работать. Это не мешает rewrite и check — они опираются
только на ключ jsCtPth, который находится однозначно.
"""

import argparse
import os
import struct
import sys

KEY = b"jsCtPth "


# ---------------------------------------------------------------- чтение

def read_ustring(data, off):
    """4 байта длины в символах + UTF-16BE -> (текст, смещение за концом)"""
    (n,) = struct.unpack_from(">I", data, off)
    raw = data[off + 4: off + 4 + n * 2]
    return raw.decode("utf-16-be").replace("\x00", ""), off + 4 + n * 2


def script_entries(data):
    """Шаги запуска скриптов: [{смещения полей длины, путь}]"""
    out = []
    pos = 0
    while True:
        k = data.find(KEY, pos)
        if k < 0:
            break
        pos = k + 1

        blob_len_off = k + 8
        (blob_len,) = struct.unpack_from(">I", data, blob_len_off)
        blob_start = blob_len_off + 4
        if data[blob_start:blob_start + 4] != b"txtu":
            continue

        # поле длины строки — первое, после которого читается путь
        for probe in range(blob_start + 4, blob_start + 12):
            (n,) = struct.unpack_from(">I", data, probe)
            if not (0 < n < 1000) or probe + 4 + n * 2 > len(data):
                continue
            try:
                txt = data[probe + 4: probe + 4 + n * 2].decode("utf-16-be")
            except UnicodeDecodeError:
                continue
            if "\\" not in txt and "/" not in txt:
                continue
            out.append({
                "blob_len_off": blob_len_off,
                "blob_len": blob_len,
                "blob_start": blob_start,
                "str_len_off": probe,
                "text_off": probe + 4,
                "text_end": probe + 4 + n * 2,
                "raw": txt,
                "path": txt.replace("\x00", ""),
            })
            break
    return out


def set_layout(data):
    """-> (имя набора, смещение счётчика, [[начало, конец, имя], …])"""
    (version,) = struct.unpack_from(">I", data, 0)
    if version != 16:
        raise ValueError(f"ожидался .atn версии 16, получено {version}")

    set_name, off = read_ustring(data, 4)
    off += 1                                  # развёрнут ли набор
    count_off = off
    (count,) = struct.unpack_from(">I", data, off)

    acts = []
    pos = count_off + 4
    for _ in range(count):
        name, after = read_ustring(data, pos + 6)
        end = _next_action(data, after)
        acts.append([pos, end, name])
        pos = end
    return set_name, count_off, acts


def _next_action(data, search_from):
    """Начало следующей операции либо конец файла."""
    i = search_from
    while i + 10 <= len(data):
        (n,) = struct.unpack_from(">I", data, i + 6)
        if 1 <= n <= 60 and i + 10 + n * 2 <= len(data):
            try:
                txt = data[i + 10: i + 10 + n * 2].decode("utf-16-be")
            except UnicodeDecodeError:
                i += 1
                continue
            body = txt.replace("\x00", "")
            if body and all(ch.isprintable() for ch in body) \
                    and data[i + 2] in (0, 1) and data[i + 3] in (0, 1):
                return i
        i += 1
    return len(data)


def layout_is_sound(data):
    """Операции вплотную покрывают файл от заголовка до конца?"""
    try:
        _name, count_off, acts = set_layout(data)
    except (ValueError, struct.error, UnicodeDecodeError):
        return False
    if not acts or acts[0][0] != count_off + 4:
        return False
    for i in range(len(acts) - 1):
        if acts[i][1] != acts[i + 1][0]:
            return False
    return acts[-1][1] == len(data)


# ---------------------------------------------------------------- правка

def splice_paths(data, mapper):
    """mapper(путь) -> новый путь либо None. -> (байты, [(было, стало)])"""
    out = bytearray()
    cursor = 0
    changed = []

    for e in script_entries(data):
        raw = e["raw"]
        lead = raw[:len(raw) - len(raw.lstrip("\x00"))]
        clean = e["path"]

        new_clean = mapper(clean)
        if new_clean is None:
            continue        # этот путь не трогаем

        new_raw = lead + new_clean
        new_bytes = new_raw.encode("utf-16-be")
        delta = len(new_bytes) - (e["text_end"] - e["text_off"])

        out += data[cursor:e["blob_len_off"]]
        out += struct.pack(">I", e["blob_len"] + delta)
        out += data[e["blob_start"]:e["str_len_off"]]
        out += struct.pack(">I", len(new_raw))
        out += new_bytes
        cursor = e["text_end"]
        if new_clean != clean:
            changed.append((clean, new_clean))

    out += data[cursor:]
    return bytes(out), changed


def file_name(path):
    return path.replace("/", "\\").split("\\")[-1]


def rewrite_paths(data, renames):
    """renames: {старое имя файла: новое}"""
    def mapper(path):
        name = file_name(path)
        if name not in renames:
            return None
        return path[:len(path) - len(name)] + renames[name]
    return splice_paths(data, mapper)


def repath(data, new_dir):
    """Сменить папку у всех путей, имена файлов сохранить."""
    sep = "\\" if "\\" in new_dir or ":" in new_dir else "/"
    base = new_dir.rstrip("\\/")

    def mapper(path):
        return base + sep + file_name(path)
    return splice_paths(data, mapper)


def identity_holds(data):
    """Холостая правка обязана дать побайтово тот же файл."""
    rebuilt, _ = splice_paths(data, lambda p: p)
    return rebuilt == data


def remove_action(data, victim):
    _name, count_off, acts = set_layout(data)
    (count,) = struct.unpack_from(">I", data, count_off)
    for start, end, name in acts:
        if name == victim:
            out = bytearray(data[:count_off])
            out += struct.pack(">I", count - 1)
            out += data[count_off + 4:start]
            out += data[end:]
            return bytes(out)
    raise KeyError(victim)


# ------------------------------------------------------------- команды

def cmd_list(args):
    data = open(args.file, "rb").read()
    set_name, count_off, acts = set_layout(data)
    (count,) = struct.unpack_from(">I", data, count_off)

    print(f"{os.path.basename(args.file)} — набор {set_name!r}, операций {count}")
    entries = script_entries(data)

    for start, end, name in acts:
        mine = [e for e in entries if start <= e["str_len_off"] < end]
        print(f"   {name}")
        for e in mine:
            print(f"      -> {e['path']}")
    if not entries:
        print("   шагов запуска скриптов нет")

    print(f"   разметка сходится: {layout_is_sound(data)}")
    print(f"   холостая правка воспроизводит файл: {identity_holds(data)}")
    return 0


def cmd_check(args):
    data = open(args.file, "rb").read()
    bad = 0
    for e in script_entries(data):
        ok = os.path.exists(e["path"])
        print(("   OK   " if ok else "   НЕТ  ") + e["path"])
        bad += 0 if ok else 1
    print("битых ссылок:", bad)
    return 1 if bad else 0


def cmd_rewrite(args):
    data = open(args.file, "rb").read()
    if not identity_holds(data):
        print("разбор не сошёлся — правка отменена", file=sys.stderr)
        return 1

    renames = {}
    for pair in args.renames:
        old, _, new = pair.partition("=")
        if not old or not new:
            print(f"ожидался вид old.jsx=new.jsx, получено {pair!r}", file=sys.stderr)
            return 1
        renames[old] = new

    new_data, changed = rewrite_paths(data, renames)
    if not changed:
        print("ни одно имя не совпало — файл не записан")
        return 1

    open(args.out, "wb").write(new_data)
    for a, b in changed:
        print(f"   {a}  ->  {b}")
    print(f"{len(data)} -> {len(new_data)} байт, записано: {args.out}")
    return 0


def cmd_repath(args):
    data = open(args.file, "rb").read()
    if not identity_holds(data):
        print("разбор не сошёлся — правка отменена", file=sys.stderr)
        return 1

    new_data, changed = repath(data, args.dir)
    if not changed:
        print("пути уже указывают на эту папку — файл не записан")
        return 0

    open(args.out, "wb").write(new_data)
    for a, b in changed:
        print(f"   {a}\n   -> {b}")
    print(f"{len(data)} -> {len(new_data)} байт, записано: {args.out}")
    return 0


def cmd_remove(args):
    data = open(args.file, "rb").read()
    if not layout_is_sound(data):
        print("разметка не сошлась — правка отменена", file=sys.stderr)
        return 1
    try:
        new_data = remove_action(data, args.action)
    except KeyError:
        print(f"операция {args.action!r} не найдена", file=sys.stderr)
        return 1
    if not layout_is_sound(new_data):
        print("результат не сошёлся — файл не записан", file=sys.stderr)
        return 1

    open(args.out, "wb").write(new_data)
    print(f"удалена операция {args.action!r}")
    print(f"{len(data)} -> {len(new_data)} байт, записано: {args.out}")
    return 0


def main():
    ap = argparse.ArgumentParser(
        description="Чтение и правка наборов операций Photoshop (.atn)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="показать операции и пути к скриптам")
    p.add_argument("file")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("check", help="проверить существование файлов по путям")
    p.add_argument("file")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("rewrite", help="заменить имена .jsx в путях")
    p.add_argument("file")
    p.add_argument("out")
    p.add_argument("renames", nargs="+", metavar="old.jsx=new.jsx")
    p.set_defaults(func=cmd_rewrite)

    p = sub.add_parser("repath", help="сменить папку у всех путей к скриптам")
    p.add_argument("file")
    p.add_argument("out")
    p.add_argument("dir", metavar="НОВАЯ_ПАПКА")
    p.set_defaults(func=cmd_repath)

    p = sub.add_parser("remove", help="удалить операцию из набора")
    p.add_argument("file")
    p.add_argument("out")
    p.add_argument("action")
    p.set_defaults(func=cmd_remove)

    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
