import type { IfcAPI } from "web-ifc";

/**
 * Статус проверки:
 *  pass/warn/fail/info — результат выполненной авто-проверки;
 *  todo — авто-проверка ещё не реализована;
 *  manual — требует ручной/внешней проверки (УКЭП, BCF, коллизии и т.п.).
 */
export type CheckStatus = "pass" | "warn" | "fail" | "info" | "todo" | "manual";

/** Один найденный сигнал внутри проверки. */
export interface CheckFinding {
  /** Что нашли, кратко (например, "IfcProjectedCRS"). */
  label: string;
  /** Значение/детали (например, "EPSG:25832, зона 32N"). */
  detail?: string;
  /** Связанный элемент — клик откроет его атрибуты. */
  expressID?: number;
}

/** Описание проверки из реестра ЦИМ АГР (метаданные, без логики). */
export interface CheckSpec {
  id: string;
  category: string;
  name: string;
  /** Источник — пункт НПА. */
  source: string;
  /** Текст алгоритма проверки из реестра. */
  algorithm: string;
  priority: string; // High | Med | Low
  complexity: string; // Low | Med | High
  automatable: string; // Да | Частично
  /** Можем ли выполнить в этом инструменте: auto — реализуемо, manual — вручную. */
  mode: "auto" | "manual";
}

/** Контекст, который получает проверка (прямой доступ к web-ifc + мета файла). */
export interface CheckContext {
  api: IfcAPI;
  modelID: number;
  /** Имя загруженного файла (для проверок именования/формата). */
  fileName: string;
  /** Размер файла в байтах. */
  fileSize: number;
}

/** Результат выполнения авто-проверки (без метаданных — их несёт CheckSpec). */
export interface CheckRun {
  status: CheckStatus;
  summary: string;
  findings: CheckFinding[];
}

/** Реализация авто-проверки. id связывает её с записью каталога. */
export interface Check {
  id: string;
  run(ctx: CheckContext): CheckRun | Promise<CheckRun>;
}

/** Запись каталога + текущий статус (метаданные + результат/«ручная»/«todo»). */
export interface CheckOutcome {
  spec: CheckSpec;
  status: CheckStatus;
  summary: string;
  findings: CheckFinding[];
}
