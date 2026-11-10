#target photoshop
app.bringToFront();

// ===================== НАСТРОЙКИ =====================
// Добавлять имя PSD к именам слайдов: Portret_01.jpg вместо 01.jpg
var NAME_PREFIX = true;

// Минимальное число разрядов в номере: 2 -> 01, 02 ... 3 -> 001, 002
// Если слайдов больше, разрядность увеличивается автоматически.
var PAD_WIDTH   = 2;

var JPEG_QUALITY = 10;      // 1..12

// Префикс групп, которые Slides.jsx делает для масок по слайдам
var SLIDE_PREFIX = 'Slide ';
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

// Проверка наличия открытого документа
if (app.documents.length === 0) {
	alert("Сначала открой документ.");
	return;
}

var originalDoc = app.activeDocument;

var docWidth  = Math.round(originalDoc.width.as("px"));
var docHeight = Math.round(originalDoc.height.as("px"));

// Доля ширины слайда от высоты документа для каждого формата
var RATIOS = [
	{ label: "4:5",  k: 0.8    },
	{ label: "3:4",  k: 0.75   },
	{ label: "9:16", k: 0.5625 }
];

function sliceWidthFor(ratio) {
	for (var i = 0; i < RATIOS.length; i++) {
		if (RATIOS[i].label === ratio) { return Math.round(docHeight * RATIOS[i].k); }
	}
	return Math.round(docHeight * RATIOS[0].k);
}

// Сколько групп Slide NN в документе: берём наибольший номер
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

// Шаг вертикальных направляющих: Slides.jsx ставит их по границам и
// центрам слайдов, то есть с шагом в половину ширины слайда
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

// Ширина слайда по самому документу, без догадок о пропорциях
function detectSlideWidth(doc, W, H) {
	var n = countSlideGroups(doc);
	if (n > 0 && W % n === 0) { return { width: W / n, count: n }; }

	var step = guideStep(doc);
	if (step > 0) {
		var candidates = [step * 2, step];
		for (var c = 0; c < candidates.length; c++) {
			var sw = candidates[c];
			if (sw > 0 && W % sw === 0 && W / sw > 1) {
				return { width: sw, count: W / sw };
			}
		}
	}
	return null;
}


// --- Диалог ---
var dlg = new Window("dialog", "Выбор формата нарезки");
dlg.orientation = "column";
dlg.alignChildren = "left";
dlg.margins = 16;
dlg.spacing = 10;

// Каждый набор переключателей — в своём контейнере. ScriptUI группирует
// radiobutton по родителю, и без этого выбор формата сбрасывался бы при
// щелчке по «Все слайды».
var pRatio = dlg.add("panel", undefined, "Соотношение сторон");
pRatio.orientation = "column";
pRatio.alignChildren = "left";
pRatio.margins = [12, 16, 12, 12];

var rbRatio = [];
for (var ri = 0; ri < RATIOS.length; ri++) {
	rbRatio.push(pRatio.add("radiobutton", undefined,
	             RATIOS[ri].label + "  (" + sliceWidthFor(RATIOS[ri].label) + " px)"));
}
rbRatio[0].value = true; // значение по умолчанию

// Формат, под который собран документ. По одним пропорциям не понять:
// холст 28800 px делится без остатка и на 1920 (пятнадцать слайдов 3:4),
// и на 1440 (двадцать 9:16). Поэтому сперва спрашиваем сам документ —
// группы Slide NN и направляющие, — и лишь потом считаем доли высоты.
var detectedW = detectSlideWidth(originalDoc, docWidth, docHeight);
var matched = false;

if (detectedW !== null) {
	for (ri = 0; ri < RATIOS.length; ri++) {
		if (sliceWidthFor(RATIOS[ri].label) === detectedW.width) {
			rbRatio[ri].value = true;
			matched = true;
			break;
		}
	}
}

// Документ не отвечает или собран с нестандартной шириной слайда —
// возвращаемся к прежнему способу: первый формат, на который ширина
// холста делится без остатка
if (!matched) {
	for (ri = 0; ri < RATIOS.length; ri++) {
		if (docWidth % sliceWidthFor(RATIOS[ri].label) === 0) {
			rbRatio[ri].value = true;
			break;
		}
	}
}

function ratioValue() {
	for (var j = 0; j < rbRatio.length; j++) {
		if (rbRatio[j].value) { return RATIOS[j].label; }
	}
	return RATIOS[0].label;
}

var info = dlg.add("statictext", undefined, "");
info.preferredSize.width = 260;

var pWhich = dlg.add("panel", undefined, "Какие слайды сохранять");
pWhich.orientation = "column";
pWhich.alignChildren = "left";
pWhich.margins = [12, 16, 12, 12];

var rbAll = pWhich.add("radiobutton", undefined, "Все слайды");
var rbSel = pWhich.add("radiobutton", undefined, "Выбранные:");
rbAll.value = true;

var listField = pWhich.add("edittext", undefined, "");
listField.preferredSize.width = 260;
listField.enabled = false;

var hint = pWhich.add("statictext", undefined, "Например: 1,3,5-7");

var btnGroup = dlg.add("group");
btnGroup.alignment = "right";
btnGroup.add("button", undefined, "OK", {name: "ok"});
btnGroup.add("button", undefined, "Отмена", {name: "cancel"});

function refresh() {
	var ratio = ratioValue();
	var sw = sliceWidthFor(ratio);
	var n = Math.ceil(docWidth / sw);
	var tail = (docWidth % sw === 0) ? "" : ", последний срез " + (docWidth % sw) + " px";
	info.text = "Срез " + sw + " px, всего слайдов: " + n + tail;
	listField.enabled = rbSel.value;
}

