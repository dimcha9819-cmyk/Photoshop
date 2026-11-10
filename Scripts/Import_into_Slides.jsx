/**
 * insta_fill_photos.jsx
 * ------------------------------------------------------------------
 * Для документа, созданного скриптом insta_guided_2026.jsx.
 *
 * Спрашивает папку с фотографиями и раскладывает их по четырём
 * квадрантам каждого слайда по порядку:
 *
 *      +-------+-------+
 *      |   1   |   2   |
 *      +-------+-------+
 *      |   3   |   4   |
 *      +-------+-------+
 *
 * Снимок 5 уходит в первый квадрант следующего слайда и так далее.
 * Сетку можно сменить на 1 x 1 — тогда снимок занимает слайд целиком.
 *
 * Каждое фото центрируется в своей ячейке. По умолчанию масштаб идёт
 * по длинной стороне до заданного размера, но в окне можно выбрать и
 * другие режимы: заполнить ячейку по высоте, вписать целиком, закрыть
 * целиком (DEF_FIT).
 *
 * Вставка идёт смарт-объектами: масштаб обратим, качество не теряется.
 * ------------------------------------------------------------------
 */

#target photoshop
app.bringToFront();

// ===================== НАСТРОЙКИ =====================
// Расширения, которые считаем фотографиями
var EXTENSIONS = ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'psd', 'psb', 'webp'];

// Как вписывать снимок в ячейку:
//   'height' — высота снимка равна высоте ячейки, по ширине может выходить
//              за её края: кадр заполнен по вертикали без полей
//   'fit'    — целиком внутрь ячейки, по узкой стороне остаются поля
//   'fill'   — закрыть ячейку целиком, лишнее уходит за края
//   'long'   — длинная сторона приводится к DEF_LONG_SIDE
var DEF_FIT = 'long';

// Сетка внутри слайда: 2 x 2 — четыре снимка, 1 x 1 — один на весь слайд
var DEF_COLS = 2;
var DEF_ROWS = 2;

var DEF_LONG_SIDE = 1100;   // длинная сторона снимка для режима 'long', px

// Форматы слайда: ширина = высота документа * k
var RATIOS = [
	{ label: '4:5',  k: 0.8    },
	{ label: '3:4',  k: 0.75   },
	{ label: '9:16', k: 0.5625 }
];

// Префикс групп, которые Slides.jsx делает для масок по слайдам
var SLIDE_PREFIX  = 'Slide ';
var DEF_JITTER    = 0;      // случайный сдвиг, % от квадранта
var DEF_ROTATE    = false;  // случайный небольшой поворот
var ROTATE_MAX    = 6;      // максимальный угол поворота, градусы

// Что делать, когда снимков больше, чем квадрантов:
//   true  — начать со второго круга по тем же слайдам (фото лягут поверх)
//   false — остановиться, лишние не размещать
var WRAP_AROUND   = true;

var GROUP_NAME    = 'Photos';   // '' — не собирать в группу
// =====================================================


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


main();

function main() {

	if (app.documents.length === 0) {
		alert('Сначала откройте документ со слайдами.');
		return;
	}

	var doc = app.activeDocument;

	var oldUnits = app.preferences.rulerUnits;
	app.preferences.rulerUnits = Units.PIXELS;

	try {
		var W = Math.round(doc.width.as('px'));
		var H = Math.round(doc.height.as('px'));

		var detected = detectSlides(doc, W, H);

		var opts = askOptions(W, H, detected);
		if (opts === null) { return; }

		var files = collectFiles(opts.folder);
		if (files.length === 0) {
			alert('В папке нет подходящих файлов.\n\nИщем: ' + EXTENSIONS.join(', '));
			return;
		}

		layout(doc, W, H, files, opts);

	} finally {
		app.preferences.rulerUnits = oldUnits;
	}
}


// ---------- определение раскладки слайдов ----------

