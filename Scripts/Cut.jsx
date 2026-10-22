#target photoshop
app.bringToFront();

// ===================== НАСТРОЙКИ =====================
// Добавлять имя PSD к именам слайдов: Portret_01.jpg вместо 01.jpg
var NAME_PREFIX = true;

// Минимальное число разрядов в номере: 2 -> 01, 02 ... 3 -> 001, 002
// Если слайдов больше, разрядность увеличивается автоматически.
var PAD_WIDTH   = 2;

var JPEG_QUALITY = 10;      // 1..12
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

// Ширина среза для каждого формата
function sliceWidthFor(ratio) {
	return (ratio === "4:5") ? Math.round(docHeight * 0.8)
	                         : Math.round(docHeight * 0.75);
}

// --- Диалог ---
var dlg = new Window("dialog", "Выбор формата нарезки");
dlg.orientation = "column";
dlg.alignChildren = "left";
dlg.margins = 16;
dlg.spacing = 10;

dlg.add("statictext", undefined, "Выберите соотношение сторон:");

var rb1 = dlg.add("radiobutton", undefined, "4:5");
var rb2 = dlg.add("radiobutton", undefined, "3:4");
rb1.value = true; // значение по умолчанию

var info = dlg.add("statictext", undefined, "");
info.preferredSize.width = 260;

dlg.add("statictext", undefined, "Какие слайды сохранять:");

var rbAll = dlg.add("radiobutton", undefined, "Все слайды");
var rbSel = dlg.add("radiobutton", undefined, "Выбранные:");
rbAll.value = true;

var listField = dlg.add("edittext", undefined, "");
listField.preferredSize.width = 260;
listField.enabled = false;

var hint = dlg.add("statictext", undefined, "Например: 1,3,5-7");

var btnGroup = dlg.add("group");
btnGroup.alignment = "right";
btnGroup.add("button", undefined, "OK", {name: "ok"});
btnGroup.add("button", undefined, "Отмена", {name: "cancel"});

function refresh() {
	var ratio = rb1.value ? "4:5" : "3:4";
	var sw = sliceWidthFor(ratio);
	var n = Math.ceil(docWidth / sw);
	info.text = "Срез " + sw + " px, всего слайдов: " + n;
	listField.enabled = rbSel.value;
}

rb1.onClick = refresh;
rb2.onClick = refresh;
rbAll.onClick = refresh;
rbSel.onClick = function () { refresh(); listField.active = true; };
refresh();

if (dlg.show() !== 1) {
	return;
}

var ratioChoice = rb1.value ? "4:5" : "3:4";
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
