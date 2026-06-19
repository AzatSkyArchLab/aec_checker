import {
  FILE_DESCRIPTION,
  IFCBUILDINGELEMENTPROXY,
  IFCCONVERSIONBASEDUNIT,
  IFCGRID,
  IFCSIUNIT,
} from "web-ifc";
import type { Check } from "./types.ts";
import { idsOfType, line, str, typeName } from "./ifc-util.ts";

const MB = 1024 * 1024;
const MAX_SIZE_MB = 500;

/**
 * Принятая схема: IFC4 (ADD2 = строка "IFC4") или IFC4X3+ («или более поздняя»).
 * Отвергаем промежуточные IFC4X1/IFC4X2 и старые IFC2X3.
 */
function isAcceptedSchema(schema: string): boolean {
  const s = (schema || "").toUpperCase().replace(/\s+/g, "");
  return /^IFC4(_ADD\d+)?$/.test(s) || /^IFC4X3/.test(s);
}

/**
 * Reference View в заголовке FILE_DESCRIPTION (ViewDefinition [...]).
 * true — есть ReferenceView; false — ViewDefinition есть, но не ReferenceView;
 * null — ViewDefinition в заголовке не указан.
 */
function referenceViewState(
  api: { GetHeaderLine(modelID: number, headerType: number): unknown },
  modelID: number,
): boolean | null {
  try {
    const h = api.GetHeaderLine(modelID, FILE_DESCRIPTION);
    const s = h ? JSON.stringify(h) : "";
    if (!/ViewDefinition/i.test(s)) return null;
    return /ReferenceView/i.test(s);
  } catch {
    return null;
  }
}

/** IFC-01: .ifc + IFC4 Reference View + IFC SPF (SPF подтверждён парсингом web-ifc). */
const formatCheck: Check = {
  id: "IFC-01",
  run(ctx) {
    const schema = safeSchema(ctx.api, ctx.modelID);
    const problems: string[] = [];
    const notes: string[] = [];

    // 1) Расширение .ifc — проверяем всегда, когда имя известно.
    if (ctx.fileName) {
      if (!ctx.fileName.toLowerCase().endsWith(".ifc")) problems.push("расширение не .ifc");
    } else {
      notes.push("имя файла недоступно — расширение не проверено");
    }
    // 2) Схема строго IFC4 (ADD2) или новее.
    if (!isAcceptedSchema(schema)) problems.push(`схема ${schema || "?"} — нужна IFC4 (ADD2) или новее`);
    // 3) MVD = Reference View (из заголовка).
    const rv = referenceViewState(ctx.api, ctx.modelID);
    if (rv === false) problems.push("MVD не Reference View");
    else if (rv === null) notes.push("MVD (ViewDefinition) не указан в заголовке");
    // 4) IFC SPF — подтверждается тем, что web-ifc распарсил файл (ifcXML/ifcZIP не откроются).

    if (problems.length) return { status: "fail", summary: problems.join("; "), findings: [] };
    if (notes.length) {
      return { status: "warn", summary: `Формат: ${schema}, SPF; ${notes.join("; ")}`, findings: [] };
    }
    return { status: "pass", summary: `Формат: ${schema}, Reference View, SPF`, findings: [] };
  },
};

/** IFC-04: схема IFC4 ADD2 (или новее) по ГОСТ Р 10.0.02-2019. */
const schemaCheck: Check = {
  id: "IFC-04",
  run(ctx) {
    const schema = safeSchema(ctx.api, ctx.modelID);
    return isAcceptedSchema(schema)
      ? { status: "pass", summary: `Схема ${schema}`, findings: [] }
      : {
          status: "fail",
          summary: `Схема ${schema || "?"} — требуется IFC4 (ADD2) или новее (не IFC4X1/X2, не IFC2x3)`,
          findings: [],
        };
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

/** IFC-25: метрические единицы для длины (м), площади (м²) и объёма (м³). */
const METRIC_NAME: Record<string, string> = {
  LENGTHUNIT: "METRE",
  AREAUNIT: "SQUARE_METRE",
  VOLUMEUNIT: "CUBIC_METRE",
};
function unitLabel(t: string): string {
  return t === "LENGTHUNIT" ? "длина" : t === "AREAUNIT" ? "площадь" : t === "VOLUMEUNIT" ? "объём" : t;
}
const unitsCheck: Check = {
  id: "IFC-25",
  run(ctx) {
    // SI-единицы по типам.
    const si = new Map<string, string>();
    for (const id of idsOfType(ctx, IFCSIUNIT)) {
      const u = line(ctx, id);
      const t = str(u?.UnitType);
      if (t && !si.has(t)) si.set(t, str(u?.Name));
    }
    // Единицы, заданные через коэффициент (дюйм/фут и т.п.) — неметрические.
    const conv = new Map<string, string>();
    for (const id of idsOfType(ctx, IFCCONVERSIONBASEDUNIT)) {
      const u = line(ctx, id);
      const t = str(u?.UnitType);
      if (t && !conv.has(t)) conv.set(t, str(u?.Name) || "conversion-based");
    }

    const problems: string[] = [];
    for (const t of Object.keys(METRIC_NAME)) {
      if (conv.has(t)) {
        problems.push(`${unitLabel(t)}: ${conv.get(t)} — неметрическая`);
        continue;
      }
      const name = si.get(t);
      if (name && name !== METRIC_NAME[t]) {
        problems.push(`${unitLabel(t)}: ${name || "?"} — не ${METRIC_NAME[t]}`);
      }
    }

    if (problems.length) {
      return { status: "fail", summary: `Неметрические единицы: ${problems.join("; ")}`, findings: [] };
    }
    if (!si.has("LENGTHUNIT") && !conv.has("LENGTHUNIT")) {
      return { status: "warn", summary: "Единица длины не задана через IfcSIUnit", findings: [] };
    }
    // Площадь/объём, не заданные явно, в IFC выводятся из метра (SI) — это норма.
    return {
      status: "pass",
      summary: "Длина/площадь/объём — метрические (СИ); масштаб 1:1 авто-проверкой не подтверждается",
      findings: [],
    };
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
