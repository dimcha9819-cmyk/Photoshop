/**
 * Place_Photos.jsx
 *
 * Кладёт фотографии смарт-объектами в текущий документ-ленту, по одной
 * на слайд, автоматически занимая свободные слайды.
 *
 * Как работает:
 *   1. Открывает обычный проводник Windows — отмечайте снимки как
 *      привычно, Ctrl и Shift работают. Папка запоминается до
 *      перезапуска Photoshop, так что в следующий раз откроется там же.
 *   2. Определяет раскладку документа: ширину слайда и их количество.
 *      Формат подбирается из RATIOS по высоте холста так, чтобы ширина
 *      делилась на срез без остатка.
 *   3. Находит свободные слайды:
 *        • есть группы Slide 01…NN (их делает Slides.jsx для 9:16) —
 *          свободна пустая группа, и снимок ложится прямо в неё,
 *          под её маску;
 *        • групп нет — занятым считается слайд, в который попадает
 *          центр уже лежащего слоя. Слои во весь холст (фон, заливки)
 *          в расчёт не идут.
 *   4. Вставляет снимки и вписывает каждый в поля своего слайда.
 *
 * Окно с настройками появляется, только если что-то не сходится:
 * раскладку определить не удалось или свободных слайдов меньше, чем
 * выбрано снимков. Когда всё сходится, скрипт просто делает работу.
 *
 * Вставка смарт-объектом: масштаб обратим, качество не теряется при
 * повторных трансформациях.
 *
 * Photoshop CS6+ / 2020+ (ExtendScript)
 */

#target photoshop
app.bringToFront();

// ===================== НАСТРОЙКИ =====================

// Расширения, которые предлагать в проводнике
var EXTENSIONS = ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'psd', 'psb', 'webp'];

// Форматы слайда: ширина = высота документа * k
var RATIOS = [
    { label: '4:5',  k: 0.8    },
    { label: '3:4',  k: 0.75   },
    { label: '9:16', k: 0.5625 }
];

// Имя общей группы, если слайды собраны в неё
var SLIDES_GROUP = 'Slides';

// Префикс групп с масками — как в Slides.jsx
var MASK_PREFIX  = 'Slide ';

// Когда показывать окно с настройками:
//   'auto'   — только если раскладка не определилась или не хватает слайдов
//   'always' — всегда
//   'never'  — никогда, молча делать что можно
var ASK_OPTIONS = 'auto';

// Куда класть снимки, когда окно не показывается:
//   true  — только на свободные слайды
//   false — подряд с первого
var ONLY_FREE = true;

// Как вписывать снимок:
//   'fit'  — целиком в поля слайда, пропорции сохраняются
//   'long' — длинная сторона приводится к LONG_SIDE
var PLACE_MODE = 'fit';
var MARGIN_PCT = 7.8125;    // поля слайда для режима 'fit', %
var LONG_SIDE  = 1100;      // длинная сторона для режима 'long', px

// Что делать, когда снимков больше, чем мест:
//   true  — класть лишние поверх занятых, начиная с первого
//   false — остановиться, лишние не размещать
var OVERFLOW_WRAP = false;

// =====================================================

