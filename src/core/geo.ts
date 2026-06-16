import {
  IFCCOORDINATEOPERATION,
  IFCCOORDINATEREFERENCESYSTEM,
  IFCGEOMETRICREPRESENTATIONCONTEXT,
  IFCSITE,
} from "web-ifc";
import type {
  Footprint,
  GeoFootprint,
  GeoReference,
  IfcMeshData,
  ModelOffset,
  Point2,
} from "./types.ts";

const EARTH_RADIUS = 6378137; // WGS84, м
const DEG = 180 / Math.PI;

/** Результат построения привязки. */
export type GeoRefResult =
  | { ok: true; ref: GeoReference }
  | { ok: false; reason: string };

/** Результат построения гео-контура. */
export type FootprintResult =
  | { ok: true; footprint: GeoFootprint }
  | { ok: false; reason: string };

/**
 * Строит привязку локальных координат IFC к WGS84.
 * Приоритет точки отсчёта: широта/долгота IfcSite (без сторонних библиотек),
 * иначе IfcMapConversion + проекция (proj4, ограниченный набор EPSG).
 * Поворот/масштаб: из MapConversion, иначе из TrueNorth, иначе единичные.
 */
export async function getGeoReference(
  api: IfcAPILike,
  modelID: number,
): Promise<GeoRefResult> {
  const mapConv = readMapConversion(api, modelID);
  const site = readSiteLatLng(api, modelID);
  const trueNorth = readTrueNorth(api, modelID);

  // Орты восток/север в локальной системе + масштаб.
  let east: Point2;
  let north: Point2;
  let scale = 1;
  let rotSource: string;
  if (mapConv) {
    east = [mapConv.a, -mapConv.b];
    north = [mapConv.b, mapConv.a];
    scale = mapConv.scale;
    rotSource = "MapConversion";
  } else if (trueNorth) {
    const len = Math.hypot(trueNorth.x, trueNorth.y) || 1;
    north = [trueNorth.x / len, trueNorth.y / len];
    east = [north[1], -north[0]];
    rotSource = "TrueNorth";
  } else {
    east = [1, 0];
    north = [0, 1];
    rotSource = "без поворота";
  }

  // Точка отсчёта.
  if (site) {
    return {
      ok: true,
      ref: {
        lat0: site.lat,
        lng0: site.lng,
        east,
        north,
        scale,
        method: `IfcSite (широта/долгота), поворот: ${rotSource}`,
      },
    };
  }

  if (mapConv && mapConv.E != null && mapConv.N != null) {
    const epsg = readProjectedCrsName(api, modelID);
    const def = epsgToProj4(epsg);
    if (!def) {
      return {
        ok: false,
        reason: `Проекция ${epsg ?? "(не указана)"} пока не поддержана. Нужны широта/долгота в IfcSite либо UTM-проекция.`,
      };
    }
    try {
      const proj4 = (await import("proj4")).default;
      const [lng0, lat0] = proj4(def, "WGS84", [mapConv.E, mapConv.N]);
      return {
        ok: true,
        ref: {
          lat0,
          lng0,
          east,
          north,
          scale,
          method: `IfcMapConversion + ${epsg} (proj4)`,
        },
      };
    } catch (err) {
      return { ok: false, reason: `Ошибка проекции: ${(err as Error).message}` };
    }
  }

  return {
    ok: false,
    reason:
      "Нет точки отсчёта: ни широты/долготы IfcSite, ни координат MapConversion.",
  };
}

/**
 * Горизонтальный срез всей геометрии на уровне 0 (мировой Z=0 IFC).
 * Возвращает контуры в горизонтальных координатах IFC (X, Y), метры.
 *
 * ВАЖНО: web-ifc отдаёт геометрию в системе Y-up (для three.js), поэтому
 * «верх» — это ось Y мешей, горизонтальная плоскость — X-Z. Связь с IFC:
 * ifc_x = webifc_x, ifc_y = −webifc_z (поворот −90° вокруг X).
 */
