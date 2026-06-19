import "./style.css";
import { IfcParser } from "./core/ifc-parser.ts";
import { Viewer } from "./viewer/viewer.ts";
import { ElementList } from "./ui/element-list.ts";
import { PropertiesPanel } from "./ui/properties-panel.ts";
import { ChecksPanel } from "./ui/checks-panel.ts";
import { MapView } from "./ui/map-view.ts";
import { downloadChecksReport } from "./ui/pdf-report.ts";
import type { CheckOutcome } from "./core/checks/index.ts";
import type { GisView } from "./gis/gis.ts";

/**
 * Точка входа: связывает ядро (IfcParser), 3D-вьювер и UI-панели.
 * Поток данных однонаправленный: файл → parser → {viewer, elementList};
 * выбор элемента (из списка или сцены) → parser.getElementInfo → panel.
 */

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Не найден элемент: ${sel}`);
  return el;
};

const parser = new IfcParser();
const viewer = new Viewer($("#viewer"));
const elementList = new ElementList($("#element-list"));
const propertiesPanel = new PropertiesPanel($("#properties"));
const checksPanel = new ChecksPanel($("#checks"));
const mapView = new MapView(
  $("#map-modal"),
  $("#map"),
  $("#map-method"),
  $("#map-message"),
  $("#map-close"),
);

const statusEl = $<HTMLElement>("#status");
const dropzone = $<HTMLElement>("#dropzone");

function setStatus(text: string): void {
  statusEl.textContent = text;
}

/**
 * Сбой загрузки динамического чанка: после деплоя старые chunk-файлы удаляются,
 * и открытая ранее вкладка не может их догрузить (ленивые import pdfmake/ГИС).
 */
function isStaleChunkError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /dynamically imported module|module script failed|Failed to fetch|Loading chunk|importing a module|error loading dynamically/i.test(
    m,
  );
}

/** Понятное сообщение «вышла новая версия» вместо загадочной ошибки. */
const STALE_CHUNK_MSG = "Вышла новая версия — обновите страницу (Cmd/Ctrl+Shift+R)";

// Сбой предзагрузки чанка (vite) на навигации — самовосстановление перезагрузкой.
window.addEventListener("vite:preloadError", () => {
  setStatus(STALE_CHUNK_MSG);
});

// ── Выбор элементов (мультивыбор по Shift) ────────────────────────────────────

const selection = new Set<number>();
let lastSelected: number | null = null;
let selectToken = 0;

/** Прокидывает текущее выделение во вьювер, список и тулбар. */
function syncSelection(): void {
  const ids = [...selection];
  viewer.setSelection(ids);
  elementList.setSelection(ids);
  updateToolbar();
}

/** Единый обработчик выбора из любого источника. additive — был зажат Shift. */
function handleSelect(id: number | null, additive: boolean): void {
  if (id == null) {
    if (additive) return; // Shift по пустоте — не сбрасываем выбор
    selection.clear();
    lastSelected = null;
    syncSelection();
    propertiesPanel.clear();
    return;
  }
  if (additive) {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
  } else {
    selection.clear();
    selection.add(id);
  }
  lastSelected = selection.has(id) ? id : ([...selection].at(-1) ?? null);
  syncSelection();
  void showProperties(lastSelected);
}

/** Показывает свойства последнего выбранного элемента. */
async function showProperties(id: number | null): Promise<void> {
  if (id == null) {
    propertiesPanel.clear();
    return;
  }
  const token = ++selectToken;
  try {
    const info = await parser.getElementInfo(id);
    if (token !== selectToken) return; // пришёл более свежий выбор
    propertiesPanel.show(info);
  } catch (err) {
    console.error(err);
    propertiesPanel.clear();
  }
}

elementList.setSelectHandler(handleSelect);
viewer.setSelectHandler(handleSelect);
checksPanel.setSelectHandler((id) => handleSelect(id, false));

// ── Видимость: изоляция / скрытие / показать всё ──────────────────────────────

const toolbar = $<HTMLElement>("#view-toolbar");
const selCountEl = $<HTMLElement>("#sel-count");
const btnIsolate = $<HTMLButtonElement>("#btn-isolate");
const btnHide = $<HTMLButtonElement>("#btn-hide");
const btnShowAll = $<HTMLButtonElement>("#btn-showall");
const btnMap = $<HTMLButtonElement>("#btn-map");
const btnReport = $<HTMLButtonElement>("#btn-report");

/** Загружена ли геометрия (для активации кнопки карты). */
let hasGeometry = false;
/** Последние результаты проверок и имя файла — для PDF-отчёта. */
let lastChecks: CheckOutcome[] = [];
let lastFileName = "";

function updateToolbar(): void {
  const n = selection.size;
  selCountEl.textContent = n === 0 ? "Ничего не выделено" : `Выделено: ${n}`;
  btnIsolate.disabled = n === 0;
  btnHide.disabled = n === 0;
  btnShowAll.disabled = !viewer.hasHidden();
  btnMap.disabled = !hasGeometry;
  btnReport.disabled = lastChecks.length === 0;
}

btnMap.addEventListener("click", () => void showOnMap());

btnReport.addEventListener("click", () => void exportReport());

async function exportReport(): Promise<void> {
  if (lastChecks.length === 0) return;
  setStatus("Формирование PDF-отчёта…");
  try {
    await downloadChecksReport(lastFileName, lastChecks, new Date().toLocaleString("ru-RU"));
    setStatus(`Отчёт сформирован · ${lastFileName}`);
  } catch (err) {
    console.error(err);
    if (isStaleChunkError(err)) {
      setStatus(STALE_CHUNK_MSG);
      return;
    }
    setStatus(`Ошибка формирования PDF: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function showOnMap(): Promise<void> {
  setStatus("Срез на уровне 0…");
  try {
    const result = await parser.getFootprintGeo();
    if (!result.ok) {
      // Модалка всё равно открывается — с понятной причиной, а не молча.
      mapView.showMessage(result.reason);
      setStatus(`Карта: ${result.reason}`);
      return;
    }
    await mapView.show(result.footprint);
    setStatus(`Карта: ${result.footprint.method}`);
  } catch (err) {
    console.error(err);
    mapView.showMessage(`Ошибка построения контура: ${(err as Error).message}`);
    setStatus("Карта: ошибка построения контура");
  }
}

