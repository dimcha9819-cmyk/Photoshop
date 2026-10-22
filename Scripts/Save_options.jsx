/*
    Save_options.jsx
    ------------------------------------------------------------------
    Сохранение копии с выбором в окне:
      • куда — рядом с PSD или в "1. JPG EDITED" уровнем выше;
      • формат — JPG (8 бит) или TIFF (глубина документа, без потерь);
      • белая обводка по краю кадра (аналог экшена WhiteStroke);
      • качество JPEG;
      • что делать, если файл уже есть — копия _1, _2 или перезапись.

    Собирает в себе всё, что умели Save_2_JpgEdited и Save_3_Options.
    Для быстрого сохранения рядом с PSD без вопросов есть
    Save_near_PSD.jsx.

    Если документ ещё не сохранён на диск, скрипт сначала спрашивает
    папку и кладёт туда PSD.

    Исходный документ не изменяется: работа идёт на временной копии.
    Глубина мастера сохраняется, в 8 бит уходит только копия для JPG —
    иной глубины формат JPEG не знает.
    ------------------------------------------------------------------
*/

#target photoshop

// ===================== НАСТРОЙКИ =====================
var SRC_FOLDER   = '2. PSD';
var DST_FOLDER   = '1. JPG EDITED';

// Что делать, если PSD лежит НЕ в папке "2. PSD":
//   'up'   — всё равно писать в "1. JPG EDITED" уровнем выше
//   'here' — создать "1. JPG EDITED" внутри текущей папки
//   'stop' — прервать работу с сообщением
var FALLBACK     = 'here';

// Толщина белой рамки:
//   'percent' — доля от короткой стороны кадра (масштабируется под любой размер)
//   'px'      — фиксированное число пикселей
var STROKE_MODE    = 'percent';
var STROKE_PERCENT = 7.15;          // 7.15 % ≈ 208 px на кадре 2912 px — как в WhiteStroke
var STROKE_PX      = 208;

// Сжатие TIFF: 'zip' | 'lzw' | 'none'.
// Для 16 бит zip плотнее и быстрее lzw.
var TIFF_COMPRESSION = 'zip';

// Что предложено при открытии окна
var DEFAULT_TARGET  = 'near';       // 'near' | 'up'
var DEFAULT_FORMAT  = 'jpg';        // 'jpg' | 'tif'
var DEFAULT_STROKE  = false;
var DEFAULT_QUALITY = 12;           // 1..12
var DEFAULT_OVERWRITE = false;      // false — дописывать _1, _2
// =====================================================

// ---------- общие функции ----------

function getFolder(doc) {
    try { return doc.path; } catch (e) { return null; }
}

function baseName(doc) {
    return doc.name.replace(/\.[^\.]+$/, "");
}

