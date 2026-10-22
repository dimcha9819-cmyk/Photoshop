/*
    Stroke_Inside_10px.jsx  (Auto Stroke)
    ------------------------------------------------------------------
    Строит белую внутреннюю обводку по УЖЕ СУЩЕСТВУЮЩЕМУ выделению.
    Толщина = 1 % от длинной стороны ВЫДЕЛЕННОЙ ОБЛАСТИ, а не
    фиксируется в пикселях: рамка пропорциональна тому, что обводится.

    По умолчанию обводка кладётся на новый пустой слой, чтобы не портить
    пиксели исходного слоя. Переключается настройкой NEW_LAYER.
    ------------------------------------------------------------------
*/

#target photoshop

// ===================== НАСТРОЙКИ =====================
var WIDTH_PERCENT  = 1;         // толщина обводки, %

// От чего считать процент:
//   'short'   — короткая сторона габаритов выделения
//   'long'    — длинная сторона (по умолчанию)
//   'average' — среднее сторон
//   'diag'    — диагональ
var WIDTH_BASIS    = 'long';

// База отсчёта:
//   'selection' — габариты выделенной области
//   'canvas'    — весь холст (прежнее поведение)
var WIDTH_SOURCE   = 'selection';

var MIN_PX         = 1;         // нижняя граница толщины, px
var MAX_PX         = 0;         // верхняя граница, px (0 — без ограничения)

var COLOR_RGB      = [255, 255, 255];   // белый
var OPACITY        = 100;       // непрозрачность обводки, %
var NEW_LAYER      = true;      // true — на новый слой, false — на текущий
var LAYER_NAME     = 'Stroke';  // имя нового слоя
var DESELECT_AFTER = false;     // true — снимать выделение после обводки
// =====================================================

main();

// Габариты выделения в пикселях: [ширина, высота]
function selectionSize(doc) {
    var b = doc.selection.bounds;   // [left, top, right, bottom]
    return [Math.abs(b[2].as('px') - b[0].as('px')),
            Math.abs(b[3].as('px') - b[1].as('px'))];
}

// Толщина обводки в пикселях
function strokeWidth(doc) {

    var W, H;
    if (WIDTH_SOURCE === 'canvas') {
        W = doc.width.as('px');
        H = doc.height.as('px');
    } else {
        var s = selectionSize(doc);
        W = s[0]; H = s[1];
    }

    var basis;
    if (WIDTH_BASIS === 'long') {
        basis = Math.max(W, H);
    } else if (WIDTH_BASIS === 'average') {
        basis = (W + H) / 2;
    } else if (WIDTH_BASIS === 'diag') {
        basis = Math.sqrt(W * W + H * H);
    } else {
        basis = Math.min(W, H);
    }

    var px = Math.round(basis * WIDTH_PERCENT / 100);

    if (px < MIN_PX) { px = MIN_PX; }
    if (MAX_PX > 0 && px > MAX_PX) { px = MAX_PX; }

    // Обводка внутрь не может быть толще половины выделения
    var lim = Math.floor(Math.min(W, H) / 2);
    if (lim < 1) { lim = 1; }
    if (px > lim) { px = lim; }

    return px;
}

function main() {

    if (app.documents.length === 0) {
        alert('Нет открытых документов.');
        return;
    }

    var doc = app.activeDocument;

    // Проверяем, есть ли активное выделение
    var hasSelection = true;
    try {
        var b = doc.selection.bounds;
    } catch (e) {
        hasSelection = false;
    }

    if (!hasSelection) {
        alert('Нет активного выделения.\nВыделите область и запустите экшен снова.');
        return;
    }

    var oldUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;

    var created = null;

    try {
        var width = strokeWidth(doc);
        var color = new SolidColor();
        color.rgb.red   = COLOR_RGB[0];
        color.rgb.green = COLOR_RGB[1];
        color.rgb.blue  = COLOR_RGB[2];

        if (NEW_LAYER) {
            created = doc.artLayers.add();
            created.name = LAYER_NAME;
            doc.activeLayer = created;
        }

        doc.selection.stroke(color,
                             width,
                             StrokeLocation.INSIDE,
                             ColorBlendMode.NORMAL,
                             OPACITY,
                             false);

        if (DESELECT_AFTER) {
            doc.selection.deselect();
        }

    } catch (err) {
        // Если обводку положить не удалось — убираем за собой пустой слой
        if (created !== null) {
            try { created.remove(); } catch (e2) {}
        }
        alert('Не удалось построить обводку:\n' + err +
              '\n\nВозможные причины: активный слой — смарт-объект, ' +
              'корректирующий или текстовый слой, либо слой заблокирован.');
    } finally {
        app.preferences.rulerUnits = oldUnits;
    }
}
