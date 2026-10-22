/**
 * Скрипт: insta_26stripes.jsx
 * Описание:
 *  - Делит выделенную прямоугольную область на полосы: горизонтальные
 *    или вертикальные — ориентация выбирается при запуске.
 *  - Количество задаётся ползунком, свой диапазон на каждую ориентацию.
 *  - Для каждого сегмента создаётся отдельный слой с заливкой.
 *  - Заливка однотонная: hue = 0, saturation = 0, brightness плавно
 *    убывает от BRIGHT_FROM до BRIGHT_TO.
 *      горизонталь: светлая снизу, вверх темнеет (H_FROM);
 *      вертикаль:   светлая слева, вправо темнеет (V_FROM).
 *  - Слои нумеруются по месту: 1 — верхняя полоса или левая колонка,
 *    независимо от направления заливки.
 *
 * Объединяет прежние insta_26stripes.jsx и insta_26columns.jsx.
 */

(function () {

	// ---------- настройки ----------

	// Диапазон и значение по умолчанию для каждой ориентации
	var HORIZ = { min: 2, max: 6, def: 4 };   // полос
	var VERT  = { min: 2, max: 6, def: 4 };   // колонок

	var BRIGHT_FROM = 80;      // яркость первого сегмента, %
	var BRIGHT_TO   = 20;      // яркость последнего, %

	// С какого края начинается светлый сегмент
	var H_FROM = 'bottom';     // 'bottom' | 'top'
	var V_FROM = 'left';       // 'left'   | 'right'

	var H_PREFIX = 'Полоса ';
	var V_PREFIX = 'Колонка ';

	// Что предложить в диалоге: 'h' — полосы, 'v' — колонки
	var DEFAULT_ORIENTATION = 'h';

	// -------------------------------

	if (app.documents.length === 0) {
		alert("Нет открытых документов.");
		return;
	}

	var doc = app.activeDocument;

	// Работаем строго в пикселях, иначе selection.select() поймёт координаты
	// в текущих единицах линейки и построит прямоугольники не там
	var oldUnits = app.preferences.rulerUnits;
	app.preferences.rulerUnits = Units.PIXELS;

	try {

		// Проверка наличия выделения в активном документе
		var selBounds;
		try {
			selBounds = doc.selection.bounds;
		} catch (e) {
			alert("Нет активного выделения. Выделите прямоугольную область перед запуском скрипта.");
			return;
		}

		// Координаты выделения (левый, верхний, правый, нижний) в пикселях
		var left   = Math.round(selBounds[0].as("px"));
		var top    = Math.round(selBounds[1].as("px"));
		var right  = Math.round(selBounds[2].as("px"));
		var bottom = Math.round(selBounds[3].as("px"));

		var fullWidth  = right - left;
		var fullHeight = bottom - top;

		// ---------------------------------------------------------- диалог

		var dlg = new Window("dialog", "Разделить выделение");
		dlg.orientation = "column";
		dlg.alignChildren = "fill";
		dlg.margins = 16;
		dlg.spacing = 10;

		dlg.add("statictext", undefined,
		        "Выделение: " + fullWidth + " x " + fullHeight + " px");

		var pnl = dlg.add("panel", undefined, "Ориентация");
		pnl.orientation = "column";
		pnl.alignChildren = "left";
		pnl.margins = [12, 16, 12, 12];

		var rbH = pnl.add("radiobutton", undefined, "Горизонтальные полосы");
		var rbV = pnl.add("radiobutton", undefined, "Вертикальные колонки");
		rbH.value = (DEFAULT_ORIENTATION !== 'v');
		rbV.value = !rbH.value;

		var capt = dlg.add("statictext", undefined, "");

		var sliderGroup = dlg.add("group");
		sliderGroup.orientation = "row";
		var slider = sliderGroup.add("slider", undefined, HORIZ.def, HORIZ.min, HORIZ.max);
		slider.preferredSize.width = 220;
		var sliderValue = sliderGroup.add("statictext", undefined, "");
		sliderValue.preferredSize.width = 24;

		var hint = dlg.add("statictext", undefined, "");

		function isHoriz() { return rbH.value; }
		function cfg()     { return isHoriz() ? HORIZ : VERT; }
		function count()   { return Math.round(slider.value); }

		// Переключение ориентации переносит ползунок на свой диапазон
		function setOrientation() {
			var c = cfg();
			var keep = count();

			slider.minvalue = c.min;
			slider.maxvalue = c.max;

			// держимся за прежнее число, если оно укладывается в новый диапазон
			if (keep < c.min || keep > c.max) { keep = c.def; }
			slider.value = keep;

			capt.text = isHoriz()
			          ? "На сколько полос делить область? (от " + c.min + " до " + c.max + ")"
			          : "На сколько колонок делить область? (от " + c.min + " до " + c.max + ")";
			refresh();
		}

		function refresh() {
			var n = count();
			sliderValue.text = n;
			hint.text = isHoriz()
			          ? "Высота полосы: ~" + Math.round(fullHeight / n) + " px"
			          : "Ширина колонки: ~" + Math.round(fullWidth / n) + " px";
		}

		slider.onChanging = refresh;
		rbH.onClick = setOrientation;
		rbV.onClick = setOrientation;

		// стартовое состояние: ползунок должен встать на диапазон своей ориентации
		slider.value = cfg().def;
		setOrientation();

		var btnGroup = dlg.add("group");
		btnGroup.alignment = "center";
		btnGroup.add("button", undefined, "OK", {name: "ok"});
		btnGroup.add("button", undefined, "Отмена", {name: "cancel"});

		if (dlg.show() != 1) {
			// Пользователь нажал Отмена
			return;
		}

		// -------------------------------------------------------- нарезка

		var horiz    = isHoriz();
		var pieces   = count();
		var prefix   = horiz ? H_PREFIX : V_PREFIX;

		// ось деления: для полос — вертикальная, для колонок — горизонтальная
		var axisFrom = horiz ? top    : left;
		var axisTo   = horiz ? bottom : right;
		var axisSize = axisTo - axisFrom;

		if (axisSize < pieces) {
			alert("Выделение слишком маленькое для " + pieces + " сегментов.");
			return;
		}

		// идём ли от дальнего края: светлый сегмент внизу или справа
		var reversed = horiz ? (H_FROM === 'bottom') : (V_FROM === 'right');

		var brightnessStep = (BRIGHT_FROM - BRIGHT_TO) / (pieces - 1);

		for (var i = 0; i < pieces; i++) {

			// Границы считаем накопительно от общего размера,
			// иначе на округлении между сегментами остаются щели в 1 px
			var offA = Math.round(axisSize * i / pieces);
			var offB = Math.round(axisSize * (i + 1) / pieces);

			var segA, segB;
			if (reversed) {
				segA = axisTo - offB;
				segB = axisTo - offA;
			} else {
				segA = axisFrom + offA;
				segB = axisFrom + offB;
			}

			// Новый слой под текущий сегмент.
			// Нумерация по месту: 1 — верхняя полоса или левая колонка
			var newLayer = doc.artLayers.add();
			newLayer.name = prefix + (reversed ? (pieces - i) : (i + 1));
			doc.activeLayer = newLayer;

			// Прямоугольник сегмента
			var rectCoords = horiz
				? [ [ left,  segA ], [ right, segA ], [ right, segB ], [ left,  segB ] ]
				: [ [ segA,  top  ], [ segB,  top  ], [ segB,  bottom ], [ segA, bottom ] ];

			doc.selection.select(rectCoords);

			// Яркость: первый сегмент — BRIGHT_FROM, каждый следующий темнее
			var currentBrightness = BRIGHT_FROM - (i * brightnessStep);

			var fillColor = new SolidColor();
			fillColor.hsb.hue = 0;
			fillColor.hsb.saturation = 0;
			fillColor.hsb.brightness = currentBrightness;

			doc.selection.fill(fillColor, ColorBlendMode.NORMAL, 100, false);
			doc.selection.deselect();
		}

	} finally {
		app.preferences.rulerUnits = oldUnits;
	}
})();
