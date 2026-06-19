import * as WebIFC from "web-ifc";
import type { IfcAPI } from "web-ifc";

/**
 * Универсальный зонд наличия IFC-сущностей/атрибутов для НЕреализованных проверок.
 *
 * Реестр «что зондировать» (приватный, как и каталог) лежит в
 * public/checks-probemap.json (gitignore). Для каждой проверки он задаёт, какую
 * IFC-сущность/Pset/атрибут искать.
 *
 * Сущности зондируются через web-ifc (GetLineIDsWithType c наследованием) — это
 * корректно учитывает АБСТРАКТНЫЕ супертипы (IfcProduct, IfcElement и т.п.),
 * которых нет в STEP-тексте буквально. Имена Pset/свойств ищутся по сырому
 * тексту STEP (они ASCII). Универсально для любого IFC.
 */
export interface ProbeSpec {
  id: string;
  needs: string;
  ifcTarget: string;
  applicable: boolean;
  note: string;
}

export interface Inventory {
  /** Сырой текст STEP-файла (для поиска имён Pset/свойств). */
  source: string;
}

export function buildInventory(source: string): Inventory {
  return { source };
}

/** Реестр-зонд встроен в движок (публичный, без текста алгоритмов/НПА). */
export async function loadProbeMap(): Promise<Record<string, ProbeSpec>> {
  const { PROBE_MAP } = await import("./public-catalog.ts");
  return PROBE_MAP;
}

/** Есть ли в модели хоть один экземпляр типа `name` (с учётом подтипов). null — тип неизвестен web-ifc. */
function entityPresent(api: IfcAPI, modelID: number, name: string): boolean | null {
  const code = (WebIFC as unknown as Record<string, number>)[name.toUpperCase()];
  if (typeof code !== "number") return null;
  try {
    return api.GetLineIDsWithType(modelID, code, true).size() > 0;
  } catch {
    return null;
  }
}

/**
 * Зондирует наличие нужной для проверки IFC-сущности/Pset.
 * present: true — присутствует; false — «нет такого атрибута»; null — определить нельзя.
 */
export function probeIfc(
  spec: ProbeSpec,
  inv: Inventory,
  api: IfcAPI,
  modelID: number,
): { present: boolean | null; target: string } {
  const t = spec.ifcTarget || "";
  const entToks = Array.from(t.matchAll(/Ifc[A-Za-z0-9]+/g)).map((x) => x[0]);
  const setToks = Array.from(t.matchAll(/(?:Pset_|Qto_|RusSet_|RUS_)[A-Za-z0-9_]*/g))
    .map((x) => x[0])
    .filter((s) => s.length > 4);

  if (spec.needs === "header") return { present: true, target: "header" };
  if (spec.needs === "units") {
    return { present: entityPresent(api, modelID, "IfcUnitAssignment"), target: "IfcUnitAssignment" };
  }
  // Pset/свойства — по имени в тексте (web-ifc их по имени не индексирует).
  if (setToks.length > 0) {
    return { present: setToks.some((s) => inv.source.includes(s)), target: setToks.join(" / ") };
  }
  // Сущности — через web-ifc (учёт абстрактных супертипов и подтипов).
  if (entToks.length > 0) {
    const results = entToks.map((e) => entityPresent(api, modelID, e));
    if (results.some((r) => r === true)) return { present: true, target: entToks.join(" / ") };
    if (results.every((r) => r === null)) return { present: null, target: entToks.join(" / ") };
    return { present: false, target: entToks.join(" / ") };
  }
  return { present: null, target: t };
}
