import type { CheckContext } from "./types.ts";

/** Express ID всех строк типа (опц. с наследниками). */
export function idsOfType(
  ctx: CheckContext,
  type: number,
  includeInherited = false,
): number[] {
  try {
    const v = ctx.api.GetLineIDsWithType(ctx.modelID, type, includeInherited);
    const out: number[] = [];
    for (let i = 0; i < v.size(); i++) out.push(v.get(i));
    return out;
  } catch {
    return [];
  }
}

/** Безопасный GetLine (flatten=false). */
export function line(ctx: CheckContext, id: number): any {
  try {
    return ctx.api.GetLine(ctx.modelID, id, false);
  } catch {
    return null;
  }
}

/** Разворачивает { value } / примитив в строку (""). */
export function str(v: any): string {
  if (v == null) return "";
  if (typeof v === "object" && "value" in v) return v.value == null ? "" : String(v.value);
  return String(v);
}

/** Число из { value } / примитива либо null. */
export function num(v: any): number | null {
  if (v == null) return null;
  const raw = typeof v === "object" && "value" in v ? v.value : v;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Человекочитаемое имя типа элемента (IfcWall и т.п.). */
export function typeName(ctx: CheckContext, id: number): string {
  try {
    return ctx.api.GetNameFromTypeCode(ctx.api.GetLineType(ctx.modelID, id));
  } catch {
    return "IfcEntity";
  }
}