function bitsLabel(doc) {
    if (doc.bitsPerChannel == BitsPerChannelType.SIXTEEN)   { return "16 бит"; }
    if (doc.bitsPerChannel == BitsPerChannelType.THIRTYTWO) { return "32 бит"; }
    return "8 бит";
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

// Имя без перезаписи: file.jpg -> file_1.jpg -> file_2.jpg ...
// dir — платформенный путь (fsName), а не URI-форма: имя с % или #
// иначе будет разобрано как escape-последовательность и уедет не туда.
function uniqueFile(dir, name, ext) {
    var f = new File(dir + "/" + name + "." + ext);
    var i = 1;
    while (f.exists) {
        f = new File(dir + "/" + name + "_" + i + "." + ext);
        i++;
    }
    return f;
}

// Сохранить ещё не сохранённый документ как PSD. Глубина и слои
// сохраняются как есть: PhotoshopSaveOptions ничего не конвертирует.
function savePsdFirst(doc) {

    var folder = chooseFolder("Документ не сохранён. Куда положить PSD?", null);
    if (folder === null) { return null; }

    var file = uniqueFile(folder.fsName, baseName(doc), "psd");

    var opt = new PhotoshopSaveOptions();
    opt.alphaChannels         = true;
    opt.annotations           = true;
    opt.embedColorProfile     = true;
    opt.layers                = true;
    opt.spotColors            = true;
    opt.maximizeCompatibility = true;   // снимает диалог совместимости

    doc.saveAs(file, opt, false, Extension.LOWERCASE);
    return folder;
}

// Белая внутренняя рамка (аналог экшена WhiteStroke)
function addWhiteStroke(doc) {
    var oldUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;
    try {
        var W = doc.width.as('px');
        var H = doc.height.as('px');

        var w;
        if (STROKE_MODE === 'px') {
            w = STROKE_PX;
        } else {
            w = Math.round(Math.min(W, H) * STROKE_PERCENT / 100);
        }
        if (w < 1) { return; }
        if (w * 2 >= Math.min(W, H)) { w = Math.floor(Math.min(W, H) / 2) - 1; }

        var white = new SolidColor();
        white.rgb.red = 255; white.rgb.green = 255; white.rgb.blue = 255;

        doc.artLayers.add();
        doc.selection.select([[0, 0], [W, 0], [W, H], [0, H]]);
        doc.selection.select([[w, w], [W - w, w], [W - w, H - w], [w, H - w]],
                             SelectionType.DIMINISH);
        doc.selection.fill(white);
        doc.selection.deselect();
    } finally {
        app.preferences.rulerUnits = oldUnits;
    }
}

function tiffEncoding() {
    if (TIFF_COMPRESSION === 'none') { return TIFFEncoding.NONE; }
    if (TIFF_COMPRESSION === 'lzw')  { return TIFFEncoding.TIFFLZW; }
    return TIFFEncoding.TIFFZIP;
}

// Сохранение копии в JPG или TIFF. Оригинальный документ не изменяется.
function saveCopy(doc, targetFile, stroke, format, quality) {

    var dup = doc.duplicate(baseName(doc) + "_tmp_export", true);

    try {
        if (dup.mode == DocumentMode.BITMAP) { dup.changeMode(ChangeMode.GRAYSCALE); }
        if (dup.mode != DocumentMode.RGB &&
            dup.mode != DocumentMode.CMYK &&
            dup.mode != DocumentMode.GRAYSCALE) { dup.changeMode(ChangeMode.RGB); }

        if (stroke) { addWhiteStroke(dup); }

        dup.flatten();

        var opt;
        if (format === 'tif') {
            // Глубину не трогаем: 16 бит документа так и уходят в файл —
            // ради этого TIFF здесь и нужен.
            opt = new TiffSaveOptions();
            opt.imageCompression  = tiffEncoding();
            opt.layers            = false;
            opt.alphaChannels     = false;
            opt.embedColorProfile = true;
            opt.byteOrder         = ByteOrder.IBM;
        } else {
            // Перевод в 8 бит — последним шагом, уже по сведённой картинке.
            // Этого требует сам формат JPEG: другой глубины он не знает.
            // Мастер при этом остаётся в своей глубине — он даже не копия.
            if (dup.bitsPerChannel != BitsPerChannelType.EIGHT) {
                dup.bitsPerChannel = BitsPerChannelType.EIGHT;
            }
            opt = new JPEGSaveOptions();
            opt.quality           = quality;
            opt.embedColorProfile = true;
            opt.matte             = MatteType.NONE;
            opt.formatOptions     = FormatOptions.OPTIMIZEDBASELINE;
        }

        dup.saveAs(targetFile, opt, true, Extension.LOWERCASE);
    } finally {
        dup.close(SaveOptions.DONOTSAVECHANGES);
    }
}

function resolveTargetFolder(srcFolder) {

    var srcName = decodeURI(srcFolder.name);
    var inPsdFolder = (srcName.toLowerCase() === SRC_FOLDER.toLowerCase());

    var base;
    if (inPsdFolder || FALLBACK === 'up') {
        base = srcFolder.parent;
    } else if (FALLBACK === 'here') {
        base = srcFolder;
    } else {
        alert("PSD лежит не в папке \"" + SRC_FOLDER + "\", а в \"" + srcName + "\".");
        return null;
    }

    if (base === null) { alert("Не удалось определить папку уровнем выше."); return null; }

    var target = new Folder(base.fsName + "/" + DST_FOLDER);
    if (!target.exists && !target.create()) {
        alert("Не удалось создать папку:\n" + target.fsName);
        return null;
    }
    return target;
}


// ---------- диалог ----------

// Куда лёг бы файл при выборе «уровнем выше» — без создания папки,
// в отличие от resolveTargetFolder. Нужно только для подсказок в окне.
function probableUpDir(srcFolder) {
    var srcName = decodeURI(srcFolder.name);
    var inPsd = (srcName.toLowerCase() === SRC_FOLDER.toLowerCase());

    var base = null;
    if (inPsd || FALLBACK === 'up') { base = srcFolder.parent; }
    else if (FALLBACK === 'here')   { base = srcFolder; }

    return base ? (base.fsName + "/" + DST_FOLDER) : null;
}

function askOptions(doc, srcFolder, nearPath, upPath) {

    var w = new Window('dialog', 'Сохранить JPG');
    w.alignChildren = 'fill';
    w.margins = 16;
    w.spacing = 12;

    // --- куда ---
    var p = w.add('panel', undefined, 'Куда сохранить');
    p.alignChildren = 'left';
    p.margins = [14, 18, 14, 14];
    p.spacing = 8;

    var rNear = p.add('radiobutton', undefined, 'Рядом с PSD');
    var lNear = p.add('statictext', undefined, nearPath);
    var rUp   = p.add('radiobutton', undefined, 'В папку "' + DST_FOLDER + '" уровнем выше');
    var lUp   = p.add('statictext', undefined, upPath);

    var grey = lNear.graphics.newPen(
        lNear.graphics.PenType.SOLID_COLOR, [0.45, 0.45, 0.45, 1], 1);
    lNear.graphics.foregroundColor = grey;
    lUp.graphics.foregroundColor = grey;

    rNear.value = (DEFAULT_TARGET === 'near');
    rUp.value   = !rNear.value;

    // --- как ---
    var p2 = w.add('panel', undefined, 'Как сохранить');
    p2.alignChildren = 'left';
    p2.margins = [14, 18, 14, 14];
    p2.spacing = 8;

    var gf = p2.add('group');
    gf.add('statictext', undefined, 'Формат:').preferredSize.width = 110;
    var rJpg = gf.add('radiobutton', undefined, 'JPG');
    var rTif = gf.add('radiobutton', undefined, 'TIFF');
    rJpg.value = (DEFAULT_FORMAT !== 'tif');
    rTif.value = !rJpg.value;

    var cbStroke = p2.add('checkbox', undefined, 'Добавить белую обводку по краю кадра');
    cbStroke.value = DEFAULT_STROKE;

    var gq = p2.add('group');
    var lqName = gq.add('statictext', undefined, 'Качество JPEG:');
    lqName.preferredSize.width = 110;
    var sq = gq.add('slider', undefined, DEFAULT_QUALITY, 1, 12);
    sq.preferredSize.width = 180;
    var lq = gq.add('statictext', undefined, '');
    lq.preferredSize.width = 30;

    // --- если файл уже есть ---
    var p3 = w.add('panel', undefined, 'Если файл уже существует');
    p3.alignChildren = 'left';
    p3.margins = [14, 18, 14, 14];
    p3.spacing = 6;

    var rCopy = p3.add('radiobutton', undefined, 'Сохранить копией — _1, _2');
    var rOver = p3.add('radiobutton', undefined, 'Перезаписать');
    rOver.value = DEFAULT_OVERWRITE;
    rCopy.value = !rOver.value;

    var lExist = p3.add('statictext', undefined, '');
    lExist.preferredSize.width = 400;
    lExist.graphics.foregroundColor = grey;

    // --- глубина ---
    var note = w.add('statictext', undefined, '', { multiline: true });
    note.preferredSize.width = 430;
    note.preferredSize.height = 30;
    note.graphics.foregroundColor = grey;

    var btns = w.add('group');
    btns.alignment = 'right';
    btns.add('button', undefined, 'Отмена', {name: 'cancel'});
    btns.add('button', undefined, 'Сохранить', {name: 'ok'});

    function refresh() {
        var jpg = rJpg.value;

        lq.text = Math.round(sq.value);
        lqName.enabled = jpg;
        sq.enabled     = jpg;
        lq.enabled     = jpg;

        note.text = jpg
            ? ("Документ: " + bitsLabel(doc) + ". JPG всегда пишется в 8 бит — " +
               "других глубин формат не знает. Мастер не изменяется.")
            : ("Документ: " + bitsLabel(doc) + ". TIFF сохранит эту глубину как есть, " +
               "сжатие " + TIFF_COMPRESSION + ", без слоёв. Файл крупный, зато без потерь.");

        // есть ли уже файл с таким именем в выбранной папке
        var ext = jpg ? "jpg" : "tif";
        var dir = rUp.value ? probableUpDir(srcFolder) : srcFolder.fsName;
        var name = baseName(doc) + "." + ext;

        if (dir === null) {
            lExist.text = "";
        } else if (new File(dir + "/" + name).exists) {
            lExist.text = rOver.value
                        ? ("• " + name + " уже есть и будет перезаписан. Отката нет.")
                        : ("• " + name + " уже есть — появится копия с суффиксом.");
        } else {
            lExist.text = "• " + name + " в этой папке пока нет.";
        }
    }

    rJpg.onClick  = refresh;
    rTif.onClick  = refresh;
    rNear.onClick = refresh;
    rUp.onClick   = refresh;
    rCopy.onClick = refresh;
    rOver.onClick = refresh;
    sq.onChanging = refresh;
    refresh();

    if (w.show() !== 1) { return null; }

    return {
        up:        rUp.value,
        format:    rTif.value ? 'tif' : 'jpg',
        stroke:    cbStroke.value,
        quality:   Math.round(sq.value),
        overwrite: rOver.value
    };
}


// ---------- основной код ----------

main();

function main() {

    if (app.documents.length === 0) { alert("Нет открытых документов."); return; }

    var doc    = app.activeDocument;
    var folder = getFolder(doc);

    // документа ещё нет на диске — сначала кладём PSD
    if (folder === null) {
        folder = savePsdFirst(doc);
        if (folder === null) { return; }   // отмена выбора папки
    }

    var srcName = decodeURI(folder.name);
    var upHint  = (folder.parent ? decodeURI(folder.parent.name) : '?') + " \\ " + DST_FOLDER;

    var opts = askOptions(doc, folder, srcName + " \\ " + baseName(doc), upHint);
    if (opts === null) { return; }

    var dir;
    if (opts.up) {
        var target = resolveTargetFolder(folder);
        if (target === null) { return; }
        dir = target.fsName;
    } else {
        dir = folder.fsName;
    }

    var ext  = (opts.format === 'tif') ? "tif" : "jpg";
    var file = opts.overwrite
             ? new File(dir + "/" + baseName(doc) + "." + ext)
             : uniqueFile(dir, baseName(doc), ext);

    saveCopy(doc, file, opts.stroke, opts.format, opts.quality);
}
