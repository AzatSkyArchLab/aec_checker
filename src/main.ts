import "./style.css";
import { IfcParser } from "./core/ifc-parser.ts";
import { Viewer } from "./viewer/viewer.ts";
import { ElementList } from "./ui/element-list.ts";
import { PropertiesPanel } from "./ui/properties-panel.ts";

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

const statusEl = $<HTMLElement>("#status");
const dropzone = $<HTMLElement>("#dropzone");

function setStatus(text: string): void {
  statusEl.textContent = text;
}

// ── Выбор элемента ───────────────────────────────────────────────────────────

let selectToken = 0;

async function selectElement(expressID: number | null): Promise<void> {
  elementList.setActive(expressID);
  viewer.focus(expressID);

  if (expressID == null) {
    propertiesPanel.clear();
    return;
  }
  const token = ++selectToken;
  try {
    const info = await parser.getElementInfo(expressID);
    if (token !== selectToken) return; // пришёл более свежий выбор
    propertiesPanel.show(info);
  } catch (err) {
    console.error(err);
    propertiesPanel.clear();
  }
}

elementList.setSelectHandler((id) => void selectElement(id));
viewer.setSelectHandler((id) => void selectElement(id));

// ── Загрузка файла ───────────────────────────────────────────────────────────

async function loadFile(file: File): Promise<void> {
  setStatus(`Чтение «${file.name}»…`);
  dropzone.classList.add("hidden");
  propertiesPanel.clear();
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());

    setStatus("Парсинг IFC…");
    await parser.open(buffer);

    const elements = parser.getElements();
    elementList.setElements(elements);

    setStatus("Построение геометрии…");
    const meshes = parser.getMeshes();
    viewer.loadMeshes(meshes);

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
