import type { Check, CheckContext, CheckOutcome, CheckSpec } from "./types.ts";
import { loadCatalog } from "./catalog.ts";
import { georeferencingCheck } from "./georeferencing.ts";

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

/** Реализации авто-проверок по id записи каталога. Наполняется батчами. */
const IMPLEMENTATIONS: Record<string, Check> = {
  [georeferencingCheck.id]: georeferencingCheck,
};

/**
 * Generic-описания реализованных проверок для режима «только движок»
 * (когда приватный каталог недоступен). Без текста НПА — собственные формулировки.
 */
const FALLBACK_SPECS: Record<string, CheckSpec> = {
  "IFC-24": {
    id: "IFC-24",
    category: "Координация",
    name: "Геопривязка (привязка к местности)",
    source: "",
    algorithm:
      "Поиск любых признаков геопривязки: проекционная CRS, MapConversion, широта/долгота IfcSite, истинный север, почтовый адрес.",
    priority: "High",
    complexity: "Med",
    automatable: "Да",
    mode: "auto",
  },
};

/**
 * Прогоняет каталог: реализованные проверки выполняются по модели, остальные
 * получают статус "todo" (авто, ещё не реализовано) или "manual". Если приватный
 * каталог не загружен — работает по generic-описаниям реализованных проверок.
 */
export async function runChecks(ctx: CheckContext): Promise<CheckOutcome[]> {
  let specs = await loadCatalog();
  if (specs.length === 0) specs = Object.values(FALLBACK_SPECS);

  const out: CheckOutcome[] = [];
  for (const spec of specs) {
    const impl = IMPLEMENTATIONS[spec.id];
    if (!impl) {
      out.push({
        spec,
        status: spec.mode === "manual" ? "manual" : "todo",
        summary:
          spec.mode === "manual"
            ? "Требует ручной/внешней проверки"
            : "Авто-проверка ещё не реализована",
        findings: [],
      });
      continue;
    }
    try {
      const r = await impl.run(ctx);
      out.push({ spec, status: r.status, summary: r.summary, findings: r.findings });
    } catch (err) {
      out.push({
        spec,
        status: "info",
        summary: `Ошибка проверки: ${(err as Error).message}`,
        findings: [],
      });
    }
  }
  return out;
}