export function computeFootprint(
  meshes: IfcMeshData[],
  offset: ModelOffset,
): Footprint {
  // Диапазон высоты (ось Y мешей, со снятым offset).
  let minY = Infinity;
  let maxY = -Infinity;
  for (const m of meshes) {
    for (let i = 1; i < m.positions.length; i += 3) {
      const y = m.positions[i];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  // «Уровень 0» = основание модели, а не абсолютный мировой Z=0: многие модели
  // подняты на высоту площадки/этажа, и срез по мировому 0 был бы пустым.
  // Режем чуть выше самой нижней точки, чтобы пройти сквозь стены первого этажа.
  const lift = Math.max((maxY - minY) * 0.01, 0.02);
  const sliceY = minY + lift;

  const rings: Point2[][] = [];
  const lines: Point2[][] = [];
  // Точка среза (X_meш, Z_meш) → горизонталь IFC: x = X+offset.x, y = −(Z+offset.z).
  const toIfc = (p: Point2): Point2 => [p[0] + offset.x, -(p[1] + offset.z)];
  for (const m of meshes) {
    const segs = sliceMesh(m.positions, m.indices, sliceY);
    if (segs.length === 0) continue;
    const { loops, open } = stitch(segs);
    for (const lp of loops) rings.push(lp.map(toIfc));
    for (const ln of open) lines.push(ln.map(toIfc));
  }
  return { rings, lines };
}

/** Проецирует контур (мировые координаты IFC) на карту через привязку. */
export function footprintToGeo(
  footprint: Footprint,
  ref: GeoReference,
): GeoFootprint {
  const toLL = (p: Point2) => localToGeo(ref, p[0], p[1]);
  return {
    anchor: [ref.lat0, ref.lng0],
    rings: footprint.rings.map((r) => r.map(toLL)),
    lines: footprint.lines.map((l) => l.map(toLL)),
    method: ref.method,
  };
}

function localToGeo(ref: GeoReference, x: number, y: number): [number, number] {
  const e = (x * ref.east[0] + y * ref.east[1]) * ref.scale;
  const n = (x * ref.north[0] + y * ref.north[1]) * ref.scale;
  const lat = ref.lat0 + (n / EARTH_RADIUS) * DEG;
  const lng =
    ref.lng0 + (e / (EARTH_RADIUS * Math.cos((ref.lat0 * Math.PI) / 180))) * DEG;
  return [lat, lng];
}

// ── Срез одного меша ──────────────────────────────────────────────────────────

/** Срез одного меша горизонтальной плоскостью Y=yPlane (Y — «верх» web-ifc).
 *  Точки отрезков — горизонтальные координаты мешей (X, Z). */
function sliceMesh(
  positions: Float32Array,
  indices: Uint32Array,
  yPlane: number,
): [Point2, Point2][] {
  const segs: [Point2, Point2][] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const pts: Point2[] = [];
    addCrossing(positions, a, b, yPlane, pts);
    addCrossing(positions, b, c, yPlane, pts);
    addCrossing(positions, c, a, yPlane, pts);
    if (pts.length === 2) segs.push([pts[0], pts[1]]);
  }
  return segs;
}

function addCrossing(
  pos: Float32Array,
  p: number,
  q: number,
  yPlane: number,
  out: Point2[],
): void {
  const py = pos[p + 1];
  const qy = pos[q + 1];
  if (py > yPlane === qy > yPlane) return; // ребро не пересекает плоскость
  const tt = (yPlane - py) / (qy - py);
  out.push([
    pos[p] + tt * (pos[q] - pos[p]), // X
    pos[p + 2] + tt * (pos[q + 2] - pos[p + 2]), // Z
  ]);
}

// ── Сшивка отрезков в контуры ────────────────────────────────────────────────

/** Склеивает отрезки в замкнутые контуры (порог 1 мм). */
function stitch(segs: [Point2, Point2][]): {
  loops: Point2[][];
  open: Point2[][];
} {
  const keyOf = (p: Point2) =>
    `${Math.round(p[0] * 1000)}_${Math.round(p[1] * 1000)}`;
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const pos = new Map<string, Point2>();
  const adj = new Map<string, Set<string>>();
  const edges = new Set<string>();
  for (const [a, b] of segs) {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka === kb) continue;
    pos.set(ka, a);
    pos.set(kb, b);
    (adj.get(ka) ?? adj.set(ka, new Set()).get(ka)!).add(kb);
    (adj.get(kb) ?? adj.set(kb, new Set()).get(kb)!).add(ka);
    edges.add(edgeKey(ka, kb));
  }

  const loops: Point2[][] = [];
  const open: Point2[][] = [];
  const used = new Set<string>();
  for (const start of edges) {
    if (used.has(start)) continue;
    const first = start.split("|")[0];
    const path = [first];
    let cur = first;
    // Идём по неиспользованным рёбрам, пока не замкнёмся или не упрёмся.
    for (let guard = 0; guard < edges.size + 1; guard++) {
      const next = [...(adj.get(cur) ?? [])].find(
        (n) => !used.has(edgeKey(cur, n)),
      );
      if (next == null) break;
      used.add(edgeKey(cur, next));
      path.push(next);
      cur = next;
      if (cur === first) break;
    }
    const ptsPath = path.map((k) => pos.get(k)!);
    if (cur === first && path.length >= 4) loops.push(ptsPath);
    else if (ptsPath.length >= 2) open.push(ptsPath);
  }
  return { loops, open };
}

