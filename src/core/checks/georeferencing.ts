import {
  IFCCOORDINATEOPERATION,
  IFCCOORDINATEREFERENCESYSTEM,
  IFCGEOMETRICREPRESENTATIONCONTEXT,
  IFCPOSTALADDRESS,
  IFCSITE,
} from "web-ifc";
import type { Check, CheckContext, CheckFinding, CheckRun } from "./types.ts";
import { getGeoReference } from "../geo.ts";
import { describeLocation, isInMoscow } from "./moscow.ts";

/**
 * IFC-24 «Привязка к местности»: проверяет, что модель привязана к реальным
 * координатам И что эти координаты попадают на территорию Москвы.
 *
 * Градация (п.4.5.4 требует: координаты в МСК + Балтийская система высот +
 * проектный угол поворота, для базовой точки и всех элементов):
 *   pass — точка в пределах Москвы И подтверждены СК(МСК)/высота/угол поворота
 *   warn — точка в Москве, но часть требований не подтверждена; либо есть
 *          признаки привязки, но координаты вычислить нельзя
 *   fail — привязка ведёт ВНЕ территории Москвы, либо привязки нет вовсе
 */
export const georeferencingCheck: Check = {
  id: "IFC-24",
  async run({ api, modelID }: CheckContext): Promise<CheckRun> {
    const findings: CheckFinding[] = [];
    // Признаки выполнения требований п.4.5.4 (для градации pass/warn).
    let hasCRS = false;
    let mskLikely = false;
    let hasRotation = false;
    let hasHeight = false;

    // 1. CRS: IfcProjectedCRS / IfcGeographicCRS (через базовый тип).
    for (const id of linesOfType(api, modelID, IFCCOORDINATEREFERENCESYSTEM)) {
      const l = safeLine(api, modelID, id);
      if (!l) continue;
      hasCRS = true;
      const crsText = `${text(l.Name)} ${text(l.GeodeticDatum)} ${text(l.MapProjection)}`;
      if (/МСК|\bMSK\b/i.test(crsText)) mskLikely = true;
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
    }

    // 2. MapConversion: IfcMapConversion / ...Scaled (через базовый тип).
    for (const id of linesOfType(api, modelID, IFCCOORDINATEOPERATION)) {
      const l = safeLine(api, modelID, id);
      if (!l) continue;
      const e = num(l.Eastings);
      const n = num(l.Northings);
      const h = num(l.OrthogonalHeight);
      if (h != null) hasHeight = true;
      const parts: string[] = [];
      if (e != null || n != null) parts.push(`E ${fmt(e)}, N ${fmt(n)}`);
      if (h != null) parts.push(`H ${fmt(h)}`);
      const xa = num(l.XAxisAbscissa);
      const xo = num(l.XAxisOrdinate);
      if (xa != null && xo != null) {
        hasRotation = true;
        if (xa !== 1 || xo !== 0) parts.push(`поворот ${fmt((Math.atan2(xo, xa) * 180) / Math.PI)}°`);
      }
      const s = num(l.Scale);
      if (s != null && s !== 1) parts.push(`масштаб ${fmt(s)}`);
      findings.push({
        label: typeName(api, modelID, id),
        detail: parts.join("; ") || undefined,
        expressID: id,
      });
    }

    // 3. IfcSite: RefLatitude / RefLongitude / RefElevation (LoGeoRef 40).
    for (const id of linesOfType(api, modelID, IFCSITE)) {
      const site = safeLine(api, modelID, id);
      if (!site) continue;
      const lat = compoundAngleToDeg(site.RefLatitude);
      const lon = compoundAngleToDeg(site.RefLongitude);
      const elev = num(site.RefElevation);
      if (lat == null && lon == null && elev == null) continue;
      if (elev != null) hasHeight = true;
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
      hasRotation = true;
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

    // Вычисляем фактический якорь (широта/долгота) и проверяем территорию Москвы.
    const ref = await getGeoReference(api, modelID);
    if (ref.ok) {
      const { lat0, lng0 } = ref.ref;
      const coord = `${lat0.toFixed(5)}°, ${lng0.toFixed(5)}°`;
      if (isInMoscow(lat0, lng0)) {
        // pass только при подтверждении всех требований п.4.5.4; иначе honest warn.
        const unmet: string[] = [];
        if (!hasHeight) unmet.push("высотная отметка (Z / Балтийская система)");
        if (!hasRotation) unmet.push("проектный угол поворота");
        if (!hasCRS) unmet.push("СК (IfcProjectedCRS)");
        else if (!mskLikely) unmet.push("СК не подтверждена как МСК");
        if (unmet.length === 0) {
          return { status: "pass", summary: `Привязка в пределах Москвы: ${coord}`, findings };
        }
        return {
          status: "warn",
          summary: `Привязка в Москве (${coord}), но не подтверждено: ${unmet.join("; ")}`,
          findings: [
            { label: "Не подтверждено", detail: unmet.join("; ") },
            ...findings,
          ],
        };
      }
      return {
        status: "fail",
        summary: `Привязка ВНЕ территории Москвы: ${coord} (${describeLocation(lat0, lng0)})`,
        findings: [
          { label: "Координаты вне Москвы", detail: `${coord} — ${describeLocation(lat0, lng0)}` },
          ...findings,
        ],
      };
    }

    // Якорь вычислить нельзя.
    if (findings.length > 0) {
      return {
        status: "warn",
        summary: `Признаки привязки есть, но координаты не определить: ${ref.reason}`,
        findings,
      };
    }
    return {
      status: "fail",
      summary: "Геопривязка не найдена — нет ни одного упоминания координат",
      findings,
    };
  },
};

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
