#!/usr/bin/env python3
r"""setup.py — настроить наборы операций под эту машину.

Операция, запускающая скрипт, хранит внутри абсолютный путь к .jsx.
После клонирования репозитория на другую машину эти пути указывают в
пустоту. Скрипт переписывает их на вашу папку со скриптами и кладёт
готовые наборы в Action/Local — оттуда их и надо загружать в Photoshop.

Запуск
    python tools/setup.py
        Папка со скриптами — Scripts внутри репозитория. Годится, если
        вы просто скачали репозиторий и ничего никуда не копировали.

    python tools/setup.py "C:\Program Files\Adobe\Adobe Photoshop 2025\Presets\Scripts"
        Скрипты скопированы в Photoshop, чтобы попасть в меню
        Файл - Сценарии.

    python tools/setup.py "D:\Moi skripty" -o "D:\Gotovye naborы"
        Произвольные папки.

Что проверяется. Перед записью каждый набор прогоняется через холостую
правку: замена каждого пути на самого себя обязана дать побайтово тот же
файл. После правки проверяется, что все пути ведут к существующим .jsx.
Набор без единого шага запуска скрипта копируется как есть.
"""

import argparse
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import atn_tool


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_actions(action_dir):
    """Наборы верхнего уровня: Local и Old не трогаем."""
    out = []
    for name in sorted(os.listdir(action_dir)):
        full = os.path.join(action_dir, name)
        if os.path.isfile(full) and name.lower().endswith(".atn"):
            out.append(full)
    return out


def configure(src, scripts_dir, out_dir):
    """-> (имя, статус, [недостающие файлы])"""
    name = os.path.basename(src)
    dst = os.path.join(out_dir, name)
    data = open(src, "rb").read()

    if not atn_tool.identity_holds(data):
        return name, "разбор не сошёлся, пропущен", []

    entries = atn_tool.script_entries(data)
    if not entries:
        shutil.copyfile(src, dst)
        return name, "без скриптов, скопирован как есть", []

    new_data, changed = atn_tool.repath(data, scripts_dir)

    missing = []
    for e in atn_tool.script_entries(new_data):
        target = e["path"].replace("\\", os.sep).replace("/", os.sep)
        if not os.path.exists(target):
            missing.append(os.path.basename(e["path"].replace("\\", "/")))

    open(dst, "wb").write(new_data)
    status = f"настроен, путей: {len(entries)}"
    if not changed:
        status = f"пути уже верные, путей: {len(entries)}"
    return name, status, missing


def main():
    ap = argparse.ArgumentParser(
        description="Настроить .atn под путь к скриптам на этой машине")
    ap.add_argument("scripts_dir", nargs="?", default=None,
                    metavar="ПАПКА_СО_СКРИПТАМИ",
                    help="по умолчанию — Scripts внутри репозитория")
    ap.add_argument("-o", "--out", default=None, metavar="КУДА",
                    help="по умолчанию — Action/Local внутри репозитория")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    root = repo_root()
    scripts_dir = os.path.abspath(args.scripts_dir or os.path.join(root, "Scripts"))
    action_dir = os.path.join(root, "Action")
    out_dir = os.path.abspath(args.out or os.path.join(action_dir, "Local"))

    if not os.path.isdir(scripts_dir):
        print(f"Папка со скриптами не найдена:\n  {scripts_dir}", file=sys.stderr)
        return 1
    if not os.path.isdir(action_dir):
        print(f"Папка с наборами не найдена:\n  {action_dir}", file=sys.stderr)
        return 1

    jsx = [f for f in os.listdir(scripts_dir) if f.lower().endswith(".jsx")]
    if not jsx:
        print(f"В папке нет ни одного .jsx:\n  {scripts_dir}", file=sys.stderr)
        return 1

    os.makedirs(out_dir, exist_ok=True)

    print(f"Скрипты:  {scripts_dir}   ({len(jsx)} шт.)")
    print(f"Наборы:   {action_dir}")
    print(f"Результат:{out_dir}")
    print()

    actions = find_actions(action_dir)
    if not actions:
        print("Наборов .atn не найдено.", file=sys.stderr)
        return 1

    problems = 0
    for src in actions:
        name, status, missing = configure(src, scripts_dir, out_dir)
        print(f"  {name}")
        print(f"     {status}")
        for m in missing:
            print(f"     НЕТ ФАЙЛА: {m}")
            problems += 1

    print()
    if problems:
        print(f"Не найдено скриптов: {problems}. Проверьте папку со скриптами.")
        return 1

    print("Готово. В Photoshop: палитра Операции - Загрузить операции,")
    print(f"выбрать файлы из {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
