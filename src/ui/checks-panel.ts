import type { CheckResult } from "../core/checks/index.ts";

export type CheckSelectHandler = (expressID: number) => void;

const STATUS_LABEL: Record<CheckResult["status"], string> = {
  pass: "OK",
  warn: "частично",
  fail: "не найдено",
  info: "—",
};

/**
 * Блок «Проверки модели» в левой панели. Показывает результат каждой проверки
 * со статусом и раскрывающимся списком находок. Находки с expressID кликабельны.
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

  show(results: CheckResult[]): void {
    this.root.innerHTML = "";
    if (results.length === 0) return;

    const header = document.createElement("div");
    header.className = "checks-header";
    header.textContent = "Проверки модели";
    this.root.appendChild(header);

    for (const r of results) this.root.appendChild(this.renderCheck(r));
  }

  private renderCheck(r: CheckResult): HTMLElement {
    const block = document.createElement("details");
    block.className = "check";
    block.open = r.findings.length > 0;

    const summary = document.createElement("summary");
    summary.innerHTML = `
      <span class="check-dot status-${r.status}" title="${STATUS_LABEL[r.status]}"></span>
      <span class="check-title">${escapeHtml(r.title)}</span>
      <span class="check-status status-${r.status}">${STATUS_LABEL[r.status]}</span>
    `;
    block.appendChild(summary);

    const body = document.createElement("div");
    body.className = "check-body";

    const summaryLine = document.createElement("div");
    summaryLine.className = "check-summary";
    summaryLine.textContent = r.summary;
    body.appendChild(summaryLine);

    for (const f of r.findings) {
      const row = document.createElement("div");
      row.className = "finding";
      const idChip =
        f.expressID != null
          ? `<span class="finding-id" data-id="${f.expressID}">#${f.expressID}</span>`
          : "";
      row.innerHTML = `
        <span class="finding-label">${escapeHtml(f.label)}</span>
        ${f.detail ? `<span class="finding-detail">${escapeHtml(f.detail)}</span>` : ""}
        ${idChip}
      `;
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
