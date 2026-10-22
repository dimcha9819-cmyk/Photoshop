/*
 * RAW-to-PSD.jsx
 *
 * Работает ВСЕГДА по папке, открытые документы значения не имеют:
 * скрипт спрашивает папку с RAW, показывает, сколько файлов найдено и
 * сколько отобрано по оценке, и после подтверждения прогоняет только
 * отобранные.
 *
 * Режим «по одному открытому документу» нужен только дроплету и по
 * умолчанию выключен — см. ALLOW_DOCUMENT_MODE.
 *
 * Отбор по оценке (FILTER_BY_RATING):
 *   Проходят только снимки с оценкой из ACCEPT_RATINGS — по умолчанию
 *   ровно одна звезда из пяти.
 *
 *   Оценка читается БЕЗ открытия файла, по очереди:
 *     1. файл-спутник «имя.xmp» рядом с RAW — так пишут Bridge и
 *        Lightroom при сохранении метаданных, это главный источник;
 *     2. XMP уже открытого документа (только в режиме дроплета);
 *     3. XMP-пакет внутри самого файла — часто хранит камерный ноль,
 *        поэтому идёт последним.
 *
 * Куда сохранять — определяется по папке с исходниками:
 *
 *   1. Папка называется «3. RAW TO EDIT» → PSD уходит в соседнюю папку
 *      уровнем выше, «2. PSD»:
 *          D:\Photo\26_09_20_HalyRed\3. RAW TO EDIT
 *       →  D:\Photo\26_09_20_HalyRed\2. PSD
 *      Если такой папки нет, она создаётся (CREATE_DST).
 *
 *   2. Папка называется иначе → запасной вариант FALLBACK:
 *      "ask"  — спросить папку (в пачке вопрос не повторяется);
 *      "near" — положить PSD рядом с оригиналом.
 *
 * Имя файла сохраняется один в один. Что делать с уже существующим PSD,
 * задаёт ON_EXISTING: сохранить копией _1 (по умолчанию), пропустить или
 * перезаписать. Сводка перед запуском показывает, сколько таких файлов.
 *
 * Photoshop: Файл > Сценарии > Обзор…  (или положить в Presets\Scripts)
 * В дроплете: Место назначения → Нет, скрипт сохраняет и закрывает сам.
 */
#target photoshop
app.bringToFront();

// ============================== НАСТРОЙКИ ==============================

// --- отбор по оценке ---

// Включить фильтр. false = обрабатывать всё подряд.
var FILTER_BY_RATING = true;

// Какие оценки отмечены в окне при открытии. [1] — ровно одна звезда.
// Примеры: [4, 5] — четыре и пять; [-1] — только «отклонённые».
// Разбираются всегда ВСЕ оценки от 0 до 5: окно показывает, сколько
// снимков в каждой категории, и выбор там перекрывает эту настройку.
var ACCEPT_RATINGS = [1];

// Что делать, когда оценку найти не удалось:
//   "skip" — пропустить файл
//   "save" — обработать всё равно
var ON_UNKNOWN = "skip";

// Сколько байт от начала файла просматривать в поисках встроенного XMP.
var EMBEDDED_SCAN_BYTES = 1048576;

// --- режим по папке ---

// Отдавать открытый документ режиму дроплета вместо обхода папки.
// false (по умолчанию) — скрипт всегда спрашивает папку, даже когда
// в Photoshop что-то открыто. true нужен только дроплету, где документ
// открывает он сам.
var ALLOW_DOCUMENT_MODE = false;

// Расширения, которые считаем исходниками.
var RAW_EXT = ["cr3", "cr2", "nef", "arw", "dng", "raf", "orf", "rw2",
               "pef", "srw", "rwl", "sr2", "srf", "mrw", "nrw", "erf",
               "dcr", "kdc", "3fr", "iiq", "x3f", "tif", "tiff", "jpg", "jpeg"];

// Параметры открытия через Camera Raw. Перекрывают то, что стоит
// в «Параметрах рабочего процесса» самого Camera Raw.
var ACR_BITS       = BitsPerChannelType.SIXTEEN;   // EIGHT | SIXTEEN
var ACR_COLORSPACE = ColorSpaceType.ADOBERGB;      // SRGB | ADOBERGB | PROPHOTORGB | COLORMATCHRGB
var ACR_RESOLUTION = 300;                          // ppi

