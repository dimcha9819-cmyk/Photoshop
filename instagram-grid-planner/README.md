# Instagram Grid Planner

Планувальник стрічки Instagram і автоматична публікація сторіс та постів через Buffer. Працює в Docker на домашньому NAS, лише стандартна бібліотека Python.

## Складники

| Файл | Призначення |
|---|---|
| `index.html` | сторінка «Стрічка»: сітка, перегляд на телефоні, пости з папок, архів |
| `story_poster/story_poster.py` | сторіс: фото з теки, Cloudinary, запланована історія в Buffer |
| `story_poster/post_poster.py` | пости з пронумерованих папок (фото і текстовий файл з підписом) |
| `story_poster/ui.py` | веб-сервер: календар, стрічка, історії, API |
| `story_poster/calendar_page.html`, `stories_page.html` | сторінки «Календар» і «Історії» |
| `story_poster/appdb.py` | журнал помилок і база SQLite |
| `story_poster/nas/compose.yaml` | проєкт для Container Manager |
| `story_poster/README.md` | розгортання на NAS |
| `scraper.py` | локальне читання стрічки за посиланням на профіль |

## Що не входить у репозиторій

Фото, `feed_crops/` (знімок власної стрічки), `stories.env` із ключами Buffer і Cloudinary, дані та резервні копії. Приклад налаштувань: `story_poster/nas/stories.env.example`.

Сторінка `index.html` очікує поруч `feed_crops/feed.js` (необов'язково, для кнопки відновлення з перегляду на телефоні). Без нього решта працює.
