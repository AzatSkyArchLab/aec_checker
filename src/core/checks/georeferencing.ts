import {
  IFCCOORDINATEOPERATION,
  IFCCOORDINATEREFERENCESYSTEM,
  IFCGEOMETRICREPRESENTATIONCONTEXT,
  IFCPOSTALADDRESS,
  IFCSITE,
} from "web-ifc";
import type { Check, CheckContext, CheckFinding, CheckResult } from "./types.ts";

/**
 * Проверка геопривязки: ищет ЛЮБЫЕ признаки того, что модель привязана
 * к реальным координатам. Покрывает все типовые способы хранения георефа в IFC.
 *
 * Градация:
 *   pass — есть CRS и/или MapConversion (полноценная привязка, LoGeoRef 50)
 *   warn — есть только частичные признаки (широта/долгота сайта, истинный
 *          север, адрес) — привязка неполная
 *   fail — никаких упоминаний геопривязки не найдено
 */
export const georeferencingCheck: Check = {
  id: "georeferencing",
  title: "Геопривязка",
  run({ api, modelID }: CheckContext): CheckResult {
    const findings: CheckFinding[] = [];
    let strong = false; // полноценная привязка (CRS / MapConversion)

    // 1. CRS: IfcProjectedCRS / IfcGeographicCRS (через базовый тип).
    for (const id of linesOfType(api, modelID, IFCCOORDINATEREFERENCESYSTEM)) {
      const l = safeLine(api, modelID, id);
      if (!l) continue;
      const parts = [
        text(l.Name),
        text(l.GeodeticDatum) && `датум ${text(l.GeodeticDatum)}`,
        text(l.MapProjection) && `проекция ${text(l.MapProjection)}`,
        text(l.MapZone) && `зона ${text(l.MapZone)}`,
      ].filter(Boolean);
      findings.push({
        label: typeName(api, modelID, id),
        detail: parts.join(", ") || undefined,
        expressID: id,
      });
      strong = true;
    }

    // 2. MapConversion: IfcMapConversion / ...Scaled (через базовый тип).
    for (const id of linesOfType(api, modelID, IFCCOORDINATEOPERATION)) {
      const l = safeLine(api, modelID, id);
      if (!l) continue;
      const e = num(l.Eastings);
      const n = num(l.Northings);
      const h = num(l.OrthogonalHeight);
      const parts: string[] = [];
      if (e != null || n != null) parts.push(`E ${fmt(e)}, N ${fmt(n)}`);
      if (h != null) parts.push(`H ${fmt(h)}`);
      const xa = num(l.XAxisAbscissa);
      const xo = num(l.XAxisOrdinate);
      if (xa != null && xo != null && (xa !== 1 || xo !== 0)) {
        parts.push(`поворот ${fmt((Math.atan2(xo, xa) * 180) / Math.PI)}°`);
      }
      const s = num(l.Scale);
      if (s != null && s !== 1) parts.push(`масштаб ${fmt(s)}`);
      findings.push({
        label: typeName(api, modelID, id),
        detail: parts.join("; ") || undefined,
        expressID: id,
      });
      strong = true;
    }

    // 3. IfcSite: RefLatitude / RefLongitude / RefElevation (LoGeoRef 40).
    for (const id of linesOfType(api, modelID, IFCSITE)) {
      const site = safeLine(api, modelID, id);
      if (!site) continue;
      const lat = compoundAngleToDeg(site.RefLatitude);
      const lon = compoundAngleToDeg(site.RefLongitude);
      const elev = num(site.RefElevation);
      if (lat == null && lon == null && elev == null) continue;
      const parts: string[] = [];
      if (lat != null && lon != null) {
        parts.push(`${lat.toFixed(6)}°, ${lon.toFixed(6)}°`);
      } else {
        if (lat != null) parts.push(`шир. ${lat.toFixed(6)}°`);
        if (lon != null) parts.push(`долг. ${lon.toFixed(6)}°`);
      }
      if (elev != null) parts.push(`высота ${fmt(elev)} м`);
      findings.push({
        label: "IfcSite RefLatitude/Longitude",
        detail: parts.join(", "),
        expressID: id,
      });
    }

    // 4. Истинный север (TrueNorth) в контекстах представления.
    for (const id of linesOfType(api, modelID, IFCGEOMETRICREPRESENTATIONCONTEXT)) {
      const ctx = safeLine(api, modelID, id);
      const ref = ctx?.TrueNorth;
      if (!ref || typeof ref.value !== "number") continue;
      let detail: string | undefined;
      const dir = safeLine(api, modelID, ref.value);
      const ratios = (dir?.DirectionRatios ?? []).map((v: any) => num(v));
      if (ratios.length >= 2 && ratios[0] != null && ratios[1] != null) {
        const az = (Math.atan2(ratios[0], ratios[1]) * 180) / Math.PI;
        detail = `азимут ${fmt(az)}°`;
      }
      findings.push({ label: "TrueNorth (истинный север)", detail, expressID: id });
    }

    // 5. Почтовый адрес — слабый признак расположения.
    for (const id of linesOfType(api, modelID, IFCPOSTALADDRESS)) {
      const a = safeLine(api, modelID, id);
      if (!a) continue;
      const lines = (a.AddressLines ?? []).map((v: any) => text(v));
      const parts = [
        ...lines,
        text(a.PostalCode),
        text(a.Town),
        text(a.Region),
        text(a.Country),
      ].filter(Boolean);
      if (parts.length) {
        findings.push({
          label: "Почтовый адрес",
          detail: parts.join(", "),
          expressID: id,
        });
      }
    }

    return finalize(findings, strong);
  },
};

