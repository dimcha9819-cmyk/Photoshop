/*
    Save_near_PSD.jsx
    ------------------------------------------------------------------
    Сохраняет активный документ в JPG максимального качества рядом
    с исходным PSD, без единого вопроса.

    Если документ ещё не сохранён на диск, скрипт сначала спрашивает
    папку, кладёт туда PSD, а уже потом JPG рядом с ним.

    Исходный документ не изменяется: вся работа идёт на временной
    копии. Глубина цвета мастера сохраняется — в 8 бит уходит только
    копия для JPG, потому что иной глубины формат JPEG не знает.

    Для выбора папки, обводки и прочего есть Save_options.jsx.
    ------------------------------------------------------------------
*/

#target photoshop

// ===================== НАСТРОЙКИ =====================
var JPEG_QUALITY = 12;      // 1..12
var OVERWRITE    = true;    // false — дописывать _1, _2 вместо перезаписи
// =====================================================

// ---------- общие функции ----------

function getFolder(doc) {
    try { return doc.path; } catch (e) { return null; }
}

function baseName(doc) {
    return doc.name.replace(/\.[^\.]+$/, "");
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
// Возвращает папку, в которой оказался файл, либо null при отмене.
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

// Сохранение копии в JPG. Оригинальный документ не изменяется.
function saveJpegCopy(doc, targetFile, quality) {

    var dup = doc.duplicate(baseName(doc) + "_tmp_jpg", true);

    try {
        if (dup.mode == DocumentMode.BITMAP) { dup.changeMode(ChangeMode.GRAYSCALE); }
        if (dup.mode != DocumentMode.RGB &&
            dup.mode != DocumentMode.CMYK &&
            dup.mode != DocumentMode.GRAYSCALE) { dup.changeMode(ChangeMode.RGB); }

        dup.flatten();

        // Перевод в 8 бит — последним шагом, уже по сведённой картинке.
        // Этого требует сам формат JPEG: другой глубины он не знает.
        // Мастер при этом остаётся в своей глубине — он даже не копия.
        if (dup.bitsPerChannel != BitsPerChannelType.EIGHT) {
            dup.bitsPerChannel = BitsPerChannelType.EIGHT;
        }

        var opt = new JPEGSaveOptions();
        opt.quality           = quality;
        opt.embedColorProfile = true;
        opt.matte             = MatteType.NONE;
        opt.formatOptions     = FormatOptions.OPTIMIZEDBASELINE;

        dup.saveAs(targetFile, opt, true, Extension.LOWERCASE);
    } finally {
        dup.close(SaveOptions.DONOTSAVECHANGES);
    }
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

    var name = baseName(doc);
    var file = OVERWRITE ? new File(folder.fsName + "/" + name + ".jpg")
                         : uniqueFile(folder.fsName, name, "jpg");

    saveJpegCopy(doc, file, JPEG_QUALITY);
}