// Показывать полосу выполнения на время пачки.
var SHOW_PROGRESS = true;

// --- маршрут сохранения ---

// Имя папки-источника, которое включает автоматический маршрут.
// Регистр и лишние пробелы по краям не важны.
var SRC_FOLDER_NAME = "3. RAW TO EDIT";

// Имя папки назначения — рядом с источником, уровнем выше.
var DST_FOLDER_NAME = "2. PSD";

// Создавать папку назначения, если её ещё нет.
var CREATE_DST = true;

// Что делать, если PSD с таким именем в папке назначения уже есть:
//   "copy"      — сохранить рядом как имя_1.psd, имя_2.psd (оригинал цел)
//   "skip"      — не трогать и не открывать файл; удобно докатывать
//                 прерванную пачку, повторы не плодятся
//   "overwrite" — перезаписать существующий PSD. Отката нет.
// Это лишь значение по умолчанию: в окне перед запуском режим выбирается
// списком, и выбор перекрывает то, что стоит здесь.
var ON_EXISTING = "copy";

// Что делать, когда папка-источник называется иначе:
//   "ask"  — спросить путь диалогом
//   "near" — сохранять рядом с оригиналом
var FALLBACK = "ask";

// Запоминать выбранный путь, чтобы не спрашивать на каждом файле пачки.
// Память живёт до перезапуска Photoshop и заводится отдельно на каждую
// папку-источник.
var REMEMBER_CHOICE = true;

// =======================================================================