function finalize(findings: CheckFinding[], strong: boolean): CheckResult {
  let status: CheckResult["status"];
  let summary: string;
  if (findings.length === 0) {
    status = "fail";
    summary = "Геопривязка не найдена — нет ни одного упоминания координат";
  } else if (strong) {
    status = "pass";
    summary = `Геопривязка задана (${findings.length} призн.): CRS/MapConversion`;
  } else {
    status = "warn";
    summary = `Только частичные признаки (${findings.length}) — полноценной CRS/MapConversion нет`;
  }
  return { id: "georeferencing", title: "Геопривязка", status, summary, findings };
}

// ── Утилиты ──────────────────────────────────────────────────────────────────

function linesOfType(api: IfcAPILike, modelID: number, type: number): number[] {
  try {
    const v = api.GetLineIDsWithType(modelID, type, true);
    const out: number[] = [];
    for (let i = 0; i < v.size(); i++) out.push(v.get(i));
    return out;
  } catch {
    return []; // тип может отсутствовать в схеме (например, IFC2x3)
  }
}

function safeLine(api: IfcAPILike, modelID: number, id: number): any {
  try {
    return api.GetLine(modelID, id, false);
  } catch {
    return null;
  }
}

function typeName(api: IfcAPILike, modelID: number, id: number): string {
  try {
    return api.GetNameFromTypeCode(api.GetLineType(modelID, id));
  } catch {
    return "IfcEntity";
  }
}

/** Разворачивает { value } или примитив в строку. */
function text(v: any): string {
  if (v == null) return "";
  if (typeof v === "object" && "value" in v) return v.value == null ? "" : String(v.value);
  return String(v);
}

/** Достаёт число из { value } / примитива. */
function num(v: any): number | null {
  if (v == null) return null;
  const raw = typeof v === "object" && "value" in v ? v.value : v;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Форматирует число для UI (без хвостовых нулей). */
function fmt(n: number | null): string {
  if (n == null) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
}

/**
 * IfcCompoundPlaneAngleMeasure → десятичные градусы.
 * Формат: [градусы, минуты, секунды, миллионные доли секунды], знак — у градусов.
 */
function compoundAngleToDeg(raw: any): number | null {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.value) ? raw.value : null;
  if (!arr) return null;
  const nums = arr.map((v: any) => num(v)).filter((v: number | null) => v != null) as number[];
  if (nums.length === 0) return null;
  const [d = 0, m = 0, s = 0, us = 0] = nums;
  const sign = d < 0 || m < 0 || s < 0 || us < 0 ? -1 : 1;
  const deg =
    Math.abs(d) + Math.abs(m) / 60 + (Math.abs(s) + Math.abs(us) / 1e6) / 3600;
  return sign * deg;
}

/** Минимальная форма IfcAPI, нужная проверке (для локальной типизации утилит). */
interface IfcAPILike {
  GetLineIDsWithType(
    modelID: number,
    type: number,
    includeInherited?: boolean,
  ): { size(): number; get(i: number): number };
  GetLine(modelID: number, id: number, flatten?: boolean): any;
  GetLineType(modelID: number, id: number): number;
  GetNameFromTypeCode(type: number): string;
}
