import type { Check, CheckContext, CheckResult } from "./types.ts";
import { georeferencingCheck } from "./georeferencing.ts";

export type { Check, CheckContext, CheckResult, CheckFinding, CheckStatus } from "./types.ts";

/** Реестр всех проверок. Новую проверку добавляй сюда. */
export const ALL_CHECKS: Check[] = [georeferencingCheck];

/** Прогоняет все зарегистрированные проверки по модели. */
export async function runChecks(ctx: CheckContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of ALL_CHECKS) {
    try {
      results.push(await check.run(ctx));
    } catch (err) {
      results.push({
        id: check.id,
        title: check.title,
        status: "info",
        summary: `Проверка не выполнена: ${(err as Error).message}`,
        findings: [],
      });
    }
  }
  return results;
}
