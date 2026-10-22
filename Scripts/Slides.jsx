/**
 * insta_guided_2026.jsx
 *
 * Создаёт документ-ленту из слайдов 2048 x 2560 px с направляющими,
 * фоном, группой для фотографий и чёрно-белым корректирующим слоем —
 * ту же заготовку, что лежит в «20 Slides.psb».
 *
 * Что делает:
 *   1. Документ slides x 2048 x 2560 px, 72 ppi, RGB, 8 bit, sRGB,
 *      белый фоновый слой, квадратные пиксели.
 *   2. Слои снизу вверх:  Background (белый, залочен)
 *                         Layer 1    (сплошной чёрный на весь холст,
 *                                     скрыт чёрной маской)
 *                         Slides     (группа — сюда ложатся фотографии)
 *                         Channel Mixer 1 (монохром 45 / 40 / 20, константа 0)
 *   3. Направляющие двумя цветами: границы слайдов и верх/низ кадра —
 *      COLOR_FRAME, центры слайдов и центр по высоте — COLOR_CENTER.
 *      Цвет задаётся через Action Manager перед созданием каждой группы,
 *      поэтому каждая направляющая запоминает свой. Требуется
 *      Photoshop 23.4 (2022) или новее — в старых версиях цвет общий.
 *   4. Раскладывает фотографии из папки. По умолчанию (photoMode
 *      "quadrants") — по четырём четвертям каждого слайда, масштабируя
 *      каждый снимок по длинной стороне до photoLongSide и центрируя его
 *      в своей четверти; пятый снимок уходит в первую четверть следующего
 *      слайда. Режим "frame" кладёт по одному снимку на слайд, вписывая
 *      его в кадр 2:3. Если снимков меньше, чем мест, блок прижимается
 *      к ПРАВОМУ краю ленты (photoAlign), занимая целое число слайдов.
 *   5. По желанию сохраняет результат под именем saveName: .psb, если
 *      холст шире 30000 px, иначе .psd.
 *
 * При запуске спрашивает количество слайдов, формат кадра, глубину цвета
 * (8 или 16 бит) и папку с фотографиями. Папку можно оставить пустой —
 * тогда слайды будут пустыми.
 * Диалог отключается настройкой showDialog: false, и тогда всё берётся
 * из CFG.
 *
 * При marginPct = 7.8125 кадр получается ровно 1440 x 2160 px,
 * направляющие внутри слайда: y = 200 / 2360.
 *
 * Photoshop CS6+ / 2020+ (ExtendScript)
 */

#target photoshop
app.bringToFront();

