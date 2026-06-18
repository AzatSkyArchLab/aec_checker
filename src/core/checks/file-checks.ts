import { IFCBUILDINGELEMENTPROXY, IFCGRID, IFCSIUNIT } from "web-ifc";
import type { Check } from "./types.ts";
import { idsOfType, line, str, typeName } from "./ifc-util.ts";

const MB = 1024 * 1024;
const MAX_SIZE_MB = 500;

/** IFC-01: расширение .ifc + схема IFC4 (SPF подтверждён успешным открытием). */
const formatCheck: Check = {
  id: "IFC-01",
  run(ctx) {
    const isIfc = ctx.fileName.toLowerCase().endsWith(".ifc");
    const schema = safeSchema(ctx.api, ctx.modelID);
    const isIfc4 = /IFC4/i.test(schema);
    const problems: string[] = [];
    if (ctx.fileName && !isIfc) problems.push("расширение не .ifc");
    if (!isIfc4) problems.push(`схема ${schema || "?"} (нужна IFC4)`);
    return problems.length
      ? { status: "fail", summary: problems.join("; "), findings: [] }
      : { status: "pass", summary: `Формат: ${schema}, SPF`, findings: [] };
  },
};

/** IFC-04: схема IFC4 (ГОСТ Р 10.0.02-2019). */
const schemaCheck: Check = {
  id: "IFC-04",
  run(ctx) {
    const schema = safeSchema(ctx.api, ctx.modelID);
    return /IFC4/i.test(schema)
      ? { status: "pass", summary: `Схема ${schema}`, findings: [] }
      : { status: "fail", summary: `Схема ${schema || "?"} — требуется IFC4`, findings: [] };
  },
};

/** IFC-03: запрет IfcBuildingElementProxy. */
const noProxyCheck: Check = {
  id: "IFC-03",
  run(ctx) {
    const ids = idsOfType(ctx, IFCBUILDINGELEMENTPROXY, true);
    if (ids.length === 0) {
      return { status: "pass", summary: "IfcBuildingElementProxy не используется", findings: [] };
    }
    return {
      status: "fail",
      summary: `Найдено элементов IfcBuildingElementProxy: ${ids.length}`,
      findings: ids.slice(0, 100).map((id) => ({
        label: str(line(ctx, id)?.Name) || typeName(ctx, id),
        expressID: id,
      })),
    };
  },
};

/** IFC-20: размер файла ≤ 500 МБ. */
const sizeCheck: Check = {
  id: "IFC-20",
  run(ctx) {
    const mb = ctx.fileSize / MB;
    return mb <= MAX_SIZE_MB
      ? { status: "pass", summary: `${mb.toFixed(1)} МБ из ${MAX_SIZE_MB}`, findings: [] }
      : { status: "fail", summary: `${mb.toFixed(1)} МБ — больше ${MAX_SIZE_MB}`, findings: [] };
  },
};

/** IFC-25: метрические единицы (длина — метр/мм/см). */
const unitsCheck: Check = {
  id: "IFC-25",
  run(ctx) {
    for (const id of idsOfType(ctx, IFCSIUNIT)) {
      const u = line(ctx, id);
      if (str(u?.UnitType) !== "LENGTHUNIT") continue;
      const name = str(u?.Name);
      const prefix = str(u?.Prefix);
      if (name === "METRE") {
        return {
          status: "pass",
          summary: `Длина: ${prefix ? prefix + " " : ""}METRE (метрическая)`,
          findings: [],
        };
      }
      return { status: "fail", summary: `Единица длины: ${name || "?"} — не метрическая`, findings: [] };
    }
    return { status: "warn", summary: "Единица длины не задана через IfcSIUnit", findings: [] };
  },
};

/** IFC-40: наличие сетки осей (IfcGrid). */
const gridCheck: Check = {
  id: "IFC-40",
  run(ctx) {
    const n = idsOfType(ctx, IFCGRID, true).length;
    return n > 0
      ? { status: "pass", summary: `Сетка осей: ${n}`, findings: [] }
      : { status: "fail", summary: "Сетка осей (IfcGrid) не найдена", findings: [] };
  },
};

function safeSchema(api: { GetModelSchema(id: number): string }, modelID: number): string {
  try {
    return api.GetModelSchema(modelID);
  } catch {
    return "";
  }
}

export const FILE_CHECKS: Check[] = [
  formatCheck,
  schemaCheck,
  noProxyCheck,
  sizeCheck,
  unitsCheck,
  gridCheck,
];
