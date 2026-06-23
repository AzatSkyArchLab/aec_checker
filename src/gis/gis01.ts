/**
 * Проверка GIS-01 «Здание полностью в границах земельного участка».
 *
 * Срезы здания относительно его собственной геометрии: с +0.01 м, далее каждые
 * 1.5 м до верха. Точки каждого среза переводятся в МСК-77 (с учётом калибровки)
 * и проверяются на попадание в полигон ЗУ из ГПЗУ. Результат:
 *   pass — ни одна точка ни на одной высоте не выходит за границы ЗУ;
 *   warn — основание в границах, но выше некоторой высоты часть выступает;
 *   fail — уже основание выходит за границы ЗУ.
 * Плюс SVG-эскиз (вид сверху) для отчёта.
 */
export type Pt = [number, number];

export interface FbxGeom {
  meshes: { world: Float32Array; index: ArrayLike<number> | null; cloud: boolean }[];
  min: number[];
  max: number[];
  vAxis: number;
  hA: number;
  hB: number;
  isCloud: boolean;
}

export interface Gis01Level {
  hRel: number; // высота над основанием, м
  total: number; // точек среза
  outside: number; // точек вне ЗУ
  insideEN: Pt[]; // [east, north] МСК-77
  outsideEN: Pt[];
}

export interface Gis01Result {
  status: "pass" | "warn" | "fail";
  summary: string;
  topRel: number; // высота здания, м
  levels: Gis01Level[];
  baseLevel: Gis01Level | null;
  exitLevel: Gis01Level | null; // первая высота с выходом за границы
  parcelEN: Pt[]; // внешний контур ЗУ [east, north] (наибольший — для центроида/смещения)
  parcelHoles: Pt[][]; // дырки (исключённые внутренние области) наибольшего ЗУ
  parcelPolys: PolyWithHoles[]; // ВСЕ границы ЗУ (объединение всех источников) — для эскиза/проверки
  noOverlap: boolean; // объект НИ ОДНОЙ точкой не попал в ЗУ (проблема координат)
  offsetM: number; // расстояние центр объекта ↔ центр ЗУ, м
  buildingCentroidEN: Pt | null;
  contourEN: Pt[][]; // точный контур основания (МСК-77): меш→сшитые кольца, облако→вогнутая оболочка
  contourOutsideEN: Pt[]; // вершины контура вне ЗУ (для эскиза)
}

const STEP = 1.5; // шаг срезов, м
const CLOUD_BAND = 0.75; // полуширина полосы для облака точек, м

/** Горизонтальные координаты точек среза здания на высоте h (в осях hA/hB FBX). */
function slicePts(geom: FbxGeom, h: number): Pt[] {
  const { meshes, vAxis, hA, hB } = geom;
  const out: Pt[] = [];
  for (const m of meshes) {
    const p = m.world;
    if (m.cloud) {
      // Реальное облако точек — берём точки в полосе вокруг высоты среза.
      for (let i = 0; i < p.length; i += 3) {
        if (Math.abs(p[i + vAxis] - h) <= CLOUD_BAND) out.push([p[i + hA], p[i + hB]]);
      }
      continue;
    }
    // Поверхность: пересечение рёбер треугольников плоскостью среза. Индексированный
    // путь — по index; неиндексированный — вершины тройками подряд (a=3t,…).
    const idx = m.index;
    const indexed = !!idx && idx.length >= 3;
    const triCount = indexed ? Math.floor(idx!.length / 3) : Math.floor(p.length / 9);
    for (let t = 0; t < triCount; t++) {
      const a = indexed ? idx![t * 3] * 3 : t * 9;
      const b = indexed ? idx![t * 3 + 1] * 3 : t * 9 + 3;
      const c = indexed ? idx![t * 3 + 2] * 3 : t * 9 + 6;
      crossEdge(p, a, b, vAxis, hA, hB, h, out);
      crossEdge(p, b, c, vAxis, hA, hB, h, out);
      crossEdge(p, c, a, vAxis, hA, hB, h, out);
    }
  }
  return out;
}