(function () {

    // ------------------------------------------------------------- хелперы

    function trimLower(s) {
        return String(s).replace(/^\s+|\s+$/g, "").toLowerCase();
    }

    function baseName(name) {
        return String(name).replace(/\.[^\.]+$/, "");
    }

    // Системный выбор папки.
    // Folder.selectDlg — метод экземпляра, у класса он не работает,
    // статический вариант называется selectDialog.
    function chooseFolder(prompt, preset) {
        try {
            return Folder.selectDialog(prompt, preset || Folder.myDocuments);
        } catch (e) {
            try {
                return (preset || Folder.myDocuments).selectDlg(prompt);
            } catch (e2) {
                return null;
            }
        }
    }

    // Выбранные пути переживают запуск скрипта: движок ExtendScript один
    // на весь сеанс Photoshop, поэтому пачка спрашивает путь один раз.
    function memory() {
        if (!$.global.RAW_TO_PSD_PATHS) { $.global.RAW_TO_PSD_PATHS = {}; }
        return $.global.RAW_TO_PSD_PATHS;
    }

    // ------------------------------------------------------------- оценка

    // Число из куска XMP: xmp:Rating="1" или <xmp:Rating>1</xmp:Rating>
    function ratingFromText(txt) {
        var m = txt.match(/xmp:Rating\s*=\s*"(-?\d+)"/);
        if (!m) { m = txt.match(/<xmp:Rating>\s*(-?\d+)\s*<\/xmp:Rating>/); }
        return m ? parseInt(m[1], 10) : null;
    }

    // Прочитать начало файла как текст
    function head(file, bytes) {
        var txt = null;
        try {
            file.encoding = "BINARY";
            if (!file.open("r")) { return null; }
            txt = file.read(bytes);
        } catch (e) {
            txt = null;
        }
        try { file.close(); } catch (e2) {}
        return txt;
    }

    // 1. Файл-спутник имя.xmp рядом с RAW — главный источник правды
    function ratingFromSidecar(folder, base) {
        if (!folder) { return null; }
        var f = new File(folder.fsName + "/" + base + ".xmp");
        if (!f.exists) { return null; }
        var txt = head(f, EMBEDDED_SCAN_BYTES);
        return txt ? ratingFromText(txt) : null;
    }

    // 2. XMP открытого документа
    function ratingFromDoc(d) {
        try {
            var raw = d.xmpMetadata.rawData;
            return raw ? ratingFromText(String(raw)) : null;
        } catch (e) {
            return null;
        }
    }

    // 3. XMP-пакет внутри самого файла — обычно камерный ноль
    function ratingFromEmbedded(folder, name) {
        if (!folder) { return null; }
        var f = new File(folder.fsName + "/" + name);
        if (!f.exists) { return null; }
        var txt = head(f, EMBEDDED_SCAN_BYTES);
        return txt ? ratingFromText(txt) : null;
    }

    // Оценка файла на диске, без открытия
    function ratingOfFile(file) {
        var name = decodeURI(file.name);
        var r = ratingFromSidecar(file.parent, baseName(name));
        if (r === null) { r = ratingFromEmbedded(file.parent, name); }
        return r;
    }

    function accepted(rating) {
        if (!FILTER_BY_RATING) { return true; }
        if (rating === null) { return ON_UNKNOWN === "save"; }
        for (var r = 0; r < ACCEPT_RATINGS.length; r++) {
            if (ACCEPT_RATINGS[r] === rating) { return true; }
        }
        return false;
    }

    // ------------------------------------------------------------- маршрут

    function resolveOutFolder(src) {

        // 1. Автоматический маршрут: <...>/3. RAW TO EDIT -> <...>/2. PSD
        if (src && trimLower(decodeURI(src.name)) === trimLower(SRC_FOLDER_NAME)) {
            var parent = src.parent;
            if (parent) {
                var dst = new Folder(parent.fsName + "/" + DST_FOLDER_NAME);
                if (!dst.exists && CREATE_DST) { dst.create(); }
                if (dst.exists) { return dst; }
                // папку создать не удалось — уходим в запасной вариант
            }
        }

        // 2. Запасной вариант
        var key = src ? src.fsName : "<без файла>";
        var mem = memory();

        if (REMEMBER_CHOICE && mem[key]) {
            var kept = new Folder(mem[key]);
            if (kept.exists) { return kept; }
        }

        var near = src ? src : Folder.desktop;

        if (FALLBACK !== "ask") { return near; }

        var picked = chooseFolder("Куда сохранять PSD из папки «" +
                                  (src ? decodeURI(src.name) : "—") + "»?", near);

        // отмена — сохраняем рядом с оригиналом, чтобы пачка не встала
        var out = (picked && picked.exists) ? picked : near;

        if (REMEMBER_CHOICE) { mem[key] = out.fsName; }
        return out;
    }

    // ----------------------------------------------------------- сохранение

    function saveOptions() {
        var opts = new PhotoshopSaveOptions();
        opts.alphaChannels       = true;
        opts.annotations         = true;
        opts.embedColorProfile   = true;
        opts.layers              = true;
        opts.spotColors          = true;
        opts.maximizeCompatibility = true;   // снимает диалог совместимости
        return opts;
    }

    // Путь будущего PSD без учёта занятости
    function plainTarget(dirFsName, base) {
        // Платформенный путь, а не URI-форма: имя с % или # иначе будет
        // разобрано как escape-последовательность и уедет не туда.
        return new File(dirFsName + "/" + base + ".psd");
    }

    // Куда писать с учётом ON_EXISTING. null = файл пропускаем.
    function targetFor(dirFsName, base) {
        var plain = plainTarget(dirFsName, base);
        if (!plain.exists)            { return plain; }
        if (ON_EXISTING === "overwrite") { return plain; }
        if (ON_EXISTING === "skip")      { return null; }

        var t, i = 1;
        do {
            t = new File(dirFsName + "/" + base + "_" + i + ".psd");
            i++;
        } while (t.exists);
        return t;
    }

    function savePsdAndClose(doc, outFolder) {
        var target = targetFor(outFolder.fsName, baseName(doc.name));
        if (target === null) {
            doc.close(SaveOptions.DONOTSAVECHANGES);
            return null;
        }
        doc.saveAs(target, saveOptions(), false, Extension.LOWERCASE);
        doc.close(SaveOptions.DONOTSAVECHANGES);
        return target;
    }

    // --------------------------------------------------------- режим папки

    function collectRaw(folder) {
        var all = folder.getFiles();
        var out = [];
        for (var i = 0; i < all.length; i++) {
            var f = all[i];
            if (!(f instanceof File)) { continue; }
            var m = decodeURI(f.name).match(/\.([^\.]+)$/);
            if (!m) { continue; }
            var ext = m[1].toLowerCase();
            for (var e = 0; e < RAW_EXT.length; e++) {
                if (RAW_EXT[e] === ext) { out.push(f); break; }
            }
        }
        out.sort(function (a, b) {
            var an = decodeURI(a.name).toLowerCase();
            var bn = decodeURI(b.name).toLowerCase();
            return (an < bn) ? -1 : (an > bn) ? 1 : 0;
        });
        return out;
    }

    // Ключ оценки: "-1" … "5" либо "?" для снимков без оценки
    function ratingKey(r) {
        return (r === null) ? "?" : String(r);
    }

    function ratingLabel(key) {
        if (key === "?")  { return "без оценки"; }
        if (key === "-1") { return "откл."; }
        return key + " зв.";
    }

    // Разбирается вся папка целиком: оценка каждого файла и общая раскладка.
    // Файлы не открываются — только чтение XMP с диска.
    function scanRatings(files) {
        var items = [];
        var hist = {};
        for (var i = 0; i < files.length; i++) {
            var r = ratingOfFile(files[i]);
            var key = ratingKey(r);
            hist[key] = (hist[key] || 0) + 1;
            items.push({ file: files[i], key: key, exists: false });
        }
        return { items: items, hist: hist };
    }

    // Ключи в порядке показа: откл., 0…5, затем «без оценки»
    function ratingKeys(hist) {
        var keys = [];
        var k;

        if (hist["-1"]) { keys.push("-1"); }
        for (var v = 0; v <= 5; v++) {
            k = String(v);
            keys.push(k);
        }
        // оценки крупнее пятёрки встречаться не должны, но если есть — покажем
        for (k in hist) {
            if (!hist.hasOwnProperty(k) || k === "?" || k === "-1") { continue; }
            if (parseInt(k, 10) > 5) { keys.push(k); }
        }
        if (hist["?"]) { keys.push("?"); }
        return keys;
    }

    // Какие оценки отмечены при открытии окна — по настройкам из файла
    function initialTick(key) {
        if (!FILTER_BY_RATING) { return true; }
        if (key === "?")       { return ON_UNKNOWN === "save"; }
        for (var i = 0; i < ACCEPT_RATINGS.length; i++) {
            if (String(ACCEPT_RATINGS[i]) === key) { return true; }
        }
        return false;
    }

    // Пометить, у каких снимков PSD в папке назначения уже есть
    function markExisting(items, out) {
        for (var i = 0; i < items.length; i++) {
            items[i].exists = plainTarget(
                out.fsName, baseName(decodeURI(items[i].file.name))).exists;
        }
    }

    // Сводка перед запуском.
    // Возвращает null при отмене либо { picked: [File…], mode: "copy|skip|overwrite" }
    function confirmDialog(src, out, total, scan) {

        var dlg = new Window("dialog", "RAW → PSD");
        dlg.orientation = "column";
        dlg.alignChildren = "fill";
        dlg.margins = 16;
        dlg.spacing = 8;

        function row(label, value) {
            var g = dlg.add("group");
            g.alignChildren = "top";
            var l = g.add("statictext", undefined, label);
            l.preferredSize.width = 150;
            var v = g.add("statictext", undefined, value, { multiline: true });
            v.preferredSize.width = 380;
            return v;
        }

        row("Папка с исходниками:", src.fsName);
        row("Всего файлов:", String(total));

        // --- какие оценки конвертировать ---
        // Разобраны всегда все оценки; здесь выбирается, какие брать в работу
        var pnl = dlg.add("panel", undefined, "Конвертировать оценки");
        pnl.orientation = "column";
        pnl.alignChildren = "left";
        pnl.margins = [12, 16, 12, 12];
        pnl.spacing = 6;

        var gAll = pnl.add("group");
        var cbAll = gAll.add("checkbox", undefined, "Все");

        var gBoxes = pnl.add("group");
        gBoxes.spacing = 12;

        var keys = ratingKeys(scan.hist);
        var boxes = [];

        for (var bi = 0; bi < keys.length; bi++) {
            var key = keys[bi];
            var n = scan.hist[key] || 0;
            var cb = gBoxes.add("checkbox", undefined, ratingLabel(key) + " (" + n + ")");
            cb.enabled = (n > 0);
            cb.value = (n > 0) && initialTick(key);
            boxes.push({ key: key, cb: cb });
        }

        var outRow  = row("Отобрано для конвертации:", "0");
        row("Сохранять в:", out.fsName);

        // --- что делать с уже готовыми PSD ---
        var gEx = dlg.add("group");
        gEx.alignChildren = "center";
        var lEx = gEx.add("statictext", undefined, "Уже есть в назначении:");
        lEx.preferredSize.width = 150;
        var nEx = gEx.add("statictext", undefined, "0");
        nEx.preferredSize.width = 30;

        var dd = gEx.add("dropdownlist", undefined, [
            "Сохранить копиями _1, _2",
            "Пропустить уже готовые",
            "Перезаписать"
        ]);
        dd.preferredSize.width = 240;
        dd.selection = (ON_EXISTING === "skip") ? 1 : (ON_EXISTING === "overwrite") ? 2 : 0;

        function chosenMode() {
            return ["copy", "skip", "overwrite"][dd.selection.index];
        }

        var note = dlg.add("statictext", undefined, "", { multiline: true });
        note.preferredSize.width = 530;
        note.preferredSize.height = 42;

        var btns = dlg.add("group");
        btns.alignment = "right";
        btns.add("button", undefined, "Отмена", { name: "cancel" });
        var ok = btns.add("button", undefined, "Конвертировать", { name: "ok" });

        // отмеченные оценки
        function selectedKeys() {
            var out2 = {};
            for (var i = 0; i < boxes.length; i++) {
                if (boxes[i].cb.enabled && boxes[i].cb.value) { out2[boxes[i].key] = true; }
            }
            return out2;
        }

        function pickedItems() {
            var sel = selectedKeys();
            var res = [];
            for (var i = 0; i < scan.items.length; i++) {
                if (sel[scan.items[i].key]) { res.push(scan.items[i]); }
            }
            return res;
        }

        function refresh() {
            var picked = pickedItems();
            var existing = 0;
            for (var i = 0; i < picked.length; i++) { if (picked[i].exists) { existing++; } }

            // «Все» отражает состояние остальных, не управляя ими из этого места
            var every = true, any = false;
            for (i = 0; i < boxes.length; i++) {
                if (!boxes[i].cb.enabled) { continue; }
                any = true;
                if (!boxes[i].cb.value) { every = false; }
            }
            cbAll.value = any && every;

            var names = [];
            var sel = selectedKeys();
            for (i = 0; i < keys.length; i++) {
                if (sel[keys[i]]) { names.push(ratingLabel(keys[i])); }
            }

            outRow.text = picked.length +
                          (names.length ? "   (" + names.join(", ") + ")" : "   (ничего не выбрано)");
            nEx.text = String(existing);
            dd.enabled = (existing > 0);

            var mode = chosenMode();
            var nothing = (mode === "skip" && existing > 0 && existing >= picked.length);
            ok.enabled = (picked.length > 0) && !nothing;

            if (picked.length === 0) {
                note.text = "Выберите хотя бы одну оценку. Если звёзд нет совсем — " +
                            "проверьте, что рядом с RAW лежат .xmp: Lightroom пишет их " +
                            "только по команде «Метаданные → Сохранить метаданные в файл».";
            } else if (nothing) {
                note.text = "Все отобранные файлы уже сконвертированы — " +
                            "конвертировать нечего.";
            } else if (existing > 0 && mode === "overwrite") {
                note.text = "Внимание: " + existing +
                            " существующих PSD будут перезаписаны. Отката нет.";
            } else if (existing > 0 && mode === "skip") {
                note.text = "Будет открыто и обработано: " + (picked.length - existing) +
                            " из " + picked.length + ". Остальные пропускаются без открытия.";
            } else if (existing > 0) {
                note.text = existing + " снимков лягут вторыми копиями — " +
                            "оригинальные PSD останутся нетронутыми.";
            } else {
                note.text = "";
            }
        }

        cbAll.onClick = function () {
            for (var i = 0; i < boxes.length; i++) {
                if (boxes[i].cb.enabled) { boxes[i].cb.value = cbAll.value; }
            }
            refresh();
        };

        for (bi = 0; bi < boxes.length; bi++) { boxes[bi].cb.onClick = refresh; }
        dd.onChange = refresh;
        refresh();

        if (dlg.show() !== 1) { return null; }

        var chosen = pickedItems();
        var files = [];
        for (var ci = 0; ci < chosen.length; ci++) { files.push(chosen[ci].file); }
        return { picked: files, mode: chosenMode() };
    }

    // Полоса выполнения
    function progressBar(total) {
        if (!SHOW_PROGRESS) { return null; }
        try {
            var w = new Window("palette", "RAW → PSD");
            w.orientation = "column";
            w.alignChildren = "fill";
            w.margins = 14;
            w.txt = w.add("statictext", undefined, "");
            w.txt.preferredSize.width = 360;
            w.bar = w.add("progressbar", undefined, 0, total);
            w.bar.preferredSize.width = 360;
            w.show();
            return w;
        } catch (e) {
            return null;
        }
    }

    function progressStep(w, i, total, name) {
        if (w === null) { return; }
        try {
            w.txt.text = i + " / " + total + "   " + name;
            w.bar.value = i;
            w.update();
        } catch (e) {}
    }

    // Открытие RAW через Camera Raw с настройками самого снимка
    function openRaw(file) {
        try {
            var o = new CameraRAWOpenOptions();
            o.settings       = CameraRAWSettingsType.SELECTEDIMAGE;
            o.bitsPerChannel = ACR_BITS;
            o.colorSpace     = ACR_COLORSPACE;
            o.resolution     = ACR_RESOLUTION;
            return app.open(file, o);
        } catch (e) {
            // не RAW (tif/jpg) либо версия не приняла параметры
            return app.open(file);
        }
    }

    function runFolderMode() {

        var src = chooseFolder("Папка с RAW-файлами:", null);
        if (!src) { return; }

        var files = collectRaw(src);
        if (files.length === 0) {
            alert("В папке нет подходящих файлов.\n\nИщем: " + RAW_EXT.join(", "));
            return;
        }

        var scan = scanRatings(files);
        var out  = resolveOutFolder(src);
        markExisting(scan.items, out);

        var answer = confirmDialog(src, out, files.length, scan);
        if (answer === null) { return; }
        ON_EXISTING = answer.mode;   // выбор в окне перекрывает настройку в файле

        var list = answer.picked;
        var prevDialogs = app.displayDialogs;
        app.displayDialogs = DialogModes.NO;

        var bar = progressBar(list.length);
        var done = 0;
        var passed = 0;
        var errors = [];

        for (var i = 0; i < list.length; i++) {
            var name = decodeURI(list[i].name);
            progressStep(bar, i + 1, list.length, name);

            // при "skip" существующий PSD отсекается до открытия RAW —
            // на докатке прерванной пачки это экономит минуты
            if (ON_EXISTING === "skip" &&
                plainTarget(out.fsName, baseName(name)).exists) {
                passed++;
                continue;
            }

            var doc = null;
            try {
                doc = openRaw(list[i]);
                if (savePsdAndClose(doc, out) === null) { passed++; } else { done++; }
            } catch (err) {
                errors.push(name + "  —  " + err);
                if (doc !== null) {
                    try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
                }
            }
        }

        if (bar !== null) { try { bar.close(); } catch (e3) {} }
        app.displayDialogs = prevDialogs;

        var msg = "Обработано: " + done + " из " + list.length +
                  "\nНе входило в выбранные оценки: " + (files.length - list.length);
        if (passed > 0) {
            msg += "\nПропущено, PSD уже был: " + passed;
        }
        msg += "\n\nРезультат: " + out.fsName;
        if (errors.length > 0) {
            msg += "\n\nНе удалось (" + errors.length + "):\n" + errors.join("\n");
        }
        alert(msg);
    }

    // ----------------------------------------------------- режим документа

    function runDocumentMode() {

        var doc = app.activeDocument;

        // Папка исходника; для документа, которого Photoshop ещё не знает, — null
        var srcFolder;
        try {
            srcFolder = doc.path;
        } catch (e) {
            srcFolder = null;
        }

        var base = baseName(doc.name);

        // Отбор идёт до выбора папки: отсеянный кадр не должен поднимать диалог
        if (FILTER_BY_RATING) {
            var rating = ratingFromSidecar(srcFolder, base);
            if (rating === null) { rating = ratingFromDoc(doc); }
            if (rating === null) { rating = ratingFromEmbedded(srcFolder, doc.name); }

            if (!accepted(rating)) {
                $.writeln("Пропущен: " + doc.name + " — оценка " +
                          (rating === null ? "не найдена" : rating));
                doc.close(SaveOptions.DONOTSAVECHANGES);
                return;
            }
        }

        savePsdAndClose(doc, resolveOutFolder(srcFolder));
    }

    // ---------------------------------------------------------------- пуск

    // По умолчанию — всегда папка, что бы ни было открыто в Photoshop.
    // Режим одного документа включается только флагом, для дроплета.
    if (ALLOW_DOCUMENT_MODE && app.documents.length > 0) {
        runDocumentMode();
    } else {
        runFolderMode();
    }

})();
