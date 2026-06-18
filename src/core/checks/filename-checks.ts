import type { Check, CheckContext, CheckRun } from "./types.ts";

// Маска: <вид>_<объект>_<подобъект>_<шифр ЦИМ>_<этап>[_<версия>]
const FORBIDDEN = /[\s,!."#;%:^?&*()\[\]{}+='~\\/]/;
const DISCIPLINES = ["АР", "ПС", "БиО"]; // шифры ЦИМ на этапе АГР

function baseName(ctx: CheckContext): string {
  return (ctx.fileName || "").replace(/\.ifc$/i, "");
}
function fields(ctx: CheckContext): string[] {
  return baseName(ctx).split("_");
}
function noName(): CheckRun {
  return { status: "warn", summary: "Имя файла недоступно", findings: [] };
}
const pass = (summary: string): CheckRun => ({ status: "pass", summary, findings: [] });
const fail = (summary: string): CheckRun => ({ status: "fail", summary, findings: [] });
const warn = (summary: string): CheckRun => ({ status: "warn", summary, findings: [] });

/** IFC-11: структура имени из обязательных полей (≥5). */
const maskCheck: Check = {
  id: "IFC-11",
  run(ctx) {
    if (!ctx.fileName) return noName();
    const f = fields(ctx);
    const ok = f.length >= 5 && f.slice(0, 5).every((x) => x.length > 0);
    return ok
      ? pass(`Полей: ${f.length} (≥5)`)
      : fail(`Полей: ${f.length} — нужно ≥5 непустых`);
  },
};

/** IFC-12: разделитель полей — символ "_". */
const separatorCheck: Check = {
  id: "IFC-12",
  run(ctx) {
    if (!ctx.fileName) return noName();
    return baseName(ctx).includes("_")
      ? pass('Разделитель "_" используется')
      : fail('Разделитель "_" не найден');
  },
};

/** IFC-13: запрет пробелов и недопустимых символов. */
const forbiddenCharsCheck: Check = {
  id: "IFC-13",
  run(ctx) {
    if (!ctx.fileName) return noName();
    const m = baseName(ctx).match(FORBIDDEN);
    return m
      ? fail(`Недопустимый символ: "${m[0] === " " ? "пробел" : m[0]}"`)
      : pass("Недопустимых символов нет");
  },
};

/** IFC-14: поле 1 «Шифр вида объекта» = НН (непроизводственный). */
const objectKindCheck: Check = {
  id: "IFC-14",
  run(ctx) {
    if (!ctx.fileName) return noName();
    const f0 = fields(ctx)[0] ?? "";
    return f0 === "НН"
      ? pass("Поле 1: НН")
      : warn(`Поле 1: "${f0}" — ожидалось НН для непроизводственного объекта`);
  },
};

/** IFC-15: поле 2 «Номер объекта (корпуса)» — ОБxx или Кxx. */
const objectNumberCheck: Check = {
  id: "IFC-15",
  run(ctx) {
    if (!ctx.fileName) return noName();
    const f1 = fields(ctx)[1] ?? "";
    return /^(ОБ|К)\d{2}$/.test(f1)
      ? pass(`Поле 2: ${f1}`)
      : fail(`Поле 2: "${f1}" — ожидается ОБxx или Кxx`);
  },
};

/** IFC-16: поле 3 «Номер подобъекта (секции)» — Пxx или Сxx. */
const subObjectNumberCheck: Check = {
  id: "IFC-16",
  run(ctx) {
    if (!ctx.fileName) return noName();
    const f2 = fields(ctx)[2] ?? "";
    return /^(П|С)\d{2}$/.test(f2)
      ? pass(`Поле 3: ${f2}`)
      : fail(`Поле 3: "${f2}" — ожидается Пxx или Сxx`);
  },
};

/** IFC-17: поле 4 «Шифр ЦИМ» — дисциплинарный код (АР/ПС/БиО). */
const disciplineCheck: Check = {
  id: "IFC-17",
  run(ctx) {
    if (!ctx.fileName) return noName();
    const f3 = fields(ctx)[3] ?? "";
    return DISCIPLINES.includes(f3)
      ? pass(`Поле 4: ${f3}`)
      : warn(`Поле 4: "${f3}" — нестандартный шифр ЦИМ`);
  },
};

/** IFC-18: поле 5 «Шифр этапа» = АГР. */
const stageCheck: Check = {
  id: "IFC-18",
  run(ctx) {
    if (!ctx.fileName) return noName();
    const f4 = fields(ctx)[4] ?? "";
    return f4 === "АГР" ? pass("Поле 5: АГР") : fail(`Поле 5: "${f4}" — ожидается АГР`);
  },
};

export const FILENAME_CHECKS: Check[] = [
  maskCheck,
  separatorCheck,
  forbiddenCharsCheck,
  objectKindCheck,
  objectNumberCheck,
  subObjectNumberCheck,
  disciplineCheck,
  stageCheck,
];