(function () {

    // ------------------------------------------------------------------
    // Настройки
    // ------------------------------------------------------------------
    var CFG = {
        // диалог при запуске
        showDialog:   true,       // false = молча взять значения из CFG
        dialogSlides: [10, 20],   // варианты количества слайдов
        dialogRatios: [           // варианты формата слайда
            { label: "4:5", width: 2048 },
            { label: "3:4", width: 1920 }
        ],
        dialogBits:   [8, 16],    // варианты глубины цвета

        // документ
        name:         "",                            // имя документа; "" = "<N> Slides"
        saveName:     "Collage",                     // имя файла при сохранении;
                                                     // "" = как имя документа
        slides:       20,                            // количество слайдов
        slideWidth:   2048,                          // ширина слайда, px
        height:       2560,                          // высота холста, px
        resolution:   72,                            // ppi
        mode:         NewDocumentMode.RGB,
        bits:         BitsPerChannelType.EIGHT,      // 8 bit
        fill:         DocumentFill.WHITE,            // белый фоновый слой
        pixelAspect:  1,                             // квадратные пиксели
        colorProfile: "sRGB IEC61966-2.1",           // "" = рабочее пространство

        // поля
        marginPct:       7.8125, // отступ от всех краёв, %
                                 // (база: ширина слайда — лево/право,
                                 //        высота холста  — верх/низ)
        marginTopPct:    null,   // переопределение отдельных сторон, null = marginPct
        marginBottomPct: null,
        marginLeftPct:   null,
        marginRightPct:  null,

        // кадр
        aspectW:      2,        // соотношение сторон кадра (ширина : высота)
        aspectH:      3,
        anchor:       "center", // "center" | "top"
        snapFrame:    true,     // размер кадра кратен aspectW/aspectH в целых px
                                // => соотношение сторон точное, без дробей

        // направляющие
        guideSlideBorders: true,  // границы слайдов: 0, 2048, 4096 …
        guideSlideCenters: true,  // центры слайдов:  1024, 3072 …
        guideCenterH:      true,  // горизонталь по центру холста (y = 1280)
        guideFrameH:       true,  // верх и низ кадра (y = 200 / 2360)

        // Цвета направляющих. Идентификатор всегда ровно 4 символа,
        // пробелы значимы:
        //   'Cyn ' циан      'LgtB' светло-синий   'Bl  ' синий
        //   'Mgnt' пурпурный 'LgtR' светло-красный 'Rd  ' красный
        //   'Ylw ' жёлтый    'Grn ' зелёный        'Gry ' серый
        colorFrame:   "Mgnt",   // границы слайдов и кадр
        colorCenter:  "Cyn ",   // центры слайдов и центр по высоте
        colorRestore: "",       // вернуть после работы; "" — не трогать

        // слои
        blackLayer:     true,             // сплошной чёрный "Layer 1" поверх фона
        blackColor:     [0, 0, 0],
        blackLayerMask: true,             // чёрная маска на нём — слой скрыт целиком
        slidesGroup:    "Slides",         // "" = не создавать группу
        channelMixer:   true,             // ч/б корректирующий слой
        mixerMono:      [45, 40, 20, 0],  // red, green, blue, constant, %

        // фото
        loadPhotos:   false,    // учитывается только при showDialog: false;
                                // true = разложить фотографии по слайдам
        photoFolder:  "",       // путь к папке — подставляется в поле диалога;
                                // "" = спросить
        photoAlign:   "right",  // "right" = блок фото прижат к последним слайдам
                                // "left"  = к первым
        photoExt:     ["jpg", "jpeg", "png", "tif", "tiff", "psd", "psb", "webp"],

        // Как раскладывать снимки:
        //   "quadrants" — сетка photoCols x photoRows в каждом слайде,
        //                 масштаб по длинной стороне, центр в своей ячейке:
        //                     +-------+-------+
        //                     |   1   |   2   |
        //                     +-------+-------+
        //                     |   3   |   4   |
        //                     +-------+-------+
        //                 снимок 5 уходит в первую ячейку следующего слайда;
        //   "frame"     — по одному снимку на слайд, вписанному в кадр 2:3.
        photoMode:      "quadrants",
        photoCols:      2,      // колонок в слайде
        photoRows:      2,      // рядов в слайде
        photoLongSide:  1100,   // длинная сторона снимка, px
        photoJitter:    0,      // случайный сдвиг, доля ячейки (0…0.4)
        photoRotate:    false,  // случайный небольшой поворот
        photoRotateMax: 6,      // максимальный угол поворота, градусы

        // сохранение
        save:         false,    // true = сохранить файл
        folder:       ""        // "" = спросить папку диалогом
    };

    // ------------------------------------------------------------------
    // Хелперы
    // ------------------------------------------------------------------
    function pct(value, fallback) {
        return (value === null || value === undefined) ? fallback : value;
    }

    // 8 / 16 / 32 -> константа Photoshop
    function bitsConst(n) {
        if (n === 16) { return BitsPerChannelType.SIXTEEN; }
        if (n === 32) { return BitsPerChannelType.THIRTYTWO; }
        return BitsPerChannelType.EIGHT;
    }

    // Цвет направляющих, создаваемых далее
    function setGuideColor(charID) {
        if (!charID) { return; }
        try {
            var d = new ActionDescriptor();
            var r = new ActionReference();
            r.putProperty(charIDToTypeID("Prpr"), charIDToTypeID("GdPr"));
            r.putEnumerated(charIDToTypeID("capp"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            d.putReference(charIDToTypeID("null"), r);

            var d2 = new ActionDescriptor();
            d2.putEnumerated(charIDToTypeID("GdsC"), charIDToTypeID("GdGr"), charIDToTypeID(charID));
            d.putObject(charIDToTypeID("T   "), charIDToTypeID("GdPr"), d2);

            executeAction(charIDToTypeID("setd"), d, DialogModes.NO);
        } catch (e) {
            // неизвестный идентификатор цвета — оставляем текущий
        }
    }

    function addGuide(doc, direction, posPx) {
        doc.guides.add(direction, new UnitValue(posPx, "px"));
    }

    function makeDoc(c, width) {
        if (c.colorProfile) {
            try {
                return app.documents.add(width, c.height, c.resolution, c.name,
                                         c.mode, c.fill, c.pixelAspect, c.bits, c.colorProfile);
            } catch (e) {
                // профиля с таким именем в системе нет — берём рабочее пространство
            }
        }
        return app.documents.add(width, c.height, c.resolution, c.name,
                                 c.mode, c.fill, c.pixelAspect, c.bits);
    }

    // новый слой со сплошной заливкой на весь холст
    function addSolidLayer(doc, name, rgb) {
        var lyr = doc.artLayers.add();
        lyr.name = name;

        var col = new SolidColor();
        col.rgb.red   = rgb[0];
        col.rgb.green = rgb[1];
        col.rgb.blue  = rgb[2];

        doc.selection.selectAll();
        doc.selection.fill(col);
        doc.selection.deselect();

        return lyr;
    }

    // чёрная (скрывающая всё) маска на активном слое
    function addHideAllMask() {
        var d = new ActionDescriptor();
        d.putClass(stringIDToTypeID("new"), charIDToTypeID("Chnl"));

        var r = new ActionReference();
        r.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
        d.putReference(stringIDToTypeID("at"), r);

        d.putEnumerated(stringIDToTypeID("using"),
                        stringIDToTypeID("userMaskEnabled"),
                        stringIDToTypeID("hideAll"));

        executeAction(stringIDToTypeID("make"), d, DialogModes.NO);
    }

    // Channel Mixer с включённым «Монохромный».
    // В два приёма: сначала слой со значениями по умолчанию, затем значения —
    // так надёжнее на разных версиях Photoshop.
    function addChannelMixerMono(mono) {
        var d = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putClass(stringIDToTypeID("adjustmentLayer"));
        d.putReference(stringIDToTypeID("null"), ref);

        var type = new ActionDescriptor();
        type.putEnumerated(stringIDToTypeID("presetKind"),
                           stringIDToTypeID("presetKindType"),
                           stringIDToTypeID("presetKindDefault"));

        var using = new ActionDescriptor();
        using.putObject(stringIDToTypeID("type"), stringIDToTypeID("channelMixer"), type);
        d.putObject(stringIDToTypeID("using"), stringIDToTypeID("adjustmentLayer"), using);
        executeAction(stringIDToTypeID("make"), d, DialogModes.NO);

        // значения
        var sd = new ActionDescriptor();
        var sref = new ActionReference();
        sref.putEnumerated(stringIDToTypeID("adjustmentLayer"),
                           stringIDToTypeID("ordinal"),
                           stringIDToTypeID("targetEnum"));
        sd.putReference(stringIDToTypeID("null"), sref);

        var val = new ActionDescriptor();
        val.putEnumerated(stringIDToTypeID("presetKind"),
                          stringIDToTypeID("presetKindType"),
                          stringIDToTypeID("presetKindCustom"));
        val.putBoolean(stringIDToTypeID("monochromatic"), true);

        var gray = new ActionDescriptor();
        gray.putInteger(charIDToTypeID("Rd  "), mono[0]);
        gray.putInteger(charIDToTypeID("Grn "), mono[1]);
        gray.putInteger(charIDToTypeID("Bl  "), mono[2]);
        // константу пишем, только если она не нулевая: значение по умолчанию
        // и так 0, а лишний ключ — лишний повод для отказа на старых версиях
        if (mono[3]) { gray.putInteger(charIDToTypeID("Cnst"), mono[3]); }
        val.putObject(stringIDToTypeID("gray"), stringIDToTypeID("channelMatrix"), gray);

        sd.putObject(stringIDToTypeID("to"), stringIDToTypeID("channelMixer"), val);
        executeAction(stringIDToTypeID("set"), sd, DialogModes.NO);
    }

    // вставка файла как смарт-объекта
    function placeEmbedded(file) {
        var d = new ActionDescriptor();
        d.putPath(charIDToTypeID("null"), file);
        d.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));
        d.putBoolean(stringIDToTypeID("linked"), false);
        executeAction(stringIDToTypeID("placeEvent"), d, DialogModes.NO);
        return app.activeDocument.activeLayer;
    }

    function layerBox(layer) {
        var b = layer.bounds;
        var x0 = b[0].as("px"), y0 = b[1].as("px"),
            x1 = b[2].as("px"), y1 = b[3].as("px");
        return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0, h: y1 - y0 };
    }

    // вписать слой в кадр и отцентрировать по нему
    function fitLayerToFrame(layer, frame) {
        var b = layerBox(layer);
        var scale = Math.min(frame.w / b.w, frame.h / b.h) * 100;
        layer.resize(scale, scale, AnchorPosition.MIDDLECENTER);

        b = layerBox(layer);
        layer.translate(
            new UnitValue(frame.cx - (b.x0 + b.x1) / 2, "px"),
            new UnitValue(frame.cy - (b.y0 + b.y1) / 2, "px")
        );
        return layerBox(layer);
    }

    // масштаб по длинной стороне и центр в заданной точке
    function placeAtPoint(layer, cx, cy, longSide, angle) {
        var b = layerBox(layer);
        if (b.w < 1 || b.h < 1) { return null; }

        var scale = longSide / Math.max(b.w, b.h) * 100;
        layer.resize(scale, scale, AnchorPosition.MIDDLECENTER);

        if (angle) { layer.rotate(angle, AnchorPosition.MIDDLECENTER); }

        b = layerBox(layer);
        layer.translate(
            new UnitValue(cx - (b.x0 + b.x1) / 2, "px"),
            new UnitValue(cy - (b.y0 + b.y1) / 2, "px")
        );
        return layerBox(layer);
    }

    // сколько снимков помещается в один слайд
    function seatsPerSlide(c) {
        return (c.photoMode === "frame")
             ? 1
             : Math.max(1, c.photoCols) * Math.max(1, c.photoRows);
    }

    // отсортированный список подходящих файлов в папке
    function collectFiles(folder, extensions) {
        var all = folder.getFiles();
        var out = [];

        for (var i = 0; i < all.length; i++) {
            var f = all[i];
            if (!(f instanceof File)) { continue; }

            var m = decodeURI(f.name).match(/\.([^\.]+)$/);
            if (!m) { continue; }

            var ext = m[1].toLowerCase();
            for (var e = 0; e < extensions.length; e++) {
                if (extensions[e] === ext) { out.push(f); break; }
            }
        }

        out.sort(function (a, b) {
            var an = decodeURI(a.name).toLowerCase();
            var bn = decodeURI(b.name).toLowerCase();
            return (an < bn) ? -1 : (an > bn) ? 1 : 0;
        });

        return out;
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

    // Диалог запуска: количество слайдов, формат, папка с фотографиями.
    // Возвращает null, если нажали «Отмена».
    function askOptions(c) {

        var dlg = new Window("dialog", "Выберите параметры документа");
        dlg.orientation = "column";
        dlg.alignChildren = "left";
        dlg.margins = 16;
        dlg.spacing = 10;

        // --- количество слайдов ---
        dlg.add("statictext", undefined, "Из скольки слайдов сделать документ?");

        var gCount = dlg.add("group");
        gCount.orientation = "column";
        gCount.alignChildren = "left";

        var rbCount = [];
        for (var i = 0; i < c.dialogSlides.length; i++) {
            rbCount.push(gCount.add("radiobutton", undefined, c.dialogSlides[i] + " слайдов"));
        }
        // отмечаем то, что стоит в CFG; если такого варианта нет — первый
        var startCount = 0;
        for (i = 0; i < c.dialogSlides.length; i++) {
            if (c.dialogSlides[i] === c.slides) { startCount = i; break; }
        }
        rbCount[startCount].value = true;

        // --- формат слайда ---
        dlg.add("statictext", undefined, "Выберите соотношение сторон:");

        var gRatio = dlg.add("group");
        gRatio.orientation = "column";
        gRatio.alignChildren = "left";

        var rbRatio = [];
        for (i = 0; i < c.dialogRatios.length; i++) {
            var r = c.dialogRatios[i];
            rbRatio.push(gRatio.add("radiobutton", undefined,
                         r.label + " (" + r.width + " x " + c.height + " px)"));
        }
        var startRatio = 0;
        for (i = 0; i < c.dialogRatios.length; i++) {
            if (c.dialogRatios[i].width === c.slideWidth) { startRatio = i; break; }
        }
        rbRatio[startRatio].value = true;

        // --- глубина цвета ---
        dlg.add("statictext", undefined, "Глубина цвета:");

        var gBits = dlg.add("group");
        gBits.orientation = "column";
        gBits.alignChildren = "left";

        var rbBits = [];
        for (i = 0; i < c.dialogBits.length; i++) {
            rbBits.push(gBits.add("radiobutton", undefined, c.dialogBits[i] + " бит"));
        }
        var startBits = 0;
        for (i = 0; i < c.dialogBits.length; i++) {
            if (bitsConst(c.dialogBits[i]) === c.bits) { startBits = i; break; }
        }
        rbBits[startBits].value = true;

        var sizeLbl = dlg.add("statictext", undefined, "");
        sizeLbl.preferredSize.width = 400;

        // --- папка с фотографиями ---
        var pnl = dlg.add("panel", undefined, "Папка с фотографиями (можно оставить пустой)");
        pnl.orientation = "row";
        pnl.alignChildren = "center";
        pnl.margins = [12, 16, 12, 12];

        var pathField = pnl.add("edittext", undefined, c.photoFolder || "");
        pathField.preferredSize.width = 300;
        var browseBtn = pnl.add("button", undefined, "Обзор...");

        var statusLbl = dlg.add("statictext", undefined, "");
        statusLbl.preferredSize.width = 400;

        var chosen = null;
        var found = 0;

        function slideCount() {
            for (var j = 0; j < rbCount.length; j++) {
                if (rbCount[j].value) { return c.dialogSlides[j]; }
            }
            return c.dialogSlides[0];
        }

        function slideWidth() {
            for (var j = 0; j < rbRatio.length; j++) {
                if (rbRatio[j].value) { return c.dialogRatios[j].width; }
            }
            return c.dialogRatios[0].width;
        }

        function bitsChoice() {
            for (var j = 0; j < rbBits.length; j++) {
                if (rbBits[j].value) { return c.dialogBits[j]; }
            }
            return c.dialogBits[0];
        }

        // Холст и во что он обойдётся: один слой RGBA целиком в памяти
        function refreshSize() {
            var w = slideCount() * slideWidth();
            var bytesPerPx = 4 * bitsChoice() / 8;
            var mb = w * c.height * bytesPerPx / 1048576;

            var size;
            if (mb >= 1024) {
                size = (Math.round(mb * 10 / 1024) / 10) + " ГБ";
            } else {
                size = Math.round(mb) + " МБ";
            }

            sizeLbl.text = "Холст: " + w + " x " + c.height + " px,   слой ~" + size;
        }

        function refresh() {
            refreshSize();
            if (chosen === null) {
                statusLbl.text = "Папка не выбрана — будут созданы пустые слайды.";
                return;
            }
            var per = seatsPerSlide(c);
            var cap = slideCount() * per;
            var tail;
            if (found === 0) {
                tail = " — подходящих файлов нет, слайды останутся пустыми";
            } else if (found > cap) {
                tail = " — мест " + cap + ", лишние " + (found - cap) + " не разместятся";
            } else {
                tail = " — мест " + cap + " (по " + per + " на слайд), займут " +
                       Math.ceil(found / per) + " слайдов у " +
                       (c.photoAlign === "left" ? "левого" : "правого") + " края";
            }
            statusLbl.text = "Найдено фотографий: " + found + tail;
        }

        function setFolder(f) {
            chosen = f;
            if (f === null) {
                pathField.text = "";
                found = 0;
            } else {
                pathField.text = f.fsName;
                found = collectFiles(f, c.photoExt).length;
            }
            refresh();
        }

        browseBtn.onClick = function () {
            var f = chooseFolder("Папка с фотографиями:", chosen);
            if (f !== null) { setFolder(f); }
        };

        pathField.onChange = function () {
            var txt = pathField.text.replace(/^\s+|\s+$/g, "");
            if (txt === "") { setFolder(null); return; }
            var f = new Folder(txt);
            setFolder(f.exists ? f : null);
        };

        for (i = 0; i < rbCount.length; i++) { rbCount[i].onClick = refresh; }
        for (i = 0; i < rbRatio.length; i++) { rbRatio[i].onClick = refresh; }
        for (i = 0; i < rbBits.length;  i++) { rbBits[i].onClick  = refresh; }

        // путь, заданный в CFG, подхватываем сразу
        if (pathField.text) { pathField.onChange(); } else { refresh(); }

        var btns = dlg.add("group");
        btns.alignment = "right";
        btns.add("button", undefined, "OK", { name: "ok" });
        btns.add("button", undefined, "Отмена", { name: "cancel" });

        if (dlg.show() !== 1) { return null; }

        return {
            slides:     slideCount(),
            slideWidth: slideWidth(),
            bits:       bitsConst(bitsChoice()),
            folder:     chosen
        };
    }

    // кадр 2:3 внутри слайда с номером slideIndex
    function frameFor(c, slideIndex) {
        var SW = c.slideWidth;
        var H  = c.height;
        var k  = c.aspectW / c.aspectH;

        // безопасная область слайда — слайд минус поля
        var boxTop    = H  * pct(c.marginTopPct,    c.marginPct) / 100;
        var boxBottom = H  - H  * pct(c.marginBottomPct, c.marginPct) / 100;
        var boxLeft   = SW * pct(c.marginLeftPct,   c.marginPct) / 100;
        var boxRight  = SW - SW * pct(c.marginRightPct,  c.marginPct) / 100;

        var availW = boxRight - boxLeft;
        var availH = boxBottom - boxTop;

        // максимальный прямоугольник с заданным соотношением сторон
        var fw = availW;
        var fh = fw / k;
        if (fh > availH) { fh = availH; fw = fh * k; }

        // подгонка под целые пиксели: fw и fh кратны aspectW / aspectH
        if (c.snapFrame) {
            var units  = Math.floor(fh / c.aspectH);
            var unitsW = Math.floor(fw / c.aspectW);
            if (unitsW < units) { units = unitsW; }
            fw = units * c.aspectW;
            fh = units * c.aspectH;
        }

        // позиция: сначала фиксируем левый верхний угол, затем от него
        // отсчитываем размер — так кадр остаётся точным после округления
        var left = Math.round(boxLeft + (availW - fw) / 2) + slideIndex * SW;
        var top  = Math.round((c.anchor === "top") ? boxTop : boxTop + (availH - fh) / 2);

        return {
            left: left, top: top,
            right: left + fw, bottom: top + fh,
            w: fw, h: fh,
            cx: left + fw / 2,
            cy: top + fh / 2
        };
    }

    function saveDoc(doc, c, width) {
        var folder = c.folder ? new Folder(c.folder)
                              : Folder.selectDialog("Куда сохранить файл?");
        if (!folder) { return null; }

        // холст шире 30000 px в .psd не помещается — только Large Document Format
        var big  = (width > 30000 || c.height > 30000);
        var base = c.saveName ? c.saveName : c.name;
        var f    = new File(folder.fsName + "/" + base + (big ? ".psb" : ".psd"));

        if (big) {
            var d = new ActionDescriptor();
            var fmt = new ActionDescriptor();
            fmt.putBoolean(stringIDToTypeID("maximizeCompatibility"), true);
            d.putObject(stringIDToTypeID("as"), charIDToTypeID("Pht8"), fmt);  // Pht8 = PSB
            d.putPath(charIDToTypeID("In  "), f);
            d.putBoolean(charIDToTypeID("LwCs"), true);
            executeAction(charIDToTypeID("save"), d, DialogModes.NO);
        } else {
            var opts = new PhotoshopSaveOptions();
            opts.layers = true;
            opts.alphaChannels = true;
            opts.embedColorProfile = true;
            opts.maximizeCompatibility = true;
            doc.saveAs(f, opts, false, Extension.LOWERCASE);
        }
        return f;
    }

    // ------------------------------------------------------------------
    // Основной блок
    // ------------------------------------------------------------------
    var oldUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;

    try {
        var i;
        var photoDir = null;

        // Диалог спрашиваем до создания документа: если нажали «Отмена»,
        // незачем плодить лишний документ
        if (CFG.showDialog) {
            var ans = askOptions(CFG);
            if (ans === null) { return; }
            CFG.slides     = ans.slides;
            CFG.slideWidth = ans.slideWidth;
            CFG.bits       = ans.bits;
            photoDir       = ans.folder;
        } else if (CFG.loadPhotos) {
            photoDir = CFG.photoFolder ? new Folder(CFG.photoFolder)
                                       : chooseFolder("Папка с фотографиями:", null);
        }

        var N  = Math.max(1, Math.round(CFG.slides));
        var SW = CFG.slideWidth;
        var W  = N * SW;
        var H  = CFG.height;

        if (!CFG.name) { CFG.name = N + " Slides"; }

        var bitsLabel = (CFG.bits === BitsPerChannelType.SIXTEEN) ? 16
                      : (CFG.bits === BitsPerChannelType.THIRTYTWO) ? 32 : 8;

        var files = [];
        if (photoDir && photoDir.exists) { files = collectFiles(photoDir, CFG.photoExt); }

        var doc = makeDoc(CFG, W);

        // ---------------------------------------------------------- слои
        if (CFG.blackLayer) {
            var black = addSolidLayer(doc, "Layer 1", CFG.blackColor);
            if (CFG.blackLayerMask) {
                doc.activeLayer = black;
                try {
                    addHideAllMask();
                } catch (eMask) {
                    alert("Не удалось создать маску на чёрном слое: " + eMask);
                }
            }
        }

        var group = null;
        if (CFG.slidesGroup) {
            group = doc.layerSets.add();
            group.name = CFG.slidesGroup;
        }

        // -------------------------------------------------- направляющие
        var frame0 = frameFor(CFG, 0);

        // границы слайдов и кадр — одним цветом
        setGuideColor(CFG.colorFrame);
        if (CFG.guideSlideBorders) {
            for (i = 0; i <= N; i++) { addGuide(doc, Direction.VERTICAL, i * SW); }
        }
        if (CFG.guideFrameH) {
            addGuide(doc, Direction.HORIZONTAL, frame0.top);
            addGuide(doc, Direction.HORIZONTAL, frame0.bottom);
        }

        // центры — другим
        setGuideColor(CFG.colorCenter);
        if (CFG.guideSlideCenters) {
            for (i = 0; i < N; i++) { addGuide(doc, Direction.VERTICAL, i * SW + SW / 2); }
        }
        if (CFG.guideCenterH) {
            addGuide(doc, Direction.HORIZONTAL, H / 2);
        }

        setGuideColor(CFG.colorRestore);

        // ------------------------------------------------------------ фото
        // по одному снимку на слайд; если снимков меньше, блок прижимается
        // к правому краю ленты — пустыми остаются слайды слева
        var placedCount = 0;
        if (files.length > 0) {

            var perSlide = seatsPerSlide(CFG);
            var cols = Math.max(1, CFG.photoCols);
            var rows = Math.max(1, CFG.photoRows);
            var cellW = SW / cols;
            var cellH = H  / rows;

            var take = Math.min(files.length, N * perSlide);

            // выравнивание идёт по слайдам, а не по отдельным ячейкам:
            // блок занимает целое число слайдов и прижимается к краю ленты
            var slidesUsed = Math.ceil(take / perSlide);
            var startSlide = (CFG.photoAlign === "left") ? 0 : (N - slidesUsed);

            for (i = 0; i < take; i++) {
                var f = files[i];
                var slide = startSlide + Math.floor(i / perSlide);
                var seat  = i % perSlide;

                try {
                    app.activeDocument = doc;
                    var lyr = placeEmbedded(f);
                    lyr.name = decodeURI(f.name);

                    if (CFG.photoMode === "frame") {
                        fitLayerToFrame(lyr, frameFor(CFG, slide));
                    } else {
                        var col = seat % cols;
                        var row = Math.floor(seat / cols);

                        var cx = slide * SW + (col + 0.5) * cellW;
                        var cy = (row + 0.5) * cellH;

                        if (CFG.photoJitter > 0) {
                            cx += (Math.random() - 0.5) * cellW * CFG.photoJitter;
                            cy += (Math.random() - 0.5) * cellH * CFG.photoJitter;
                        }

                        var angle = CFG.photoRotate
                            ? (Math.random() - 0.5) * 2 * CFG.photoRotateMax
                            : 0;

                        placeAtPoint(lyr, cx, cy, CFG.photoLongSide, angle);
                    }

                    if (group !== null) { lyr.move(group, ElementPlacement.INSIDE); }
                    placedCount++;
                } catch (ePlace) {
                    // битый или неподдерживаемый файл — пропускаем
                }
            }
            doc.selection.deselect();
        }

        // ------------------------------- корректирующий слой поверх всего
        if (CFG.channelMixer) {
            // активным должен быть верхний слой верхнего уровня, иначе
            // корректирующий слой окажется внутри группы Slides
            doc.activeLayer = (group !== null) ? group : doc.layers[0];
            try {
                addChannelMixerMono(CFG.mixerMono);
            } catch (eMix) {
                alert("Не удалось задать Channel Mixer: " + eMix +
                      "\nСлой создан со значениями по умолчанию — поправьте вручную.");
            }
        }

        var savedTo = CFG.save ? saveDoc(doc, CFG, W) : null;

        // отчёт только в консоль ExtendScript, без всплывающего окна
        $.writeln(
            "Документ: " + CFG.name + ", " + W + " x " + H + " px (" + N + " x " + SW + "), " +
            CFG.resolution + " ppi, RGB/" + bitsLabel +
            (CFG.colorProfile ? ", " + CFG.colorProfile : "") + "; " +
            "кадр " + frame0.w + " x " + frame0.h + " px (" + CFG.aspectW + ":" + CFG.aspectH + "), " +
            "y = " + frame0.top + " / " + frame0.bottom + " в первом слайде; " +
            "направляющих: " + doc.guides.length +
            (placedCount ? "; фото: " + placedCount + " из " + files.length +
                           ", выравнивание — " + CFG.photoAlign : "") +
            (savedTo ? "; сохранено: " + savedTo.fsName : "")
        );

    } catch (e) {
        alert("Ошибка: " + e + (e.line ? "\nстрока " + e.line : ""));
    } finally {
        app.preferences.rulerUnits = oldUnits;
    }

})();
