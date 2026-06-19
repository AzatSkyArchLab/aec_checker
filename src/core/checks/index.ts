import type { Check, CheckContext, CheckOutcome, CheckSpec } from "./types.ts";
import { loadCatalog } from "./catalog.ts";
import { buildInventory, loadProbeMap, probeIfc, type ProbeSpec } from "./probe.ts";
import { PUBLIC_SPECS } from "./public-catalog.ts";
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
 * Прогоняет весь каталог СТРОГО ПО СПИСКУ (в порядке IFC-01…IFC-93):
 *  - реализованные проверки выполняются по модели;
 *  - остальные зондируются на наличие нужной IFC-сущности/атрибута: если её нет —
 *    статус "absent" («нет такого атрибута»), если есть — "todo", если это
 *    имя файла/ручная проверка — "manual".
 *
 * Источник списка: приватный checks-catalog.json (с алгоритмами/НПА) если доступен
 * локально; иначе — публичный PUBLIC_SPECS (все 93, только названия). Так отчёт
 * полон (все 93) и на публичном сайте, а тексты алгоритмов/НПА остаются приватными.
 */
export async function runChecks(ctx: CheckContext): Promise<CheckOutcome[]> {
  let specs = await loadCatalog();
  if (specs.length === 0) specs = PUBLIC_SPECS;
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