function crossEdge(p: Float32Array, i: number, j: number, vAxis: number, hA: number, hB: number, plane: number, out: Pt[]): void {
  const vi = p[i + vAxis], vj = p[j + vAxis];
  if (vi > plane === vj > plane) return;
  const t = (plane - vi) / (vj - vi);
  out.push([p[i + hA] + t * (p[j + hA] - p[i + hA]), p[i + hB] + t * (p[j + hB] - p[i + hB])]);
}

/** Точка [east,north] внутри кольца [east,north] (ray casting). */
export function pointInRing(pt: Pt, ring: Pt[]): boolean {
  const x = pt[0], y = pt[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function ringArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}

/** Полигон ЗУ: внешний контур + дырки (исключённые внутренние области). */
export interface PolyWithHoles {
  exterior: Pt[];
  holes: Pt[][];
}

/**
 * Классифицирует набор замкнутых колец на полигоны с дырками по вложенности
 * (правило even-odd): кольцо с чётной глубиной вложения — внешний контур,
 * с нечётной — дырка, привязанная к ближайшему (наименьшему охватывающему) контуру.
 * Так корректно разбираются: внешний+дырки, несколько участков, остров-в-дырке.
 */
export function classifyRings(rings: Pt[][]): PolyWithHoles[] {
  const items = rings
    .filter((r) => r.length >= 3)
    .map((r) => ({ r, a: ringArea(r), c: centroidOf(r) as Pt }))
    .sort((x, y) => y.a - x.a); // от большего к меньшему
  const polys: PolyWithHoles[] = [];
  const exteriorOf = new Map<Pt[], PolyWithHoles>();
  for (const it of items) {
    const containers = items.filter((o) => o !== it && o.a > it.a && pointInRing(it.c, o.r));
    if (containers.length % 2 === 0) {
      const poly: PolyWithHoles = { exterior: it.r, holes: [] };
      polys.push(poly);
      exteriorOf.set(it.r, poly);
    } else {
      const parent = containers.sort((a, b) => a.a - b.a)[0]; // ближайший охватывающий
      const host = exteriorOf.get(parent.r);
      if (host) host.holes.push(it.r);
      else polys.push({ exterior: it.r, holes: [] }); // fallback (дырка в дырке)
    }
  }
  return polys;
}

/** Точка внутри полигона с дырками: внутри внешнего И не в одной из дырок. */
export function pointInPolygon(pt: Pt, exterior: Pt[], holes: Pt[][]): boolean {
  if (!pointInRing(pt, exterior)) return false;
  for (const h of holes) if (pointInRing(pt, h)) return false;
  return true;
}

// ── Коллизии (вид сверху; координаты в одном кадре — [lng,lat] или [east,north]) ──

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function onSeg(a: Pt, b: Pt, p: Pt): boolean {
  return (
    Math.min(a[0], b[0]) - 1e-12 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-12 &&
    Math.min(a[1], b[1]) - 1e-12 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-12
  );
}
/** Пересекаются ли отрезки p1p2 и p3p4 (включая касание). */
export function segIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = orient(p3, p4, p1), d2 = orient(p3, p4, p2), d3 = orient(p1, p2, p3), d4 = orient(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSeg(p3, p4, p1)) return true;
  if (d2 === 0 && onSeg(p3, p4, p2)) return true;
  if (d3 === 0 && onSeg(p1, p2, p3)) return true;
  if (d4 === 0 && onSeg(p1, p2, p4)) return true;
  return false;
}
/** Пересекаются ли контуры (любое ребро a с любым ребром b). */
export function ringsCross(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segIntersect(a1, a2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}
/** Пересекаются ли наборы полигонов (ребро×ребро ИЛИ один внутри другого). */
export function polysIntersect(A: PolyWithHoles[], B: PolyWithHoles[]): boolean {
  for (const a of A)
    for (const b of B) {
      if (ringsCross(a.exterior, b.exterior)) return true;
      if (b.exterior.length && pointInPolygon(b.exterior[0], a.exterior, a.holes)) return true;
      if (a.exterior.length && pointInPolygon(a.exterior[0], b.exterior, b.holes)) return true;
    }
  return false;
}
/** Пересекаются ли две РАЗОМКНУТЫЕ ломаные (без замыкающего ребра). */
export function polylinesIntersect(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i + 1 < a.length; i++)
    for (let j = 0; j + 1 < b.length; j++) if (segIntersect(a[i], a[i + 1], b[j], b[j + 1])) return true;
  return false;
}
/** Касается ли ломаная line любого полигона A (ребро пересекает контур ИЛИ точка внутри). */
export function lineHitsPolys(line: Pt[], A: PolyWithHoles[]): boolean {
  for (const a of A) {
    for (let i = 0; i + 1 < line.length; i++) {
      const l1 = line[i], l2 = line[i + 1];
      for (let j = 0; j < a.exterior.length; j++) {
        if (segIntersect(l1, l2, a.exterior[j], a.exterior[(j + 1) % a.exterior.length])) return true;
      }
    }
    for (const v of line) if (pointInPolygon(v, a.exterior, a.holes)) return true;
  }
  return false;
}
/** Выпуклая оболочка (Andrew monotone chain) — контур для точечных облаков. */
export function convexHull(pts: Pt[]): Pt[] {
  const ps = pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).slice().sort((u, v) => u[0] - v[0] || u[1] - v[1]);
  if (ps.length < 3) return ps;
  const cr = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of ps) { while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper: Pt[] = [];
  for (let i = ps.length - 1; i >= 0; i--) { const p = ps[i]; while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}
/**
 * Точный контур нижнего среза ОБЛАКА точек (FBX без индексов) — alpha-shape на
 * регулярной сетке. В отличие от convexHull сохраняет вогнутости, дворы, Г-образные
 * планы и разрывы (несколько корпусов → несколько колец):
 *   1) точки → занятые ячейки сетки (адаптивный размер);
 *   2) морфологическое закрытие (дилатация+эрозия) — шов стен с редкими точками;
 *   3) заливка внутренних пустот (flood-fill извне) — комнаты не считаем дворами;
 *   4) граничные рёбра «занято|свободно» → сшивка в замкнутые кольца → упрощение.
 */
export function concaveFootprint(pointsRaw: Pt[]): Pt[][] {
  const pts = pointsRaw.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 8) { const h = convexHull(pts); return h.length >= 3 ? [h] : []; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const w = Math.max(maxX - minX, 1e-6), hgt = Math.max(maxY - minY, 1e-6);
  const span = Math.max(w, hgt);
  // размер ячейки по плотности точек, но в разумных пределах относительно габарита.
  const cell = Math.min(span / 12, Math.max(span / 150, 1.8 * Math.sqrt((w * hgt) / pts.length)));
  const GW = Math.ceil(w / cell) + 2, GH = Math.ceil(hgt / cell) + 2; // +рамка пустых ячеек
  const k = (cx: number, cy: number) => cy * GW + cx;
  const occ = new Set<number>();
  for (const [x, y] of pts) {
    const cx = Math.min(GW - 1, Math.max(0, Math.floor((x - minX) / cell) + 1));
    const cy = Math.min(GH - 1, Math.max(0, Math.floor((y - minY) / cell) + 1));
    occ.add(k(cx, cy));
  }
  const inG = (cx: number, cy: number) => cx >= 0 && cx < GW && cy >= 0 && cy < GH;
  // закрытие: дилатация (8-связность) → эрозия — заклеивает 1-клеточные разрывы.
  const dil = new Set<number>(occ);
  for (const c of occ) { const cx = c % GW, cy = (c - cx) / GW;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (inG(cx + dx, cy + dy)) dil.add(k(cx + dx, cy + dy)); }
  const closed = new Set<number>();
  for (const c of dil) { const cx = c % GW, cy = (c - cx) / GW; let all = true;
    for (let dx = -1; dx <= 1 && all; dx++) for (let dy = -1; dy <= 1; dy++) if (!inG(cx + dx, cy + dy) || !dil.has(k(cx + dx, cy + dy))) { all = false; break; }
    if (all) closed.add(c); }
  const solid0 = closed.size >= occ.size * 0.4 ? closed : occ; // эрозия не должна «съесть» тонкую полосу
  // заливка внутренних пустот: пустые ячейки, НЕ достижимые с рамки, — внутри здания.
  const outside = new Set<number>();
  const stack: number[] = [];
  const pushEmpty = (cx: number, cy: number) => { if (!inG(cx, cy)) return; const c = k(cx, cy); if (solid0.has(c) || outside.has(c)) return; outside.add(c); stack.push(c); };
  for (let cx = 0; cx < GW; cx++) { pushEmpty(cx, 0); pushEmpty(cx, GH - 1); }
  for (let cy = 0; cy < GH; cy++) { pushEmpty(0, cy); pushEmpty(GW - 1, cy); }
  while (stack.length) { const c = stack.pop()!; const cx = c % GW, cy = (c - cx) / GW; pushEmpty(cx + 1, cy); pushEmpty(cx - 1, cy); pushEmpty(cx, cy + 1); pushEmpty(cx, cy - 1); }
  const solid = new Set<number>();
  for (let cy = 0; cy < GH; cy++) for (let cx = 0; cx < GW; cx++) { const c = k(cx, cy); if (solid0.has(c) || !outside.has(c)) solid.add(c); }
  // граничные рёбра (занято|свободно) → отрезки по углам сетки.
  const occAt = (cx: number, cy: number) => inG(cx, cy) && solid.has(k(cx, cy));
  const corner = (gx: number, gy: number): Pt => [minX + (gx - 1) * cell, minY + (gy - 1) * cell];
  const segs: [Pt, Pt][] = [];
  for (let cy = 0; cy < GH; cy++) for (let cx = 0; cx < GW; cx++) {
    if (!solid.has(k(cx, cy))) continue;
    if (!occAt(cx - 1, cy)) segs.push([corner(cx, cy), corner(cx, cy + 1)]);
    if (!occAt(cx + 1, cy)) segs.push([corner(cx + 1, cy), corner(cx + 1, cy + 1)]);
    if (!occAt(cx, cy - 1)) segs.push([corner(cx, cy), corner(cx + 1, cy)]);
    if (!occAt(cx, cy + 1)) segs.push([corner(cx, cy + 1), corner(cx + 1, cy + 1)]);
  }
  const rings = stitchGridEdges(segs).map(simplifyRing).filter((r) => r.length >= 3);
  if (rings.length === 0) { const h = convexHull(pts); return h.length >= 3 ? [h] : []; }
  return rings;
}

/** Сшивает единичные рёбра сетки в замкнутые кольца (по совпадающим узлам). */
function stitchGridEdges(segs: [Pt, Pt][]): Pt[][] {
  const key = (p: Pt) => `${Math.round(p[0] * 1000)}_${Math.round(p[1] * 1000)}`;
  const ek = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const pos = new Map<string, Pt>();
  const adj = new Map<string, string[]>();
  for (const [a, b] of segs) {
    const ka = key(a), kb = key(b);
    if (ka === kb) continue;
    pos.set(ka, a); pos.set(kb, b);
    (adj.get(ka) ?? adj.set(ka, []).get(ka)!).push(kb);
    (adj.get(kb) ?? adj.set(kb, []).get(kb)!).push(ka);
  }
  const used = new Set<string>();
  const rings: Pt[][] = [];
  for (const startK of pos.keys()) {
    for (const firstNb of adj.get(startK) || []) {
      if (used.has(ek(startK, firstNb))) continue;
      const ring: Pt[] = [pos.get(startK)!];
      used.add(ek(startK, firstNb));
      let prev = startK, cur = firstNb, guard = 0;
      while (cur !== startK && guard++ < pos.size * 4 + 8) {
        ring.push(pos.get(cur)!);
        const nbs = adj.get(cur) || [];
        let nxt = nbs.find((c) => c !== prev && !used.has(ek(cur, c)));
        if (nxt == null) nxt = nbs.find((c) => !used.has(ek(cur, c)));
        if (nxt == null) break;
        used.add(ek(cur, nxt)); prev = cur; cur = nxt;
      }
      if (cur === startK && ring.length >= 3) rings.push(ring);
    }
  }
  return rings;
}

/** Убирает коллинеарные точки кольца (стягивает прямые «лесенки» сетки). */
function simplifyRing(ring: Pt[]): Pt[] {
  const n = ring.length;
  if (n < 4) return ring;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
    if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 1e-7) out.push(b);
  }
  return out.length >= 3 ? out : ring;
}

