import type { IfcElement } from "../core/types.ts";

/** additive === true — клик с Shift (мультивыбор). */
export type ElementSelectHandler = (expressID: number, additive: boolean) => void;

/**
 * Левая панель: элементы модели, сгруппированные по типу IFC.
 * Поддерживает фильтрацию, мультивыбор (подсветку нескольких) и затемнение
 * скрытых элементов.
 */
export class ElementList {
  private elements: IfcElement[] = [];
  private filter = "";
  private selected = new Set<number>();
  private hidden = new Set<number>();
  private onSelect: ElementSelectHandler = () => {};

  constructor(private root: HTMLElement) {}

  setSelectHandler(handler: ElementSelectHandler): void {
    this.onSelect = handler;
  }

  setElements(elements: IfcElement[]): void {
    this.elements = elements;
    this.selected.clear();
    this.hidden.clear();
    this.render();
  }

  setFilter(text: string): void {
    this.filter = text.trim().toLowerCase();
    this.render();
  }

  /** Подсветить выделенные элементы (мультивыбор). Последний — проскроллить. */
  setSelection(ids: number[]): void {
    this.selected = new Set(ids);
    for (const el of this.root.querySelectorAll(".item")) {
      const id = Number((el as HTMLElement).dataset.id);
      el.classList.toggle("active", this.selected.has(id));
    }
    const last = ids[ids.length - 1];
    if (last != null) {
      this.root
        .querySelector(`.item[data-id="${last}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }

  /** Затемнить скрытые в сцене элементы. */
  setHidden(ids: number[]): void {
    this.hidden = new Set(ids);
    for (const el of this.root.querySelectorAll(".item")) {
      const id = Number((el as HTMLElement).dataset.id);
      el.classList.toggle("hidden-item", this.hidden.has(id));
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
        if (this.selected.has(e.expressID)) item.classList.add("active");
        if (this.hidden.has(e.expressID)) item.classList.add("hidden-item");
        const label = e.name ?? `#${e.expressID}`;
        item.innerHTML = `<span class="name">${escapeHtml(label)}</span><span class="eid">#${e.expressID}</span>`;
        // Shift+клик — мультивыбор; обычный клик — одиночный.
        item.addEventListener("click", (ev) =>
          this.onSelect(e.expressID, ev.shiftKey),
        );
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