function isolateSelected(): void {
  if (selection.size === 0) return;
  viewer.isolateSelected();
  elementList.setHidden(viewer.getHiddenIds());
  updateToolbar();
}

function hideSelected(): void {
  if (selection.size === 0) return;
  viewer.hideSelected();
  elementList.setHidden(viewer.getHiddenIds());
  selection.clear(); // скрытое больше не выделено
  lastSelected = null;
  syncSelection();
  propertiesPanel.clear();
}

function showAll(): void {
  viewer.showAll();
  elementList.setHidden([]);
  updateToolbar();
}

btnIsolate.addEventListener("click", isolateSelected);
btnHide.addEventListener("click", hideSelected);
btnShowAll.addEventListener("click", showAll);

// Горячие клавиши (e.code — независимо от раскладки): I, H, Esc.
window.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.code === "KeyI") isolateSelected();
  else if (e.code === "KeyH") hideSelected();
  else if (e.code === "Escape") {
    showAll();
    handleSelect(null, false);
  }
});

// ── Загрузка файла ───────────────────────────────────────────────────────────

async function loadFile(file: File): Promise<void> {
  setStatus(`Чтение «${file.name}»…`);
  dropzone.classList.add("hidden");
  propertiesPanel.clear();
  checksPanel.clear();
  selection.clear();
  lastSelected = null;
  hasGeometry = false;
  lastChecks = [];
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());

    setStatus("Парсинг IFC…");
    await parser.open(buffer, { fileName: file.name, fileSize: file.size });

    const elements = parser.getElements();
    elementList.setElements(elements);

    setStatus("Построение геометрии…");
    const meshes = parser.getMeshes();
    viewer.loadMeshes(meshes);
    hasGeometry = meshes.length > 0;

    setStatus("Проверки модели…");
    const checks = await parser.runChecks();
    checksPanel.show(checks);
    lastChecks = checks;
    lastFileName = file.name;

    toolbar.hidden = false;
    updateToolbar();
    setStatus(`${file.name} · ${elements.length} элементов`);
  } catch (err) {
    console.error(err);
    setStatus("Ошибка загрузки IFC");
    dropzone.classList.remove("hidden");
  }
}

// ── Источники файла: input + drag&drop ──────────────────────────────────────

$<HTMLInputElement>("#file-input").addEventListener("change", (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void loadFile(file);
});

$<HTMLInputElement>("#search").addEventListener("input", (e) => {
  elementList.setFilter((e.target as HTMLInputElement).value);
});

const viewport = $<HTMLElement>(".viewport");
viewport.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragging");
});
viewport.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
viewport.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragging");
  const file = e.dataTransfer?.files?.[0];
  if (file && file.name.toLowerCase().endsWith(".ifc")) void loadFile(file);
});

setStatus("Готов к загрузке");

// ── Стартовый экран и роутинг (IFC / ГИС) ────────────────────────────────────

const landing = $<HTMLElement>("#landing");
const appIfc = $<HTMLElement>("#app");
const appGis = $<HTMLElement>("#app-gis");
let gisView: GisView | null = null;

function showLanding(): void {
  landing.hidden = false;
}
function showIfc(): void {
  landing.hidden = true;
  appGis.hidden = true;
  appIfc.style.display = "";
  window.dispatchEvent(new Event("resize")); // вернуть размер 3D-вьюверу
}
async function showGis(): Promise<void> {
  landing.hidden = true;
  appIfc.style.display = "none";
  appGis.hidden = false;
  try {
    if (!gisView) gisView = await initGis();
    gisView.open();
  } catch (err) {
    console.error(err);
    $("#gis-status").textContent = isStaleChunkError(err)
      ? STALE_CHUNK_MSG
      : `Ошибка загрузки ГИС: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function initGis(): Promise<GisView> {
  const { GisView } = await import("./gis/gis.ts");
  const view = new GisView(
    $("#gis-map"),
    $("#gis-status"),
    $("#gis-info"),
    $("#gis-dropzone"),
    $<HTMLInputElement>("#gis-cadastre"),
  );
  $<HTMLInputElement>("#gis-file").addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void view.loadFbx(f);
  });
  const gbody = $<HTMLElement>(".gis-body");
  const gdrop = $<HTMLElement>("#gis-dropzone");
  gbody.addEventListener("dragover", (e) => {
    e.preventDefault();
    gdrop.classList.add("dragging");
  });
  gbody.addEventListener("dragleave", () => gdrop.classList.remove("dragging"));
  gbody.addEventListener("drop", (e) => {
    e.preventDefault();
    gdrop.classList.remove("dragging");
    const f = e.dataTransfer?.files?.[0];
    if (f && f.name.toLowerCase().endsWith(".fbx")) void view.loadFbx(f);
  });
  return view;
}

$("#go-ifc").addEventListener("click", showIfc);
$("#go-gis").addEventListener("click", () => void showGis());
$("#ifc-home").addEventListener("click", showLanding);
$("#gis-home").addEventListener("click", showLanding);
