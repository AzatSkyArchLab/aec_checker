import { IFCBUILDINGSTOREY } from "web-ifc";
import type { Check, CheckContext, CheckFinding, CheckRun } from "./types.ts";
import { idsOfType, line, num, str } from "./ifc-util.ts";

// Маска имени уровня: <Номер подобъекта>_<Номер уровня>_<Наименование>_<Тип>[_<Доп>]
const SUBOBJECT_RE = /^(С|К|П|ОБ)\d{2}$/;
const LEVEL_NUM_RE = /^(-?\d+|П\d+|\d+\/\d+)$/;
const LEVEL_NAMES = [
  "Этаж",
  "Подземный этаж",
  "Подвальный этаж",
  "Цокольный этаж",
  "Технический этаж",
  "Техническое пространство",
  "Техническое подполье",
  "Чердак",
  "Мансардный этаж",
];
const LEVEL_TYPES = ["основной", "дополнительный"];

interface Storey {
  id: number;
  name: string;
  elev: number | null;
}

function storeys(ctx: CheckContext): Storey[] {
  return idsOfType(ctx, IFCBUILDINGSTOREY, true).map((id) => {
    const l = line(ctx, id);
    return { id, name: str(l?.Name), elev: num(l?.Elevation) };
  });
}

/** Прогон предиката по всем уровням → pass/fail со списком нарушителей. */
function perStorey(
  ctx: CheckContext,
  field: number,
  predicate: (value: string, s: Storey) => boolean,
  okSummary: string,
  badHint: string,
): CheckRun {
  const sts = storeys(ctx);
  if (sts.length === 0) {
    return { status: "fail", summary: "Уровни (IfcBuildingStorey) не найдены", findings: [] };
  }
  const bad: CheckFinding[] = [];
  for (const s of sts) {
    const value = s.name.split("_")[field] ?? "";
    if (!predicate(value, s)) {
      bad.push({ label: s.name || `#${s.id}`, detail: badHint, expressID: s.id });
    }
  }
  return bad.length === 0
    ? { status: "pass", summary: `${okSummary} (${sts.length})`, findings: [] }
    : { status: "fail", summary: `Не соответствуют: ${bad.length} из ${sts.length}`, findings: bad };
}

/** IFC-29: наличие уровня с отметкой 0.000. */
const zeroLevelCheck: Check = {
  id: "IFC-29",
  run(ctx) {
    const sts = storeys(ctx);
    if (sts.length === 0) {
      return { status: "fail", summary: "Уровни не найдены", findings: [] };
    }
    const atZero = sts.some((s) => s.elev != null && Math.abs(s.elev) < 1e-3);
    return atZero
      ? { status: "pass", summary: "Есть уровень с отметкой 0.000", findings: [] }
      : { status: "warn", summary: "Нет уровня с отметкой 0.000", findings: [] };
  },
};

/** IFC-35: имя уровня по маске (≥4 поля). */
const nameMaskCheck: Check = {
  id: "IFC-35",
  run(ctx) {
    const sts = storeys(ctx);
    if (sts.length === 0) {
      return { status: "fail", summary: "Уровни не найдены", findings: [] };
    }
    const bad: CheckFinding[] = [];
    for (const s of sts) {
      const f = s.name.split("_");
      if (f.length < 4 || f.slice(0, 4).some((x) => x.length === 0)) {
        bad.push({ label: s.name || `#${s.id}`, detail: "нужно ≥4 полей", expressID: s.id });
      }
    }
    return bad.length === 0
      ? { status: "pass", summary: `Маска соблюдена (${sts.length})`, findings: [] }
      : { status: "fail", summary: `Не по маске: ${bad.length} из ${sts.length}`, findings: bad };
  },
};

/** IFC-36: поле 1 — номер подобъекта (С01/К01/П01/ОБ01). */
const subObjectCheck: Check = {
  id: "IFC-36",
  run(ctx) {
    return perStorey(ctx, 0, (v) => SUBOBJECT_RE.test(v), "Поле 1 корректно", "ожидается С01/К01/П01/ОБ01");
  },
};

/** IFC-37: поле 2 — номер уровня. */
const levelNumberCheck: Check = {
  id: "IFC-37",
  run(ctx) {
    return perStorey(ctx, 1, (v) => LEVEL_NUM_RE.test(v), "Поле 2 корректно", "некорректный номер уровня");
  },
};

/** IFC-38: поле 3 — наименование уровня. */
const levelNameCheck: Check = {
  id: "IFC-38",
  run(ctx) {
    return perStorey(ctx, 2, (v) => LEVEL_NAMES.includes(v), "Поле 3 корректно", "недопустимое наименование");
  },
};

/** IFC-39: поле 4 — тип уровня (основной/дополнительный). */
const levelTypeCheck: Check = {
  id: "IFC-39",
  run(ctx) {
    return perStorey(ctx, 3, (v) => LEVEL_TYPES.includes(v), "Поле 4 корректно", "ожидается основной/дополнительный");
  },
};

export const LEVEL_CHECKS: Check[] = [
  zeroLevelCheck,
  nameMaskCheck,
  subObjectCheck,
  levelNumberCheck,
  levelNameCheck,
  levelTypeCheck,
];
