import type { IfcElement } from "../core/types.ts";

export type ElementSelectHandler = (expressID: number) => void;

/**
 * Левая панель: элементы модели, сгруппированные по типу IFC.
 * Поддерживает фильтрацию по тексту и подсветку активного элемента.
 */
export class ElementList {
  private elements: IfcElement[] = [];
  private filter = "";
  private activeID: number | null = null;
  private onSelect: ElementSelectHandler = () => {};

  constructor(private root: HTMLElement) {}

  setSelectHandler(handler: ElementSelectHandler): void {
    this.onSelect = handler;
  }

  setElements(elements: IfcElement[]): void {
    this.elements = elements;
    this.render();
  }

  setFilter(text: string): void {
    this.filter = text.trim().toLowerCase();
    this.render();
  }

  /** Подсветить активный элемент (например, при выборе в 3D). */
  setActive(expressID: number | null): void {
    this.activeID = expressID;
    const prev = this.root.querySelector(".item.active");
    prev?.classList.remove("active");
    if (expressID == null) return;
    const el = this.root.querySelector(`.item[data-id="${expressID}"]`);
    if (el) {
      el.classList.add("active");
      el.scrollIntoView({ block: "nearest" });
    }
  }

  private match(e: IfcElement): boolean {
    if (!this.filter) return true;
    const hay = `${e.typeName} ${e.name ?? ""} ${e.expressID} ${
      e.globalId ?? ""
    }`.toLowerCase();
    return hay.includes(this.filter);
  }

  private render(): void {
    this.root.innerHTML = "";
    const visible = this.elements.filter((e) => this.match(e));

    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "list-empty";
      empty.textContent = this.elements.length
        ? "Ничего не найдено"
        : "Загрузите IFC-файл";
      this.root.appendChild(empty);
      return;
    }

    // Группировка по типу.
    const groups = new Map<string, IfcElement[]>();
    for (const e of visible) {
      const arr = groups.get(e.typeName) ?? [];
      arr.push(e);
      groups.set(e.typeName, arr);
    }

    const sortedTypes = [...groups.keys()].sort();
    for (const typeName of sortedTypes) {
      const items = groups.get(typeName)!;
      const group = document.createElement("details");
      group.className = "group";
      group.open = sortedTypes.length <= 8 || !!this.filter;

      const summary = document.createElement("summary");
      summary.innerHTML = `<span class="type">${typeName}</span><span class="count">${items.length}</span>`;
      group.appendChild(summary);

      for (const e of items) {
        const item = document.createElement("div");
        item.className = "item";
        item.dataset.id = String(e.expressID);
        if (e.expressID === this.activeID) item.classList.add("active");
        const label = e.name ?? `#${e.expressID}`;
        item.innerHTML = `<span class="name">${escapeHtml(label)}</span><span class="eid">#${e.expressID}</span>`;
        item.addEventListener("click", () => this.onSelect(e.expressID));
        group.appendChild(item);
      }
      this.root.appendChild(group);
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
