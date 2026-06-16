import "./style.css";
import { IfcParser } from "./core/ifc-parser.ts";
import { Viewer } from "./viewer/viewer.ts";
import { ElementList } from "./ui/element-list.ts";
import { PropertiesPanel } from "./ui/properties-panel.ts";
import { ChecksPanel } from "./ui/checks-panel.ts";

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

const statusEl = $<HTMLElement>("#status");
const dropzone = $<HTMLElement>("#dropzone");

function setStatus(text: string): void {
  statusEl.textContent = text;
}

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

function updateToolbar(): void {
  const n = selection.size;
  selCountEl.textContent = n === 0 ? "Ничего не выделено" : `Выделено: ${n}`;
  btnIsolate.disabled = n === 0;
  btnHide.disabled = n === 0;
  btnShowAll.disabled = !viewer.hasHidden();
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
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());

    setStatus("Парсинг IFC…");
    await parser.open(buffer);

    const elements = parser.getElements();
    elementList.setElements(elements);

    setStatus("Построение геометрии…");
    const meshes = parser.getMeshes();
    viewer.loadMeshes(meshes);

    setStatus("Проверки модели…");
    const checks = await parser.runChecks();
    checksPanel.show(checks);

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