// Сколько групп Slide NN в документе: берём наибольший номер, так что
// пропуски в середине не занижают счёт
function countSlideGroups(doc) {
	var max = 0;

	function scan(container) {
		for (var i = 0; i < container.layerSets.length; i++) {
			var g = container.layerSets[i];
			if (g.name.indexOf(SLIDE_PREFIX) === 0) {
				var m = g.name.match(/(\d+)\s*$/);
				if (m) {
					var n = parseInt(m[1], 10);
					if (n > max) { max = n; }
				}
			}
			scan(g);
		}
	}

	scan(doc);
	return max;
}

// Группы Slide NN, разложенные по номеру слайда. null — таких групп нет.
function findSlideGroups(doc, count) {
	var found = [];
	found.length = count;
	var any = false;

	function scan(container) {
		for (var i = 0; i < container.layerSets.length; i++) {
			var g = container.layerSets[i];
			if (g.name.indexOf(SLIDE_PREFIX) === 0) {
				var m = g.name.match(/(\d+)\s*$/);
				if (m) {
					var n = parseInt(m[1], 10) - 1;
					if (n >= 0 && n < count && !found[n]) { found[n] = g; any = true; }
				}
			}
			scan(g);
		}
	}

	scan(doc);
	return any ? found : null;
}


// Шаг вертикальных направляющих: самое частое расстояние между соседними.
// Slides.jsx ставит их по границам и центрам слайдов, то есть с шагом
// в половину ширины слайда.
function guideStep(doc) {
	var xs = [];
	var i;
	for (i = 0; i < doc.guides.length; i++) {
		if (doc.guides[i].direction === Direction.VERTICAL) {
			xs.push(Math.round(doc.guides[i].coordinate.as('px')));
		}
	}
	if (xs.length < 3) { return 0; }

	xs.sort(function (a, b) { return a - b; });

	var counts = {};
	var best = 0, bestN = 0;
	for (i = 1; i < xs.length; i++) {
		var d = xs[i] - xs[i - 1];
		if (d <= 0) { continue; }
		counts[d] = (counts[d] || 0) + 1;
		if (counts[d] > bestN) { bestN = counts[d]; best = d; }
	}
	return best;
}

// Ширина слайда и их количество. Источники по убыванию надёжности:
//   1. группы Slide NN — их число и есть число слайдов;
//   2. направляющие — шаг в половину ширины слайда;
//   3. пропорции из RATIOS — последнее средство: холст 28800 px делится
//      без остатка и на 1920, и на 1440, и по одному размеру не понять,
//      что это — пятнадцать слайдов 3:4 или двадцать 9:16.
function detectSlides(doc, W, H) {

	var n = countSlideGroups(doc);
	if (n > 0 && W % n === 0) {
		return { width: W / n, count: n, how: 'по группам слайдов' };
	}

	var step = guideStep(doc);
	if (step > 0) {
		var candidates = [step * 2, step];
		for (var c = 0; c < candidates.length; c++) {
			var sw = candidates[c];
			if (sw > 0 && W % sw === 0 && W / sw > 1) {
				return { width: sw, count: W / sw, how: 'по направляющим' };
			}
		}
	}

	for (var i = 0; i < RATIOS.length; i++) {
		var rw = Math.round(H * RATIOS[i].k);
		if (rw > 0 && W % rw === 0) {
			return { width: rw, count: W / rw,
			         how: 'по пропорциям ' + RATIOS[i].label };
		}
	}
	return null;
}


// ---------- список файлов ----------

function collectFiles(folder) {

	var all = folder.getFiles();
	var out = [];

	for (var i = 0; i < all.length; i++) {

		var f = all[i];
		if (!(f instanceof File)) { continue; }

		var name = decodeURI(f.name);
		var m = name.match(/\.([^\.]+)$/);
		if (!m) { continue; }

		var ext = m[1].toLowerCase();
		for (var e = 0; e < EXTENSIONS.length; e++) {
			if (EXTENSIONS[e] === ext) { out.push(f); break; }
		}
	}

	out.sort(function (a, b) {
		var an = decodeURI(a.name).toLowerCase();
		var bn = decodeURI(b.name).toLowerCase();
		return (an < bn) ? -1 : (an > bn) ? 1 : 0;
	});

	return out;
}


