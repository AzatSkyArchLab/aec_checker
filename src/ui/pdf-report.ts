import type { CheckOutcome, CheckStatus } from "../core/checks/index.ts";

const STATUS: Record<CheckStatus, { label: string; color: string }> = {
  pass: { label: "Соответствует", color: "#2e7d4f" },
  warn: { label: "Частично", color: "#b9770e" },
  fail: { label: "Не соответствует", color: "#c0392b" },
  info: { label: "Ошибка", color: "#c0392b" },
  manual: { label: "Ручная проверка", color: "#2f6fa8" },
  absent: { label: "Нет атрибута", color: "#5a6b7a" },
  todo: { label: "Не реализована", color: "#8a8a8a" },
};

const ZEBRA = {
  fillColor: (rowIndex: number) => (rowIndex === 0 ? "#f0f0f0" : rowIndex % 2 ? "#fafafa" : null),
  hLineColor: () => "#e0e0e0",
  vLineColor: () => "#e0e0e0",
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
};

/** Прогоняет каталог-результаты в PDF-отчёт и скачивает его. */
export async function downloadChecksReport(
  fileName: string,
  outcomes: CheckOutcome[],
  dateStr: string,
): Promise<void> {
  const pdfMake: any = (await import("pdfmake/build/pdfmake")).default;
  const vfsMod: any = await import("pdfmake/build/vfs_fonts");
  const vfs = vfsMod.default ?? vfsMod;
  if (typeof pdfMake.addVirtualFileSystem === "function") {
    pdfMake.addVirtualFileSystem(vfs);
  } else {
    pdfMake.vfs = vfs;
  }
  const fonts = {
    Roboto: {
      normal: "Roboto-Regular.ttf",
      bold: "Roboto-Medium.ttf",
      italics: "Roboto-Italic.ttf",
      bolditalics: "Roboto-MediumItalic.ttf",
    },
  };

  const counts = { pass: 0, warn: 0, fail: 0, info: 0, manual: 0, absent: 0, todo: 0 };
  for (const o of outcomes) counts[o.status]++;
  const fails = outcomes.filter((o) => o.status === "fail" || o.status === "info");
  const warns = outcomes.filter((o) => o.status === "warn");

  const verdict =
    fails.length > 0
      ? { text: `Выявлены несоответствия: ${fails.length}`, color: STATUS.fail.color }
      : { text: "Несоответствий не выявлено", color: STATUS.pass.color };

  const content: any[] = [
    { text: "Отчёт проверки ЦИМ АГР", style: "h1" },
    {
      text: `Файл: ${fileName || "—"}     Дата: ${dateStr}`,
      style: "meta",
      margin: [0, 2, 0, 8],
    },
    {
      text: verdict.text,
      color: verdict.color,
      bold: true,
      fontSize: 13,
      margin: [0, 0, 0, 8],
    },
    summaryTable(counts, outcomes.length),
  ];

  // Раздел «Несоответствия» (что НЕ соответствует) — на первом месте.
  content.push({ text: "Несоответствия и предупреждения", style: "h2", margin: [0, 14, 0, 4] });
  const problem = [...fails, ...warns];
  if (problem.length === 0) {
    content.push({ text: "Несоответствий не выявлено.", italics: true, color: STATUS.pass.color });
  } else {
    content.push({
      table: {
        headerRows: 1,
        widths: [44, "*", 78],
        body: [
          [hcell("ID"), hcell("Проверка / причина"), hcell("Статус")],
          ...problem.map((o) => [
            { text: o.spec.id, fontSize: 8 },
            {
              stack: [
                { text: o.spec.name },
                ...(o.summary ? [{ text: o.summary, fontSize: 7, color: "#666" }] : []),
                ...findingLines(o),
              ],
            },
            { text: STATUS[o.status].label, color: STATUS[o.status].color, bold: true, fontSize: 8 },
          ]),
        ],
      },
      layout: ZEBRA,
    });
  }

  // Полный список — СТРОГО ПО СПИСКУ (в порядке каталога IFC-01 … IFC-NN).
  const firstId = outcomes[0]?.spec.id ?? "";
  const lastId = outcomes[outcomes.length - 1]?.spec.id ?? "";
  content.push({
    text: `Все проверки строго по списку (${firstId} … ${lastId})`,
    style: "h2",
    pageBreak: "before",
    margin: [0, 0, 0, 6],
  });
  content.push({
    table: {
      headerRows: 1,
      widths: [40, 70, "*", 70],
      body: [
        [hcell("ID"), hcell("Категория"), hcell("Проверка / результат"), hcell("Статус")],
        ...outcomes.map((o) => [
          { text: o.spec.id, fontSize: 8 },
          { text: o.spec.category, fontSize: 7, color: "#666" },
          {
            stack: [
              { text: o.spec.name, fontSize: 8 },
              ...(o.summary ? [{ text: o.summary, fontSize: 7, color: "#555" }] : []),
            ],
          },
          { text: STATUS[o.status].label, color: STATUS[o.status].color, fontSize: 8 },
        ]),
      ],
    },
    layout: ZEBRA,
  });

  const docDefinition = {
    pageSize: "A4",
    pageMargins: [32, 32, 32, 40],
    content,
    styles: {
      h1: { fontSize: 18, bold: true },
      h2: { fontSize: 13, bold: true },
      h3: { fontSize: 11, bold: true, color: "#333" },
      meta: { fontSize: 9, color: "#666" },
    },
    defaultStyle: { font: "Roboto", fontSize: 9, lineHeight: 1.15 },
    footer: (page: number, total: number) => ({
      text: `${page} / ${total}`,
      alignment: "center",
      fontSize: 8,
      color: "#999",
      margin: [0, 12, 0, 0],
    }),
  };

  const base = (fileName || "model").replace(/\.ifc$/i, "").replace(/[^\wА-Яа-яЁё.-]+/g, "_");
  pdfMake.createPdf(docDefinition, undefined, fonts, vfs).download(`Отчёт_${base}.pdf`);
}

function summaryTable(
  c: Record<CheckStatus, number>,
  total: number,
): any {
  const cell = (label: string, n: number, color: string) => [
    { text: label, color, fontSize: 9 },
    { text: String(n), bold: true, alignment: "right", fontSize: 9 },
  ];
  return {
    columns: [
      {
        width: "auto",
        table: {
          body: [
            cell("Соответствует", c.pass, STATUS.pass.color),
            cell("Частично", c.warn, STATUS.warn.color),
            cell("Не соответствует", c.fail + c.info, STATUS.fail.color),
            cell("Нет атрибута", c.absent, STATUS.absent.color),
            cell("Ручная проверка", c.manual, STATUS.manual.color),
            cell("Не реализована", c.todo, STATUS.todo.color),
            [{ text: "Всего", bold: true }, { text: String(total), bold: true, alignment: "right" }],
          ],
        },
        layout: "noBorders",
      },
    ],
  };
}

function findingLines(o: CheckOutcome): any[] {
  return o.findings.slice(0, 30).map((f) => ({
    text: `• ${f.label}${f.detail ? " — " + f.detail : ""}${f.expressID != null ? " (#" + f.expressID + ")" : ""}`,
    fontSize: 7,
    color: "#444",
    margin: [6, 0, 0, 0],
  }));
}

function hcell(text: string): any {
  return { text, bold: true, fontSize: 8, color: "#333" };
}