// ── Чтение сущностей привязки ────────────────────────────────────────────────

interface MapConv {
  E: number | null;
  N: number | null;
  a: number;
  b: number;
  scale: number;
}

function readMapConversion(api: IfcAPILike, modelID: number): MapConv | null {
  for (const id of linesOfType(api, modelID, IFCCOORDINATEOPERATION)) {
    const l = safeLine(api, modelID, id);
    const a = num(l?.XAxisAbscissa);
    const b = num(l?.XAxisOrdinate);
    if (a == null || b == null) continue;
    return {
      E: num(l.Eastings),
      N: num(l.Northings),
      a,
      b,
      scale: num(l.Scale) ?? 1,
    };
  }
  return null;
}

function readSiteLatLng(
  api: IfcAPILike,
  modelID: number,
): { lat: number; lng: number } | null {
  for (const id of linesOfType(api, modelID, IFCSITE)) {
    const s = safeLine(api, modelID, id);
    const lat = compoundAngleToDeg(s?.RefLatitude);
    const lng = compoundAngleToDeg(s?.RefLongitude);
    if (lat != null && lng != null) return { lat, lng };
  }
  return null;
}

function readTrueNorth(
  api: IfcAPILike,
  modelID: number,
): { x: number; y: number } | null {
  for (const id of linesOfType(api, modelID, IFCGEOMETRICREPRESENTATIONCONTEXT)) {
    const ctx = safeLine(api, modelID, id);
    const ref = ctx?.TrueNorth;
    if (!ref || typeof ref.value !== "number") continue;
    const dir = safeLine(api, modelID, ref.value);
    const r = (dir?.DirectionRatios ?? []).map((v: unknown) => num(v));
    if (r.length >= 2 && r[0] != null && r[1] != null) return { x: r[0], y: r[1] };
  }
  return null;
}

function readProjectedCrsName(api: IfcAPILike, modelID: number): string | null {
  for (const id of linesOfType(api, modelID, IFCCOORDINATEREFERENCESYSTEM)) {
    const l = safeLine(api, modelID, id);
    const name = text(l?.Name);
    if (name) return name;
  }
  return null;
}

/** Минимальный набор EPSG → proj4 (UTM-семейство, наиболее частые). */
function epsgToProj4(name: string | null): string | null {
  if (!name) return null;
  const m = /(\d{4,5})/.exec(name);
  if (!m) return null;
  const code = Number(m[1]);
  if (code >= 32601 && code <= 32660)
    return `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
  if (code >= 32701 && code <= 32760)
    return `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
  if (code >= 25828 && code <= 25838)
    return `+proj=utm +zone=${code - 25800} +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs`;
  return null;
}

// ── Утилиты чтения (локальные, чтобы geo не зависел от модуля проверок) ────────

function linesOfType(api: IfcAPILike, modelID: number, type: number): number[] {
  try {
    const v = api.GetLineIDsWithType(modelID, type, true);
    const out: number[] = [];
    for (let i = 0; i < v.size(); i++) out.push(v.get(i));
    return out;
  } catch {
    return [];
  }
}

function safeLine(api: IfcAPILike, modelID: number, id: number): any {
  try {
    return api.GetLine(modelID, id, false);
  } catch {
    return null;
  }
}

function num(v: any): number | null {
  if (v == null) return null;
  const raw = typeof v === "object" && "value" in v ? v.value : v;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function text(v: any): string {
  if (v == null) return "";
  if (typeof v === "object" && "value" in v) return v.value == null ? "" : String(v.value);
  return String(v);
}

function compoundAngleToDeg(raw: any): number | null {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.value) ? raw.value : null;
  if (!arr) return null;
  const nums = arr.map((v: any) => num(v)).filter((v: number | null) => v != null) as number[];
  if (nums.length === 0) return null;
  const [d = 0, m = 0, s = 0, us = 0] = nums;
  const sign = d < 0 || m < 0 || s < 0 || us < 0 ? -1 : 1;
  return sign * (Math.abs(d) + Math.abs(m) / 60 + (Math.abs(s) + Math.abs(us) / 1e6) / 3600);
}

/** Минимальная форма IfcAPI, нужная geo-модулю. */
interface IfcAPILike {
  GetLineIDsWithType(
    modelID: number,
    type: number,
    includeInherited?: boolean,
  ): { size(): number; get(i: number): number };
  GetLine(modelID: number, id: number, flatten?: boolean): any;
}
