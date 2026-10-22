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
 * Каждое фото масштабируется по длинной стороне до заданного размера
 * (по умолчанию 1100 px) и центрируется в своём квадранте.
 *
 * Вставка идёт смарт-объектами: масштаб обратим, качество не теряется.
 * ------------------------------------------------------------------
 */

#target photoshop
app.bringToFront();

// ===================== НАСТРОЙКИ =====================
// Расширения, которые считаем фотографиями
var EXTENSIONS = ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'psd', 'psb', 'webp'];

var DEF_LONG_SIDE = 1100;   // длинная сторона снимка, px
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

		var detected = detectSlides(W, H);

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

// Документ insta_guided_2026: ширина кратна ширине кадра,
// кадр = высота * 0.8 (4:5) или высота * 0.75 (3:4)
function detectSlides(W, H) {

	var candidates = [Math.round(H * 0.8), Math.round(H * 0.75)];

	for (var i = 0; i < candidates.length; i++) {
		var sw = candidates[i];
		if (sw > 0 && W % sw === 0) {
			return { width: sw, count: W / sw };
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

	var gLong = p2.add('group');
	gLong.add('statictext', undefined, 'Длинная сторона:').preferredSize.width = 110;
	var longField = gLong.add('edittext', undefined, String(DEF_LONG_SIDE));
	longField.preferredSize.width = 60;
	gLong.add('statictext', undefined, 'px');

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

	function refresh() {
		var n = slideCount();
		var qw = Math.round(W / n / 2);
		var qh = Math.round(H / 2);
		slidesHint.text = 'квадрант ' + qw + ' × ' + qh + ' px, мест: ' + (n * 4);
		lJit.text = Math.round(sJit.value) + ' %';

		if (chosen === null) {
			countLbl.text = '';
		} else {
			var cap = n * 4;
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
	sJit.onChanging = refresh;
	refresh();

	if (dlg.show() !== 1) { return null; }

	if (chosen === null || !chosen.exists) {
		alert('Папка не выбрана.');
		return null;
	}

	var longSide = parseInt(longField.text, 10);
	if (isNaN(longSide) || longSide < 1) {
		alert('Длинная сторона задана неверно.');
		return null;
	}

	return {
		folder:   chosen,
		slides:   slideCount(),
		longSide: longSide,
		jitter:   Math.round(sJit.value) / 100,
		rotate:   cbRot.value
	};
}


// ---------- раскладка ----------

function layout(doc, W, H, files, opts) {

	var slideW = W / opts.slides;
	var quadW  = slideW / 2;
	var quadH  = H / 2;

	var capacity = opts.slides * 4;

	var group = null;
	if (GROUP_NAME !== '') {
		group = doc.layerSets.add();
		group.name = GROUP_NAME;
	}

	for (var i = 0; i < files.length; i++) {

		if (i >= capacity && !WRAP_AROUND) { break; }

		var seat  = i % capacity;          // место в общей сетке слайдов
		var slide = Math.floor(seat / 4);  // номер слайда
		var q     = seat % 4;              // квадрант: 0 1 / 2 3

		var col = q % 2;
		var row = Math.floor(q / 2);

		var cx = slide * slideW + (col + 0.5) * quadW;
		var cy = (row + 0.5) * quadH;

		if (opts.jitter > 0) {
			cx += (Math.random() - 0.5) * quadW * opts.jitter;
			cy += (Math.random() - 0.5) * quadH * opts.jitter;
		}

		placePhoto(doc, files[i], cx, cy, opts, group);
	}

	doc.selection.deselect();
}


// Вставка снимка смарт-объектом, масштаб по длинной стороне
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

	// Длинная сторона приводится к заданному размеру, пропорции сохраняются
	var scale = opts.longSide / Math.max(lw, lh) * 100;
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