/** bbox набора колец [minX,minY,maxX,maxY]. */
export function bboxOf(rings: Pt[][]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const p of r) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; }
  return [x0, y0, x1, y1];
}
export function bboxOverlap(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/**
 * Прогон GIS-01.
 * @param parcelPolys полигоны ЗУ в [east,north] (МСК-77) с дырками; могут быть из
 *   нескольких источников (ГПЗУ + DWG, несколько участков). Точка «в ЗУ» = внутри
 *   внешнего контура ХОТЯ БЫ ОДНОГО полигона И не в его дырке. Для центроида/смещения
 *   берётся участок макс. площади.
 * @param toMskCal перевод горизонтальных координат среза FBX в МСК-77 [east,north] с калибровкой.
 * @param contourRingsModel точный контур основания в осях модели (hA,hB): для меша —
 *   сшитые кольца среза, для облака — вогнутая оболочка (concaveFootprint). Если задан,
 *   вердикт по основанию считается ПО КОНТУРУ (а не по облаку точек среза).
 */
export function runGis01(
  geom: FbxGeom,
  parcelPolys: PolyWithHoles[],
  toMskCal: (p: Pt) => Pt,
  contourRingsModel: Pt[][] = [],
): Gis01Result {
  const polys = parcelPolys.filter((p) => p.exterior.length >= 3);
  const parcel =
    polys.slice().sort((a, b) => ringArea(b.exterior) - ringArea(a.exterior))[0] ?? { exterior: [], holes: [] };
  const parcelEN = parcel.exterior;
  const insideAny = (en: Pt): boolean => polys.some((pl) => pointInPolygon(en, pl.exterior, pl.holes));
  const base = geom.min[geom.vAxis];
  const top = geom.max[geom.vAxis];
  const levels: Gis01Level[] = [];
  for (let h = base + 0.01; h <= top + 1e-6; h += STEP) {
    const raw = slicePts(geom, h);
    if (raw.length === 0) continue;
    const insideEN: Pt[] = [];
    const outsideEN: Pt[] = [];
    for (const p of raw) {
      const en = toMskCal(p);
      if (insideAny(en)) insideEN.push(en);
      else outsideEN.push(en);
    }
    levels.push({
      hRel: Math.round((h - base) * 100) / 100,
      total: raw.length,
      outside: outsideEN.length,
      insideEN,
      outsideEN,
    });
  }

  const baseLevel = levels[0] ?? null;
  const exitLevel = levels.find((l) => l.outside > 0) ?? null;
  const topRel = Math.round((top - base) * 100) / 100;

  // Центроиды и попадания (для детекта «объект целиком вне ЗУ»).
  let sx = 0, sy = 0, k = 0, totalInside = 0;
  for (const l of levels) {
    totalInside += l.insideEN.length;
    for (const p of [...l.insideEN, ...l.outsideEN]) { sx += p[0]; sy += p[1]; k++; }
  }
  const buildingCentroidEN: Pt | null = k > 0 ? [sx / k, sy / k] : null;
  const parcelC = centroidOf(parcelEN);
  const offsetM =
    buildingCentroidEN && parcelC
      ? Math.round(Math.hypot(buildingCentroidEN[0] - parcelC[0], buildingCentroidEN[1] - parcelC[1]))
      : 0;
  const dist = offsetM >= 1000 ? `${(offsetM / 1000).toFixed(1)} км` : `${offsetM} м`;

  // Точный контур основания в МСК-77 (меш — сшитые кольца, облако — вогнутая оболочка).
  const contourEN: Pt[][] = contourRingsModel.filter((r) => r.length >= 3).map((r) => r.map(toMskCal));
  const contourOutsideEN: Pt[] = [];
  let contourCrosses = false;
  for (const ring of contourEN) {
    for (const v of ring) if (!insideAny(v)) contourOutsideEN.push(v);
    for (const pl of polys) {
      if (ringsCross(ring, pl.exterior) || pl.holes.some((h) => ringsCross(ring, h))) { contourCrosses = true; break; }
    }
  }
  const hasContour = contourEN.length > 0;
  const baseOutByContour = hasContour && (contourOutsideEN.length > 0 || contourCrosses);
  // Свес выше основания — первый уровень ВЫШЕ базового с точками вне ЗУ.
  const upperExit = levels.find((l) => baseLevel != null && l.hRel > baseLevel.hRel && l.outside > 0) ?? null;

  let status: Gis01Result["status"];
  let summary: string;
  let noOverlap = false;
  if (k > 0 && totalInside === 0) {
    // Ни одна точка ни на одной высоте не попала в ЗУ — проблема координат/привязки.
    status = "fail";
    noOverlap = true;
    summary = `Объект ПОЛНОСТЬЮ вне границ ЗУ — нет ни одной точки внутри (центр объекта ~${dist} от центра участка). Вероятна проблема геопривязки/координат.`;
  } else if (hasContour) {
    // Вердикт основания — по точному контуру (сохраняет вогнутости/дворы).
    if (baseOutByContour) {
      status = "fail";
      const cross = contourCrosses ? "контур пересекает границу ЗУ" : "";
      const out = contourOutsideEN.length ? `${contourOutsideEN.length} верш. контура вне ЗУ` : "";
      summary = `Контур основания выходит за границы ЗУ (${[out, cross].filter(Boolean).join("; ")}).`;
    } else if (upperExit) {
      status = "warn";
      summary = `Основание в границах ЗУ (по точному контуру); с высоты ${upperExit.hRel} м часть выступает за границы (${upperExit.outside} точек).`;
    } else {
      status = "pass";
      summary = `Здание полностью в границах ЗУ — точный контур основания внутри ЗУ (проверено ${levels.length} ур. до ${topRel} м).`;
    }
  } else if (!exitLevel) {
    status = "pass";
    summary = `Здание полностью в границах ЗУ (проверено ${levels.length} ур. до ${topRel} м).`;
  } else if (baseLevel && baseLevel.outside > 0) {
    status = "fail";
    summary = `Основание здания выходит за границы ЗУ (${baseLevel.outside} точек уже на 0 м).`;
  } else {
    status = "warn";
    summary = `Нижняя часть в пределах ЗУ; с высоты ${exitLevel.hRel} м часть выступает за границы ЗУ (${exitLevel.outside} точек).`;
  }
  return { status, summary, topRel, levels, baseLevel, exitLevel, parcelEN, parcelHoles: parcel.holes, parcelPolys: polys, noOverlap, offsetM, buildingCentroidEN, contourEN, contourOutsideEN };
}

function centroidOf(ring: Pt[]): Pt | null {
  if (ring.length === 0) return null;
  let sx = 0, sy = 0;
  for (const p of ring) { sx += p[0]; sy += p[1]; }
  return [sx / ring.length, sy / ring.length];
}

function wrapText(s: string, n: number): string[] {
  if (!s) return [];
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > n) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Эскиз (вид сверху) ───────────────────────────────────────────────────────

/** SVG-эскиз вид сверху: ЗУ + срез основания + срез на высоте выхода (выступающие — красным). */
export function sketchSvg(res: Gis01Result, opts?: { cad?: string; file?: string; diagnostic?: string }): string {
  const W = 760, H = 620, pad = 36;
  const polys = res.parcelPolys?.length ? res.parcelPolys : [{ exterior: res.parcelEN, holes: res.parcelHoles || [] }];
  const all: Pt[] = [];
  for (const pl of polys) { all.push(...pl.exterior); for (const h of pl.holes) all.push(...h); }
  for (const r of res.contourEN || []) all.push(...r);
  if (res.baseLevel) all.push(...res.baseLevel.insideEN, ...res.baseLevel.outsideEN);
  if (res.exitLevel) all.push(...res.exitLevel.insideEN, ...res.exitLevel.outsideEN);
  if (res.buildingCentroidEN) all.push(res.buildingCentroidEN);
  if (all.length === 0) return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"></svg>`;

  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (const [e, n] of all) {
    if (e < minE) minE = e; if (e > maxE) maxE = e;
    if (n < minN) minN = n; if (n > maxN) maxN = n;
  }
  const spanE = Math.max(maxE - minE, 1), spanN = Math.max(maxN - minN, 1);
  const s = Math.min((W - 2 * pad) / spanE, (H - 2 * pad - 40) / spanN);
  const ox = (W - spanE * s) / 2, oy = (H - 40 - spanN * s) / 2 + 40;
  // east→x, north→y (север вверх → инверсия y)
  const X = (e: number) => ox + (e - minE) * s;
  const Y = (n: number) => oy + (maxN - n) * s;

  const ringToPath = (ring: Pt[]) =>
    ring.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ") + " Z";
  // Каждый участок (внешний контур + его дырки) — отдельным path с fill-rule=evenodd
  // (дырки вырезаются), поддерживает несколько участков из разных источников.
  const parcelPaths = polys
    .map((pl) => [pl.exterior, ...pl.holes].map(ringToPath).join(" "))
    .map((d) => `<path d="${d}" fill="#16a34a" fill-opacity="0.08" fill-rule="evenodd" stroke="#16a34a" stroke-width="2"/>`)
    .join("");
  const dots = (pts: Pt[], color: string, r: number) =>
    pts.map((p) => `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="${r}" fill="${color}"/>`).join("");

  // Точный контур основания (синим): меш — сшитые кольца, облако — вогнутая оболочка.
  const hasContour = (res.contourEN?.length ?? 0) > 0;
  const contourFill = res.status === "fail" ? "#2563eb" : "#1d4ed8";
  const contourPaths = hasContour
    ? res.contourEN.map((r) => `<path d="${ringToPath(r)}" fill="${contourFill}" fill-opacity="0.14" stroke="${contourFill}" stroke-width="1.8" stroke-linejoin="round"/>`).join("")
    : "";

  const statusColor = res.status === "pass" ? "#2e7d4f" : res.status === "warn" ? "#b9770e" : "#c0392b";
  const statusText = res.status === "pass" ? "СООТВЕТСТВИЕ" : res.status === "warn" ? "ЧАСТИЧНО (Warning)" : "НЕ СООТВЕТСТВИЕ";

  // масштабная линейка (10 м)
  const barLen = 10 * s;
  const bx = pad, by = H - 16;

  // Для «объект вне ЗУ» — пунктир от центра участка к центру объекта + расстояние.
  const parcelC = centroidOf(res.parcelEN);
  const bC = res.buildingCentroidEN;
  const connector =
    res.noOverlap && parcelC && bC
      ? `<line x1="${X(parcelC[0]).toFixed(1)}" y1="${Y(parcelC[1]).toFixed(1)}" x2="${X(bC[0]).toFixed(1)}" y2="${Y(bC[1]).toFixed(1)}" stroke="#c0392b" stroke-width="1.3" stroke-dasharray="6 4"/>` +
        `<circle cx="${X(bC[0]).toFixed(1)}" cy="${Y(bC[1]).toFixed(1)}" r="4" fill="#c0392b"/>` +
        `<text x="${((X(parcelC[0]) + X(bC[0])) / 2).toFixed(1)}" y="${((Y(parcelC[1]) + Y(bC[1])) / 2 - 5).toFixed(1)}" font-size="11" fill="#c0392b" text-anchor="middle">~${res.offsetM >= 1000 ? (res.offsetM / 1000).toFixed(1) + " км" : res.offsetM + " м"} (объект вне ЗУ)</text>`
      : "";
  // Диагностика геопривязки (перенос строк, белая подложка для читаемости).
  const diagLines = wrapText(opts?.diagnostic || "", 95).slice(0, 4);
  const diagSvg = diagLines.length
    ? `<rect x="${pad - 4}" y="46" width="${W - 2 * pad + 8}" height="${diagLines.length * 15 + 8}" fill="#ffffff" fill-opacity="0.85"/>` +
      diagLines.map((ln, i) => `<text x="${pad}" y="${60 + i * 15}" font-size="11" fill="#7a2018">${escXml(ln)}</text>`).join("")
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="${pad}" y="22" font-size="15" font-weight="bold" fill="#222">GIS-01 · Здание в границах ЗУ — вид сверху</text>
  <text x="${pad}" y="38" font-size="11" fill="${statusColor}" font-weight="bold">${statusText}</text>
  ${opts?.file ? `<text x="${W - pad}" y="22" font-size="11" fill="#555" text-anchor="end">${escXml(opts.file)}</text>` : ""}
  ${opts?.cad ? `<text x="${W - pad}" y="36" font-size="11" fill="#555" text-anchor="end">ЗУ ${escXml(opts.cad)}</text>` : ""}
  ${parcelPaths}
  ${contourPaths}
  ${hasContour ? "" : res.baseLevel ? dots(res.baseLevel.insideEN, "#1f9d55", 1.7) : ""}
  ${res.exitLevel ? dots(res.exitLevel.insideEN, "#9aa0a6", 1.4) : ""}
  ${res.exitLevel ? dots(res.exitLevel.outsideEN, "#e2241a", 2.4) : ""}
  ${hasContour ? dots(res.contourOutsideEN || [], "#e2241a", 2.6) : ""}
  ${connector}
  ${diagSvg}
  <g font-size="11" fill="#333">
    <rect x="${pad}" y="${H - 92}" width="14" height="10" fill="#16a34a" fill-opacity="0.25" stroke="#16a34a"/>
    <text x="${pad + 20}" y="${H - 83}">граница ЗУ (ГПЗУ, МСК-77)</text>
    <rect x="${pad}" y="${H - 70}" width="14" height="10" fill="${contourFill}" fill-opacity="0.2" stroke="${contourFill}"/>
    <text x="${pad + 20}" y="${H - 62}">${hasContour ? "точный контур основания (0 м)" : "срез основания (0 м) — в границах"}</text>
    <circle cx="${pad + 7}" cy="${H - 48}" r="3" fill="#e2241a"/>
    <text x="${pad + 20}" y="${H - 44}">${hasContour ? (res.contourOutsideEN?.length ? "вершины контура вне ЗУ" : (res.exitLevel ? `свес с ${res.exitLevel.hRel} м` : "выступов нет")) : res.exitLevel ? `срез ${res.exitLevel.hRel} м — выступает за границы` : "выступов нет"}</text>
  </g>
  <line x1="${bx}" y1="${by}" x2="${bx + barLen}" y2="${by}" stroke="#222" stroke-width="2"/>
  <text x="${bx + barLen + 6}" y="${by + 4}" font-size="11" fill="#222">10 м · север ↑</text>
</svg>`;
}