// ---------- диалог ----------

function askOptions(W, H, detected) {

	var dlg = new Window('dialog', 'Заполнить слайды фотографиями');
	dlg.orientation = 'column';
	dlg.alignChildren = 'fill';
	dlg.margins = 16;
	dlg.spacing = 10;

	dlg.add('statictext', undefined, 'Документ ' + W + ' × ' + H + ' px');

	// --- папка ---
	var pnl = dlg.add('panel', undefined, 'Папка с фотографиями');
	pnl.orientation = 'row';
	pnl.alignChildren = 'center';
	pnl.margins = [12, 16, 12, 12];

	var pathField = pnl.add('edittext', undefined, '');
	pathField.preferredSize.width = 320;
	var browseBtn = pnl.add('button', undefined, 'Обзор...');

	var countLbl = dlg.add('statictext', undefined, '');
	countLbl.preferredSize.width = 420;

	var chosen = null;
	var found = 0;

	// --- параметры ---
	var p2 = dlg.add('panel', undefined, 'Размещение');
	p2.orientation = 'column';
	p2.alignChildren = 'fill';
	p2.margins = [12, 16, 12, 12];
	p2.spacing = 8;

	var gSlides = p2.add('group');
	gSlides.add('statictext', undefined, 'Слайдов:').preferredSize.width = 110;
	var slidesField = gSlides.add('edittext', undefined,
	                              String(detected === null ? 1 : detected.count));
	slidesField.preferredSize.width = 60;
	var slidesHint = gSlides.add('statictext', undefined, '');
	slidesHint.preferredSize.width = 240;

	var gGrid = p2.add('group');
	gGrid.add('statictext', undefined, 'Сетка в слайде:').preferredSize.width = 110;
	var colsField = gGrid.add('edittext', undefined, String(DEF_COLS));
	colsField.preferredSize.width = 34;
	gGrid.add('statictext', undefined, 'x');
	var rowsField = gGrid.add('edittext', undefined, String(DEF_ROWS));
	rowsField.preferredSize.width = 34;
	var gridHint = gGrid.add('statictext', undefined, '');
	gridHint.preferredSize.width = 200;

	var FITS = [
		{ key: 'height', label: 'Заполнить по высоте ячейки' },
		{ key: 'fit',    label: 'Вписать целиком' },
		{ key: 'fill',   label: 'Закрыть ячейку целиком' },
		{ key: 'long',   label: 'По длинной стороне' }
	];

	var gFit = p2.add('group');
	gFit.add('statictext', undefined, 'Размер снимка:').preferredSize.width = 110;
	var fitList = gFit.add('dropdownlist', undefined, (function () {
		var out = [];
		for (var k = 0; k < FITS.length; k++) { out.push(FITS[k].label); }
		return out;
	})());
	fitList.preferredSize.width = 250;
	fitList.selection = 0;
	for (var fi = 0; fi < FITS.length; fi++) {
		if (FITS[fi].key === DEF_FIT) { fitList.selection = fi; break; }
	}

	var gLong = p2.add('group');
	var longName = gLong.add('statictext', undefined, 'Длинная сторона:');
	longName.preferredSize.width = 110;
	var longField = gLong.add('edittext', undefined, String(DEF_LONG_SIDE));
	longField.preferredSize.width = 60;
	var longUnit = gLong.add('statictext', undefined, 'px');

	var gJit = p2.add('group');
	gJit.add('statictext', undefined, 'Разброс:').preferredSize.width = 110;
	var sJit = gJit.add('slider', undefined, DEF_JITTER, 0, 40);
	sJit.preferredSize.width = 200;
	var lJit = gJit.add('statictext', undefined, '');
	lJit.preferredSize.width = 45;

	var cbRot = p2.add('checkbox', undefined, 'Случайный поворот до ' + ROTATE_MAX + '°');
	cbRot.value = DEF_ROTATE;

	var btns = dlg.add('group');
	btns.alignment = 'right';
	btns.add('button', undefined, 'Отмена', {name: 'cancel'});
	btns.add('button', undefined, 'Заполнить', {name: 'ok'});

	function slideCount() {
		var n = parseInt(slidesField.text, 10);
		return (isNaN(n) || n < 1) ? 1 : n;
	}

	function gridCols() {
		var v = parseInt(colsField.text, 10);
		return (isNaN(v) || v < 1) ? 1 : v;
	}

	function gridRows() {
		var v = parseInt(rowsField.text, 10);
		return (isNaN(v) || v < 1) ? 1 : v;
	}

	function fitKey() { return FITS[fitList.selection.index].key; }

	function refresh() {
		var n = slideCount();
		var cols = gridCols();
		var rows = gridRows();
		var per = cols * rows;

		var qw = Math.round(W / n / cols);
		var qh = Math.round(H / rows);

		gridHint.text = (per === 1) ? 'снимок на весь слайд' : (per + ' на слайд');
		slidesHint.text = 'ячейка ' + qw + ' × ' + qh + ' px, мест: ' + (n * per);
		lJit.text = Math.round(sJit.value) + ' %';

		// размер в пикселях нужен только режиму «по длинной стороне»
		var byLong = (fitKey() === 'long');
		longName.enabled  = byLong;
		longField.enabled = byLong;
		longUnit.enabled  = byLong;

		if (chosen === null) {
			countLbl.text = '';
		} else {
			var cap = n * per;
			var tail = '';
			if (found > cap) {
				tail = WRAP_AROUND
					? ' — мест ' + cap + ', лишние лягут вторым слоем'
					: ' — мест ' + cap + ', лишние не разместятся';
			}
			countLbl.text = 'Найдено фотографий: ' + found + tail;
		}
	}

	function setFolder(f) {
		chosen = f;
		if (f === null) {
			pathField.text = '';
			found = 0;
		} else {
			pathField.text = f.fsName;
			found = collectFiles(f).length;
		}
		refresh();
	}

	browseBtn.onClick = function () {
		var f = chooseFolder('Папка с фотографиями:', chosen);
		if (f !== null) { setFolder(f); }
	};

	pathField.onChange = function () {
		var f = new Folder(pathField.text);
		setFolder(f.exists ? f : null);
	};

	slidesField.onChanging = refresh;
	colsField.onChanging   = refresh;
	rowsField.onChanging   = refresh;
	fitList.onChange       = refresh;
	sJit.onChanging        = refresh;
	refresh();

	if (dlg.show() !== 1) { return null; }

	if (chosen === null || !chosen.exists) {
		alert('Папка не выбрана.');
		return null;
	}

	var longSide = parseInt(longField.text, 10);
	if (fitKey() === 'long' && (isNaN(longSide) || longSide < 1)) {
		alert('Длинная сторона задана неверно.');
		return null;
	}
	if (isNaN(longSide) || longSide < 1) { longSide = DEF_LONG_SIDE; }

	return {
		folder:   chosen,
		slides:   slideCount(),
		cols:     gridCols(),
		rows:     gridRows(),
		fit:      fitKey(),
		longSide: longSide,
		jitter:   Math.round(sJit.value) / 100,
		rotate:   cbRot.value
	};
}


