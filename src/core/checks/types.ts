import type { IfcAPI } from "web-ifc";

/** Итоговый статус проверки. */
export type CheckStatus = "pass" | "warn" | "fail" | "info";

/** Один найденный сигнал внутри проверки. */
export interface CheckFinding {
  /** Что нашли, кратко (например, "IfcProjectedCRS"). */
  label: string;
  /** Значение/детали (например, "EPSG:25832, зона 32N"). */
  detail?: string;
  /** Связанный элемент — клик откроет его атрибуты. */
  expressID?: number;
}

/** Результат одной проверки модели. */
export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** Короткий вывод (что в целом нашли / не нашли). */
  summary: string;
  findings: CheckFinding[];
}

/** Контекст, который получает проверка. Проверки специфичны для IFC,
 *  поэтому им даётся прямой доступ к web-ifc. */
export interface CheckContext {
  api: IfcAPI;
  modelID: number;
}

/** Модуль-проверка. Добавление новой = реализовать этот интерфейс и
 *  зарегистрировать в checks/index.ts. */
export interface Check {
  id: string;
  title: string;
  run(ctx: CheckContext): CheckResult | Promise<CheckResult>;
}
