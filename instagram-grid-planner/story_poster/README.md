# Щоденні історії Instagram через Buffer

Скрипт бере фото з теки, завантажує кожне на Cloudinary (Buffer приймає лише публічне посилання), створює заплановану історію через Buffer API і підтримує чергу на DAYS_AHEAD днів уперед. Лише стандартна бібліотека Python 3.9+, `pip` не потрібен.

## Локальний запуск (перевірка)
1. Скопіювати `.env.example` у `.env`, заповнити `BUFFER_API_KEY` (Buffer, Settings, API), `CLOUDINARY_API_KEY` і `CLOUDINARY_API_SECRET` (Cloudinary, Settings, API Keys). `.env` нікому не показувати.
2. `python story_poster.py --dry-run` показує план без мережі. `python story_poster.py` робить справжній запуск.
3. Для першої перевірки поставити `DAYS_AHEAD=1` і мати в теці 1–2 фото.

## Що робить
- Нове фото з кореня теки: копія на Cloudinary під випадковою назвою, історія в Buffer на найближчий вільний слот (POST_TIME, TIMEZONE), файл переходить у `scheduled/`.
- Через годину після часу історії: копія з Cloudinary видаляється, файл переходить у `posted/`.
- Під час помилки запуск зупиняється, файл лишається на місці, осиротілої публічної копії немає.
- Порядок за назвою файлу (1, 2, 10 розпізнаються як числа). Формати jpg, jpeg, png, до 8 МБ.

## Docker на NAS (NAS у інтернет не відкривається)
Контейнер лише сам звертається до Buffer і Cloudinary, порти не відкриваються.

Розкладка на NAS (по SMB це `\\aperion\docker\Stories\`):
```
/volume1/docker/Stories/
├── compose.yaml          ← з nas/compose.yaml
├── stories.env           ← з nas/stories.env.example, заповнений ключами
├── app/story_poster.py   ← скрипт
└── data/stories/         ← сюди кидати фото
```
Кроки: File Station, створити теки, скопіювати файли; Container Manager, Проект, Створити, шлях `/volume1/docker/Stories`, використати наявний `compose.yaml`; Виконано.

Оновлення скрипта: замінити `app/story_poster.py` і **перезапустити контейнер** (Python читає код лише під час старту). Журнал: Container Manager, Контейнер, stories-poster, Журнал.

Фото з комп'ютера: теку `data\stories` підключити як мережевий диск або синхронізувати Synology Drive. Теку `/volume1/docker/Stories` додати в Hyper Backup.

## Журнал помилок і база даних

- `data\app.db` (SQLite): таблиці `events` (журнал: info, warning, error з деталями й traceback), `stories` і `posts` (історія черг і публікацій), `schedule_changes` (зміни розкладу), `feed_meta_changes` (що сховано зі стрічки), `planner_snapshots` (останні 10 збережених стрічок разом з фото). Журнал обмежено 5000 записами. При першому запуску база наповнюється тим, що вже є (черги, історія, налаштування, збережена стрічка).
- `data\logs\app.log`: той самий журнал текстом, ротація 1 МБ × 5 файлів. Те саме видно в журналі контейнера.
- Перегляд у браузері: `http://aperion:8095/api/log?level=error&limit=50` (останні події; без `level` усі) і `http://aperion:8095/api/db` (скільки чого в базі).
- Відкрити базу вручну: DB Browser for SQLite, файл `\aperion\docker\Stories\data\app.db` (копію, поки контейнер працює).
- Помилки не ламають роботу: запис у базу або файл журналу, що не вдався, лише друкується в журнал контейнера.