// ---------- раскладка ----------

function layout(doc, W, H, files, opts) {

	var slideW = W / opts.slides;
	var cols = Math.max(1, opts.cols);
	var rows = Math.max(1, opts.rows);

	var quadW  = slideW / cols;
	var quadH  = H / rows;

	// размер ячейки нужен и при вписывании снимка
	opts.cellW = quadW;
	opts.cellH = quadH;

	var perSlide = cols * rows;
	var capacity = opts.slides * perSlide;

	// Если документ собран с масками по слайдам, снимок должен лечь
	// в группу своего слайда — иначе маска его не обрежет
	var slideGroups = findSlideGroups(doc, opts.slides);

	var group = null;
	if (slideGroups === null && GROUP_NAME !== '') {
		group = doc.layerSets.add();
		group.name = GROUP_NAME;
	}

	for (var i = 0; i < files.length; i++) {

		if (i >= capacity && !WRAP_AROUND) { break; }

		var seat  = i % capacity;                 // место в общей сетке слайдов
		var slide = Math.floor(seat / perSlide);  // номер слайда
		var q     = seat % perSlide;              // ячейка внутри слайда

		var col = q % cols;
		var row = Math.floor(q / cols);

		var cx = slide * slideW + (col + 0.5) * quadW;
		var cy = (row + 0.5) * quadH;

		if (opts.jitter > 0) {
			cx += (Math.random() - 0.5) * quadW * opts.jitter;
			cy += (Math.random() - 0.5) * quadH * opts.jitter;
		}

		var box = (slideGroups !== null && slideGroups[slide])
		        ? slideGroups[slide] : group;

		placePhoto(doc, files[i], cx, cy, opts, box);
	}

	doc.selection.deselect();
}


