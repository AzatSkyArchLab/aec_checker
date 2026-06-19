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

// IFC-37: допустимая форма номера зависит от наименования уровня (поле 3).
const ABOVE_GROUND = new Set(["Этаж", "Мансардный этаж", "Чердак"]);
const PLINTH = new Set(["Цокольный этаж"]);
const BELOW_GROUND = new Set(["Подземный этаж", "Подвальный этаж"]);
const TECHNICAL = new Set(["Технический этаж", "Техническое пространство", "Техническое подполье"]);
const POS_INT = /^[1-9]\d*$/;
const NEG_INT = /^-[1-9]\d*$/;
const P_NUM = /^П[1-9]\d*$/;
const FRACTION = /^\d+\/\d+$/;

/** Номер уровня (поле 2) согласован с наименованием (поле 3) по п.4.7.8.2/Табл.4.4. */
function levelNumberValid(numStr: string, name3: string): boolean {
  if (ABOVE_GROUND.has(name3)) return POS_INT.test(numStr); // надземные — с 1
  if (PLINTH.has(name3)) return numStr === "0"; // цокольный — строго 0
  if (BELOW_GROUND.has(name3)) return NEG_INT.test(numStr) || P_NUM.test(numStr); // подземные — отриц. или П1,П2
  if (TECHNICAL.has(name3)) return FRACTION.test(numStr) || POS_INT.test(numStr) || NEG_INT.test(numStr); // тех. — «1/2» или целое
  return LEVEL_NUM_RE.test(numStr); // наименование не распознано (ловит IFC-38) — проверяем форму
}

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

/** IFC-37: поле 2 — номер уровня, согласованный с наименованием (поле 3). */
const levelNumberCheck: Check = {
  id: "IFC-37",
  run(ctx) {
    return perStorey(
      ctx,
      1,
      (v, s) => levelNumberValid(v, s.name.split("_")[2] ?? ""),
      "Поле 2 корректно",
      "номер не согласован с типом уровня",
    );
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
