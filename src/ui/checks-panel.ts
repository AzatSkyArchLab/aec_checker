import type { CheckOutcome, CheckStatus } from "../core/checks/index.ts";

export type CheckSelectHandler = (expressID: number) => void;

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: "OK",
  warn: "частично",
  fail: "не пройдена",
  info: "ошибка",
  todo: "не реализовано",
  absent: "нет атрибута",
  manual: "ручная",
};

/** Вес для выбора «худшего» статуса категории. */
const STATUS_RANK: Record<CheckStatus, number> = {
  fail: 5,
  warn: 4,
  pass: 3,
  info: 2,
  manual: 1,
  absent: 1,
  todo: 0,
};

/**
 * Каталог проверок ЦИМ АГР в левой панели: группировка по категориям,
 * статус каждой проверки, раскрытие алгоритма/источника/находок.
 */
export class ChecksPanel {
  private onSelect: CheckSelectHandler = () => {};

  constructor(private root: HTMLElement) {
    this.clear();
  }

  setSelectHandler(handler: CheckSelectHandler): void {
    this.onSelect = handler;
  }

  clear(): void {
    this.root.innerHTML = "";
  }

  show(outcomes: CheckOutcome[]): void {
    this.root.innerHTML = "";
    if (outcomes.length === 0) return;

    this.root.appendChild(this.renderHeader(outcomes));

    // Группировка по категориям с сохранением порядка каталога.
    const byCat = new Map<string, CheckOutcome[]>();
    for (const o of outcomes) {
      const arr = byCat.get(o.spec.category) ?? [];
      arr.push(o);
      byCat.set(o.spec.category, arr);
    }
    for (const [category, items] of byCat) {
      this.root.appendChild(this.renderCategory(category, items));
    }
  }

  private renderHeader(outcomes: CheckOutcome[]): HTMLElement {
    const counts = { pass: 0, warn: 0, fail: 0, info: 0, todo: 0, absent: 0, manual: 0 };
    for (const o of outcomes) counts[o.status]++;
    const header = document.createElement("div");
    header.className = "checks-header";
    header.innerHTML = `
      <div class="checks-title">Проверки ЦИМ АГР · ${outcomes.length}</div>
      <div class="checks-counts">
        <span class="status-pass">✓ ${counts.pass}</span>
        <span class="status-warn">⚠ ${counts.warn}</span>
        <span class="status-fail">✗ ${counts.fail}</span>
        <span class="status-absent">нет атр. ${counts.absent}</span>
        <span class="status-manual">ручных ${counts.manual}</span>
        <span class="status-todo">todo ${counts.todo}</span>
      </div>`;
    return header;
  }

  private renderCategory(category: string, items: CheckOutcome[]): HTMLElement {
    const worst = items.reduce<CheckStatus>(
      (acc, o) => (STATUS_RANK[o.status] > STATUS_RANK[acc] ? o.status : acc),
      "todo",
    );
    const group = document.createElement("details");
    group.className = "check-cat";
    // Категорию с проблемами (fail/warn) раскрываем сразу.
    group.open = worst === "fail" || worst === "warn";

    const summary = document.createElement("summary");
    summary.innerHTML = `
      <span class="check-dot status-${worst}"></span>
      <span class="cat-name">${escapeHtml(category)}</span>
      <span class="cat-count">${items.length}</span>`;
    group.appendChild(summary);

    for (const o of items) group.appendChild(this.renderCheck(o));
    return group;
  }

  private renderCheck(o: CheckOutcome): HTMLElement {
    const block = document.createElement("details");
    block.className = "check";

    const summary = document.createElement("summary");
    summary.innerHTML = `
      <span class="check-dot status-${o.status}" title="${STATUS_LABEL[o.status]}"></span>
      <span class="check-id">${o.spec.id}</span>
      <span class="check-title">${escapeHtml(o.spec.name)}</span>
      <span class="check-status status-${o.status}">${STATUS_LABEL[o.status]}</span>`;
    block.appendChild(summary);

    const body = document.createElement("div");
    body.className = "check-body";

    if (o.summary) {
      const s = document.createElement("div");
      s.className = "check-summary";
      s.textContent = o.summary;
      body.appendChild(s);
    }

    const meta = document.createElement("div");
    meta.className = "check-meta";
    meta.innerHTML = `
      <div class="check-algo">${escapeHtml(o.spec.algorithm)}</div>
      <div class="check-source">${escapeHtml(o.spec.source)} · приоритет ${escapeHtml(
        o.spec.priority,
      )} · автоматизация: ${escapeHtml(o.spec.automatable)}</div>`;
    body.appendChild(meta);

    for (const f of o.findings) {
      const row = document.createElement("div");
      row.className = "finding";
      const idChip =
        f.expressID != null
          ? `<span class="finding-id" data-id="${f.expressID}">#${f.expressID}</span>`
          : "";
      row.innerHTML = `
        <span class="finding-label">${escapeHtml(f.label)}</span>
        ${f.detail ? `<span class="finding-detail">${escapeHtml(f.detail)}</span>` : ""}
        ${idChip}`;
      const chip = row.querySelector<HTMLElement>(".finding-id");
      if (chip && f.expressID != null) {
        chip.addEventListener("click", () => this.onSelect(f.expressID!));
      }
      body.appendChild(row);
    }

    block.appendChild(body);
    return block;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