(function () {

    // ------------------------------------------------------------- выбор

    // Фильтр для проводника Windows: "Имя:*.ext;*.ext,Имя:*.*"
    function fileFilter() {
        var masks = [];
        for (var i = 0; i < EXTENSIONS.length; i++) {
            masks.push('*.' + EXTENSIONS[i]);
        }
        return 'Фотографии:' + masks.join(';') + ',Все файлы:*.*';
    }

    // Последняя папка живёт до перезапуска Photoshop: движок ExtendScript
    // один на весь сеанс
    function rememberedFolder() {
        try {
            if ($.global.PLACE_PHOTOS_DIR) {
                var f = new Folder($.global.PLACE_PHOTOS_DIR);
                if (f.exists) { return f; }
            }
        } catch (e) {}
        return null;
    }

    function rememberFolder(file) {
        try { $.global.PLACE_PHOTOS_DIR = file.parent.fsName; } catch (e) {}
    }

    // Системный диалог выбора файлов, множественный выбор
    function pickFiles() {
        var start = rememberedFolder();
        var prev = null;
        try {
            prev = Folder.current;
            if (start !== null) { Folder.current = start; }
        } catch (e) {}

        var picked = null;
        try {
            picked = File.openDialog('Выберите фотографии', fileFilter(), true);
        } catch (e) {
            picked = File.openDialog('Выберите фотографии');
        }

        try { if (prev !== null) { Folder.current = prev; } } catch (e2) {}

        if (picked === null) { return null; }
        if (!(picked instanceof Array)) { picked = [picked]; }
        if (picked.length === 0) { return null; }

        rememberFolder(picked[0]);
        return picked;
    }

    // ------------------------------------------------------------- хелперы

    function layerBox(layer) {
        var b = layer.bounds;
        var x0 = b[0].as("px"), y0 = b[1].as("px"),
            x1 = b[2].as("px"), y1 = b[3].as("px");
        return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0, h: y1 - y0 };
    }

    // ---------------------------------------------------------- раскладка

    // Ширина слайда: формат, при котором холст делится без остатка
    function detectSlideWidth(W, H) {
        for (var i = 0; i < RATIOS.length; i++) {
            var sw = Math.round(H * RATIOS[i].k);
            if (sw > 0 && W % sw === 0) {
                return { width: sw, count: W / sw, label: RATIOS[i].label };
            }
        }
        return null;
    }

    function findGroup(doc, name) {
        for (var i = 0; i < doc.layerSets.length; i++) {
            if (doc.layerSets[i].name === name) { return doc.layerSets[i]; }
        }
        return null;
    }

    // Группы Slide NN по номеру слайда. Ищем и на верхнем уровне документа,
    // и внутри общей группы Slides — Slides.jsx делает их на верхнем
    // уровне, но руками их могли и собрать в группу.
    function findSlideGroups(doc, parent, count) {
        var found = [];
        found.length = count;
        var any = false;

        function scan(container) {
            if (container === null) { return; }
            for (var i = 0; i < container.layerSets.length; i++) {
                var g = container.layerSets[i];
                if (g.name.indexOf(MASK_PREFIX) !== 0) { continue; }
                var m = g.name.match(/(\d+)\s*$/);
                if (!m) { continue; }
                var n = parseInt(m[1], 10) - 1;
                if (n >= 0 && n < count && !found[n]) { found[n] = g; any = true; }
            }
        }

        scan(doc);
        scan(parent);
        return any ? found : null;
    }

    function groupIsEmpty(g) {
        return g.artLayers.length === 0 && g.layerSets.length === 0;
    }

    // Занятые слайды по содержимому: слой во весь холст и слой без
    // собственных пикселей в расчёт не идут
    function occupiedByBounds(container, W, H, slideW, count) {
        var busy = [];
        var i;
        for (i = 0; i < count; i++) { busy.push(false); }

        function scan(items) {
            for (var k = 0; k < items.length; k++) {
                var b;
                try { b = layerBox(items[k]); } catch (e) { continue; }
                if (b.w < 1 || b.h < 1) { continue; }
                if (b.w >= W * 0.9)     { continue; }   // фон во всю ленту
                var idx = Math.floor((b.x0 + b.x1) / 2 / slideW);
                if (idx >= 0 && idx < count) { busy[idx] = true; }
            }
        }

        scan(container.artLayers);
        scan(container.layerSets);
        return busy;
    }

    // Свободные слайды и группы, если они есть
    function layout(doc, W, H, slideW) {
        var n = Math.max(1, Math.floor(W / slideW));
        var parent = findGroup(doc, SLIDES_GROUP);
        var groups = findSlideGroups(doc, parent, n);
        var free = [];
        var i;

        if (groups !== null) {
            for (i = 0; i < n; i++) {
                if (groups[i] && groupIsEmpty(groups[i])) { free.push(i); }
            }
            return { count: n, free: free, groups: groups, parent: parent,
                     how: 'по пустым группам слайдов' };
        }

        var busy = occupiedByBounds(parent !== null ? parent : doc, W, H, slideW, n);
        for (i = 0; i < n; i++) { if (!busy[i]) { free.push(i); } }
        return { count: n, free: free, groups: null, parent: parent,
                 how: 'по содержимому слайдов' };
    }

    // ------------------------------------------------------------ вставка

    function placeEmbedded(file) {
        var d = new ActionDescriptor();
        d.putPath(charIDToTypeID("null"), file);
        d.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));
        d.putBoolean(stringIDToTypeID("linked"), false);
        executeAction(stringIDToTypeID("placeEvent"), d, DialogModes.NO);
        return app.activeDocument.activeLayer;
    }

    // Вписать слой в прямоугольник слайда и отцентрировать по нему
    function fitToSlide(layer, slideIndex, slideW, H) {
        var b = layerBox(layer);
        if (b.w < 1 || b.h < 1) { return; }

        var left = slideIndex * slideW;
        var boxW = slideW - slideW * MARGIN_PCT / 100 * 2;
        var boxH = H - H * MARGIN_PCT / 100 * 2;

        var scale = (PLACE_MODE === 'long')
                  ? LONG_SIDE / Math.max(b.w, b.h) * 100
                  : Math.min(boxW / b.w, boxH / b.h) * 100;

        layer.resize(scale, scale, AnchorPosition.MIDDLECENTER);

        b = layerBox(layer);
        layer.translate(
            new UnitValue(left + slideW / 2 - (b.x0 + b.x1) / 2, "px"),
            new UnitValue(H / 2 - (b.y0 + b.y1) / 2, "px")
        );
    }

    // ------------------------------------------------------------- диалог

    // Показывается, только когда что-то не сходится
    function askOptions(doc, W, H, slideW, count, lay) {

        var dlg = new Window('dialog', 'Разместить фотографии');
        dlg.orientation = 'column';
        dlg.alignChildren = 'fill';
        dlg.margins = 16;
        dlg.spacing = 10;

        dlg.add('statictext', undefined,
                'Документ ' + W + ' x ' + H + ' px,  выбрано снимков: ' + count);

        var p = dlg.add('panel', undefined, 'Слайды');
        p.alignChildren = 'left';
        p.margins = [12, 16, 12, 12];
        p.spacing = 6;

        var gw = p.add('group');
        gw.add('statictext', undefined, 'Ширина слайда:').preferredSize.width = 110;
        var widthField = gw.add('edittext', undefined, String(slideW));
        widthField.preferredSize.width = 70;
        gw.add('statictext', undefined, 'px');

        var cbFree = p.add('checkbox', undefined,
                           'Только на свободные слайды (иначе подряд с первого)');
        cbFree.value = ONLY_FREE;

        var info = p.add('statictext', undefined, '');
        info.preferredSize.width = 420;

        var status = dlg.add('statictext', undefined, '', { multiline: true });
        status.preferredSize.width = 430;
        status.preferredSize.height = 30;

        var btns = dlg.add('group');
        btns.alignment = 'right';
        btns.add('button', undefined, 'Отмена', { name: 'cancel' });
        var ok = btns.add('button', undefined, 'Разместить', { name: 'ok' });

        var current = lay;

        function slideWidth() {
            var v = parseInt(widthField.text, 10);
            return (isNaN(v) || v < 1) ? 1 : v;
        }

        function refresh() {
            current = layout(doc, W, H, slideWidth());
            info.text = 'Всего ' + current.count + ', свободно ' +
                        current.free.length + '   (' + current.how + ')';

            var places = cbFree.value ? current.free.length : current.count;
            if (places === 0) {
                status.text = 'Свободных слайдов нет. Снимите галку, чтобы класть подряд.';
            } else if (count > places && !OVERFLOW_WRAP) {
                status.text = 'Будет размещено ' + places + ' из ' + count +
                              ' — остальные ' + (count - places) + ' не поместятся.';
            } else {
                status.text = 'Будет размещено ' + Math.min(count, places) + '.';
            }
            ok.enabled = (places > 0);
        }

        widthField.onChanging = refresh;
        cbFree.onClick = refresh;
        refresh();

        if (dlg.show() !== 1) { return null; }
        return { slideWidth: slideWidth(), onlyFree: cbFree.value, layout: current };
    }

    // ---------------------------------------------------------------- пуск

    if (app.documents.length === 0) {
        alert('Сначала откройте документ со слайдами.');
        return;
    }

    var files = pickFiles();
    if (files === null) { return; }

    var doc = app.activeDocument;
    var oldUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;

    try {
        var W = Math.round(doc.width.as('px'));
        var H = Math.round(doc.height.as('px'));

        var detected = detectSlideWidth(W, H);
        var slideW = detected ? detected.width : Math.round(H * RATIOS[0].k);
        var lay = layout(doc, W, H, slideW);
        var onlyFree = ONLY_FREE;

        var places = onlyFree ? lay.free.length : lay.count;
        var needAsk = (ASK_OPTIONS === 'always') ||
                      (ASK_OPTIONS === 'auto' &&
                       (detected === null || places === 0 ||
                        (files.length > places && !OVERFLOW_WRAP)));

        if (needAsk) {
            var ans = askOptions(doc, W, H, slideW, files.length, lay);
            if (ans === null) { return; }
            slideW   = ans.slideWidth;
            onlyFree = ans.onlyFree;
            lay      = ans.layout;
        }

        // целевые слайды
        var targets = [];
        var i;
        if (onlyFree) {
            targets = lay.free;
        } else {
            for (i = 0; i < lay.count; i++) { targets.push(i); }
        }
        if (targets.length === 0) {
            alert('Свободных слайдов нет.');
            return;
        }

        var placed = 0;
        var errors = [];

        for (i = 0; i < files.length; i++) {

            if (i >= targets.length && !OVERFLOW_WRAP) { break; }
            var slide = targets[i % targets.length];

            try {
                app.activeDocument = doc;
                var lyr = placeEmbedded(files[i]);
                lyr.name = decodeURI(files[i].name);

                fitToSlide(lyr, slide, slideW, H);

                // в свою группу под маску, иначе в общую Slides
                var box = (lay.groups !== null && lay.groups[slide])
                        ? lay.groups[slide]
                        : lay.parent;
                if (box !== null) { lyr.move(box, ElementPlacement.INSIDE); }

                placed++;
            } catch (e) {
                errors.push(decodeURI(files[i].name) + '  —  ' + e);
            }
        }

        doc.selection.deselect();

        var skipped = files.length - placed - errors.length;
        var msg = 'Размещено: ' + placed + ' из ' + files.length;
        if (skipped > 0) { msg += '\nНе хватило слайдов для ' + skipped + '.'; }
        if (errors.length > 0) {
            msg += '\n\nНе удалось (' + errors.length + '):\n' + errors.join('\n');
        }
        alert(msg);

    } catch (e) {
        alert('Ошибка: ' + e + (e.line ? '\nстрока ' + e.line : ''));
    } finally {
        app.preferences.rulerUnits = oldUnits;
    }

})();