// Во сколько раз увеличить снимок lw x lh, чтобы он лёг в ячейку
// cellW x cellH по выбранному режиму. Возвращает проценты.
function scaleFor(mode, lw, lh, cellW, cellH, longSide) {
	if (mode === 'height') { return cellH / lh * 100; }
	if (mode === 'fit')    { return Math.min(cellW / lw, cellH / lh) * 100; }
	if (mode === 'fill')   { return Math.max(cellW / lw, cellH / lh) * 100; }
	return longSide / Math.max(lw, lh) * 100;   // 'long'
}


// Вставка снимка смарт-объектом с центрированием в ячейке
function placePhoto(doc, file, cx, cy, opts, group) {

	app.activeDocument = doc;

	try {
		placeSmartObject(file);
	} catch (e) {
		return;   // битый или неподдерживаемый файл — пропускаем
	}

	var lyr = doc.activeLayer;
	lyr.name = decodeURI(file.name);

	var b = lyr.bounds;
	var lw = b[2].as('px') - b[0].as('px');
	var lh = b[3].as('px') - b[1].as('px');
	if (lw < 1 || lh < 1) { return; }

	// Пропорции сохраняются всегда, меняется только способ вписывания
	var scale = scaleFor(opts.fit, lw, lh, opts.cellW, opts.cellH, opts.longSide);
	lyr.resize(scale, scale, AnchorPosition.MIDDLECENTER);

	if (opts.rotate) {
		lyr.rotate((Math.random() - 0.5) * 2 * ROTATE_MAX, AnchorPosition.MIDDLECENTER);
	}

	b = lyr.bounds;
	var curX = (b[0].as('px') + b[2].as('px')) / 2;
	var curY = (b[1].as('px') + b[3].as('px')) / 2;
	lyr.translate(cx - curX, cy - curY);

	if (group !== null) {
		lyr.move(group, ElementPlacement.INSIDE);
	}
}


// Файл → смарт-объект по центру холста
function placeSmartObject(file) {

	var desc = new ActionDescriptor();
	desc.putPath(charIDToTypeID('null'), file);
	desc.putEnumerated(charIDToTypeID('FTcs'), charIDToTypeID('QCSt'), charIDToTypeID('Qcsa'));

	var ofs = new ActionDescriptor();
	ofs.putUnitDouble(charIDToTypeID('Hrzn'), charIDToTypeID('#Pxl'), 0);
	ofs.putUnitDouble(charIDToTypeID('Vrtc'), charIDToTypeID('#Pxl'), 0);
	desc.putObject(charIDToTypeID('Ofst'), charIDToTypeID('Ofst'), ofs);

	desc.putBoolean(charIDToTypeID('Lnkd'), false);

	executeAction(charIDToTypeID('Plc '), desc, DialogModes.NO);
}