for (ri = 0; ri < rbRatio.length; ri++) { rbRatio[ri].onClick = refresh; }
rbAll.onClick = refresh;
rbSel.onClick = function () { refresh(); listField.active = true; };
refresh();

if (dlg.show() !== 1) {
	return;
}

var ratioChoice = ratioValue();
var sliceWidth  = sliceWidthFor(ratioChoice);
var numSlices   = Math.ceil(docWidth / sliceWidth);

// --- Какие слайды резать ---
var wanted;
if (rbAll.value) {
	wanted = [];
	for (var k = 1; k <= numSlices; k++) { wanted.push(k); }
} else {
	wanted = parseSlideList(listField.text, numSlices);
	if (wanted === null) { return; }
	if (wanted.length === 0) {
		alert("Не выбрано ни одного слайда.");
		return;
	}
}

// --- Куда сохранять ---
var exportFolder = resolveExportFolder(originalDoc);
if (exportFolder === null) { return; }

var baseName = originalDoc.name.replace(/\.[^\.]+$/, "");
var prefix = NAME_PREFIX ? (baseName + "_") : "";

// Разрядность номера: не меньше PAD_WIDTH, но хватает на все слайды
var padWidth = Math.max(PAD_WIDTH, String(numSlices).length);

// Работаем строго в пикселях, иначе selection.select() поймёт координаты
// в текущих единицах линейки
var oldUnits = app.preferences.rulerUnits;
app.preferences.rulerUnits = Units.PIXELS;

var tempDoc = null;

try {

	// Дублируем документ и сплющиваем
	tempDoc = originalDoc.duplicate("SlicingTemp", false);
	tempDoc.flatten();

	// Нарезка и экспорт
	for (var w = 0; w < wanted.length; w++) {

		var i = wanted[w] - 1;          // индекс с нуля

		var left = i * sliceWidth;
		var right = left + sliceWidth;
		if (right > docWidth) right = docWidth;

		var widthToCopy = right - left;
		if (widthToCopy < 1) { continue; }

		app.activeDocument = tempDoc;
		tempDoc.selection.deselect();
		tempDoc.selection.select([
			[left, 0],
			[right, 0],
			[right, docHeight],
			[left, docHeight]
		]);
		tempDoc.selection.copy();

		var newDoc = app.documents.add(widthToCopy, docHeight, originalDoc.resolution,
		                               "slide_" + (i + 1), NewDocumentMode.RGB, DocumentFill.WHITE);
		newDoc.paste();

		var pastedLayer = newDoc.activeLayer;
		pastedLayer.translate(-pastedLayer.bounds[0], -pastedLayer.bounds[1]);

		// Файл с таким именем перезаписывается
		var jpgFile = new File(exportFolder.fsName + "/" + prefix + pad(i + 1, padWidth) + ".jpg");
		var jpgOptions = new JPEGSaveOptions();
		jpgOptions.quality = JPEG_QUALITY;
		jpgOptions.formatOptions = FormatOptions.STANDARDBASELINE;
		jpgOptions.embedColorProfile = true;

		newDoc.saveAs(jpgFile, jpgOptions, true);
		newDoc.close(SaveOptions.DONOTSAVECHANGES);
	}

} finally {
	if (tempDoc !== null) {
		try { tempDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
	}
	try { app.activeDocument = originalDoc; } catch (e) {}
	app.preferences.rulerUnits = oldUnits;
}

}


// Номер с ведущими нулями: 1 -> "01", 12 -> "12"
function pad(n, width) {
	var s = String(n);
	while (s.length < width) { s = "0" + s; }
	return s;
}


// Разбор строки вида "1,3,5-7" в массив номеров без повторов
function parseSlideList(text, maxN) {

	if (text === null) { text = ""; }

	var parts = text.split(",");
	var seen = {};
	var out = [];

	for (var i = 0; i < parts.length; i++) {

		var piece = parts[i].replace(/^\s+|\s+$/g, "");
		if (piece === "") { continue; }

		var m = piece.match(/^(\d+)\s*[-\u2013\u2014]\s*(\d+)$/);
		var from, to;

		if (m) {
			from = parseInt(m[1], 10);
			to   = parseInt(m[2], 10);
			if (from > to) { var t = from; from = to; to = t; }
		} else if (/^\d+$/.test(piece)) {
			from = to = parseInt(piece, 10);
		} else {
			alert('Не понял запись "' + piece + '".\n\nДопустимо: 1,3,5-7');
			return null;
		}

		if (from < 1 || to > maxN) {
			alert('Слайд "' + piece + '" вне диапазона.\nДоступны слайды с 1 по ' + maxN + '.');
			return null;
		}

		for (var n = from; n <= to; n++) {
			if (!seen[n]) { seen[n] = true; out.push(n); }
		}
	}

	out.sort(function (a, b) { return a - b; });
	return out;
}


// Папка экспорта: рядом с PSD, а для несохранённого документа — спросить
function resolveExportFolder(doc) {

	var base = null;

	try {
		base = doc.path;                    // бросит ошибку, если файл ни разу не сохранён
	} catch (e) {
		base = null;
	}

	if (base === null) {
		var picked = chooseFolder("Документ не сохранён. Выберите папку для слайдов:");
		if (picked === null) { return null; }   // нажали Отмена
		base = picked;
	}

	return new Folder(base.fsName);
}
