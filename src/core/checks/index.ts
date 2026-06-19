import type { Check, CheckContext, CheckOutcome, CheckSpec } from "./types.ts";
import { loadCatalog } from "./catalog.ts";
import { buildInventory, loadProbeMap, probeIfc, type ProbeSpec } from "./probe.ts";
import { georeferencingCheck } from "./georeferencing.ts";
import { FILE_CHECKS } from "./file-checks.ts";
import { FILENAME_CHECKS } from "./filename-checks.ts";
import { LEVEL_CHECKS } from "./level-checks.ts";

export type {
  Check,
  CheckContext,
  CheckFinding,
  CheckOutcome,
  CheckRun,
  CheckSpec,
  CheckStatus,
} from "./types.ts";
export { loadCatalog } from "./catalog.ts";

/** Все реализованные авто-проверки. */
const ALL_IMPL: Check[] = [
  georeferencingCheck,
  ...FILE_CHECKS,
  ...FILENAME_CHECKS,
  ...LEVEL_CHECKS,
];

/** Реализации по id записи каталога. */
const IMPLEMENTATIONS: Record<string, Check> = Object.fromEntries(
  ALL_IMPL.map((c) => [c.id, c]),
);

/**
 * Generic-описания реализованных проверок для режима «только движок» (когда
 * приватный каталог недоступен). Без текста НПА — короткие собственные названия.
 */
const FALLBACK: Record<string, { category: string; name: string }> = {
  "IFC-01": { category: "Форматы", name: "Формат файла" },
  "IFC-04": { category: "Форматы", name: "Схема IFC4" },
  "IFC-03": { category: "Классы IFC", name: "Запрет IfcBuildingElementProxy" },
  "IFC-11": { category: "Именование файлов", name: "Маска имени файла" },
  "IFC-12": { category: "Именование файлов", name: "Разделитель полей" },
  "IFC-13": { category: "Именование файлов", name: "Недопустимые символы" },
  "IFC-14": { category: "Именование файлов", name: "Поле: вид объекта" },
  "IFC-15": { category: "Именование файлов", name: "Поле: номер объекта" },
  "IFC-16": { category: "Именование файлов", name: "Поле: номер подобъекта" },
  "IFC-17": { category: "Именование файлов", name: "Поле: шифр ЦИМ" },
  "IFC-18": { category: "Именование файлов", name: "Поле: шифр этапа" },
  "IFC-20": { category: "Размер файлов", name: "Размер файла" },
  "IFC-24": { category: "Координация", name: "Геопривязка" },
  "IFC-25": { category: "Единицы измерения", name: "Метрические единицы" },
  "IFC-29": { category: "Уровни", name: "Отметка 0.000" },
  "IFC-35": { category: "Уровни", name: "Маска имени уровня" },
  "IFC-36": { category: "Уровни", name: "Поле: номер подобъекта" },
  "IFC-37": { category: "Уровни", name: "Поле: номер уровня" },
  "IFC-38": { category: "Уровни", name: "Поле: наименование уровня" },
  "IFC-39": { category: "Уровни", name: "Поле: тип уровня" },
  "IFC-40": { category: "Оси", name: "Наличие сетки осей" },
};

function fallbackSpecs(): CheckSpec[] {
  return Object.entries(FALLBACK).map(([id, m]) => ({
    id,
    category: m.category,
    name: m.name,
    source: "",
    algorithm: "",
    priority: "High",
    complexity: "Low",
    automatable: "Да",
    mode: "auto",
  }));
}

/**
 * Прогоняет весь каталог СТРОГО ПО СПИСКУ (в порядке IFC-01…IFC-93):
 *  - реализованные проверки выполняются по модели;
 *  - остальные зондируются на наличие нужной IFC-сущности/атрибута: если её нет —
 *    статус "absent" («нет такого атрибута»), если есть — "todo", если это
 *    имя файла/ручная проверка — "manual".
 */
export async function runChecks(ctx: CheckContext): Promise<CheckOutcome[]> {
  let specs = await loadCatalog();
  if (specs.length === 0) specs = fallbackSpecs();
  const probeMap = await loadProbeMap();
  const inv = buildInventory(ctx.source || "");

  const out: CheckOutcome[] = [];
  for (const spec of specs) {
    const impl = IMPLEMENTATIONS[spec.id];
    if (impl) {
      try {
        const r = await impl.run(ctx);
        out.push({ spec, status: r.status, summary: r.summary, findings: r.findings });
      } catch (err) {
        out.push({ spec, status: "info", summary: `Ошибка проверки: ${(err as Error).message}`, findings: [] });
      }
      continue;
    }
    out.push(probeOutcome(spec, probeMap[spec.id], inv, ctx));
  }
  return out;
}

/** Исход НЕреализованной проверки по результату зонда наличия атрибута. */
function probeOutcome(
  spec: CheckSpec,
  probe: ProbeSpec | undefined,
  inv: ReturnType<typeof buildInventory>,
  ctx: CheckContext,
): CheckOutcome {
  if (!probe || !probe.applicable) {
    const summary =
      probe?.needs === "filename"
        ? "Проверка имени файла — авто-проверка не реализована"
        : "Ручная/внешняя проверка (в IFC атрибута нет)";
    return { spec, status: "manual", summary, findings: [] };
  }
  const { present, target } = probeIfc(probe, inv, ctx.api, ctx.modelID);
  if (present === false) {
    return { spec, status: "absent", summary: `Нет такого атрибута: ${target}`, findings: [] };
  }
  if (present === true) {
    return {
      spec,
      status: "todo",
      summary: `Атрибут присутствует: ${target} — авто-проверка не реализована`,
      findings: [],
    };
  }
  return { spec, status: "todo", summary: "Авто-проверка не реализована", findings: [] };
}
