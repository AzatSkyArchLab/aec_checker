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
  meshes: { world: Float32Array; index: ArrayLike<number> | null }[];
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
  parcelEN: Pt[]; // кольцо ЗУ [east, north]
}

const STEP = 1.5; // шаг срезов, м
const CLOUD_BAND = 0.75; // полуширина полосы для облака точек, м

/** Горизонтальные координаты точек среза здания на высоте h (в осях hA/hB FBX). */
function slicePts(geom: FbxGeom, h: number): Pt[] {
  const { meshes, vAxis, hA, hB, isCloud } = geom;
  const out: Pt[] = [];
  if (!isCloud) {
    for (const m of meshes) {
      const p = m.world;
      const idx = m.index;
      if (!idx || idx.length < 3) continue;
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        crossEdge(p, a, b, vAxis, hA, hB, h, out);
        crossEdge(p, b, c, vAxis, hA, hB, h, out);
        crossEdge(p, c, a, vAxis, hA, hB, h, out);
      }
    }
  } else {
    for (const m of meshes) {
      const p = m.world;
      for (let i = 0; i < p.length; i += 3) {
        if (Math.abs(p[i + vAxis] - h) <= CLOUD_BAND) out.push([p[i + hA], p[i + hB]]);
      }
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

/**
 * Прогон GIS-01.
 * @param ringsEN кольца ГПЗУ в [east, north] (МСК-77); ЗУ = кольцо макс. площади.
 * @param toMskCal перевод горизонтальных координат среза FBX в МСК-77 [east,north] с калибровкой.
 */
export function runGis01(geom: FbxGeom, ringsEN: Pt[][], toMskCal: (p: Pt) => Pt): Gis01Result {
  const parcelEN = ringsEN.slice().sort((a, b) => ringArea(b) - ringArea(a))[0] ?? [];
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
      if (pointInRing(en, parcelEN)) insideEN.push(en);
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

  let status: Gis01Result["status"];
  let summary: string;
  if (!exitLevel) {
    status = "pass";
    summary = `Здание полностью в границах ЗУ (проверено ${levels.length} ур. до ${topRel} м).`;
  } else if (baseLevel && baseLevel.outside > 0) {
    status = "fail";
    summary = `Основание здания выходит за границы ЗУ (${baseLevel.outside} точек уже на 0 м).`;
  } else {
    status = "warn";
    summary = `Нижняя часть в пределах ЗУ; с высоты ${exitLevel.hRel} м часть выступает за границы ЗУ (${exitLevel.outside} точек).`;
  }
  return { status, summary, topRel, levels, baseLevel, exitLevel, parcelEN };
}

// ── Эскиз (вид сверху) ───────────────────────────────────────────────────────

/** SVG-эскиз вид сверху: ЗУ + срез основания + срез на высоте выхода (выступающие — красным). */
export function sketchSvg(res: Gis01Result, opts?: { cad?: string; file?: string }): string {
  const W = 760, H = 620, pad = 36;
  const all: Pt[] = [...res.parcelEN];
  if (res.baseLevel) all.push(...res.baseLevel.insideEN, ...res.baseLevel.outsideEN);
  if (res.exitLevel) all.push(...res.exitLevel.insideEN, ...res.exitLevel.outsideEN);
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

  const ringPath = res.parcelEN.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ") + " Z";
  const dots = (pts: Pt[], color: string, r: number) =>
    pts.map((p) => `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="${r}" fill="${color}"/>`).join("");

  const statusColor = res.status === "pass" ? "#2e7d4f" : res.status === "warn" ? "#b9770e" : "#c0392b";
  const statusText = res.status === "pass" ? "СООТВЕТСТВИЕ" : res.status === "warn" ? "ЧАСТИЧНО (Warning)" : "НЕ СООТВЕТСТВИЕ";

  // масштабная линейка (10 м)
  const barLen = 10 * s;
  const bx = pad, by = H - 16;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="${pad}" y="22" font-size="15" font-weight="bold" fill="#222">GIS-01 · Здание в границах ЗУ — вид сверху</text>
  <text x="${pad}" y="38" font-size="11" fill="${statusColor}" font-weight="bold">${statusText}</text>
  ${opts?.cad ? `<text x="${W - pad}" y="22" font-size="11" fill="#555" text-anchor="end">ЗУ ${opts.cad}</text>` : ""}
  <path d="${ringPath}" fill="#16a34a" fill-opacity="0.08" stroke="#16a34a" stroke-width="2"/>
  ${res.baseLevel ? dots(res.baseLevel.insideEN, "#1f9d55", 1.7) : ""}
  ${res.exitLevel ? dots(res.exitLevel.insideEN, "#9aa0a6", 1.4) : ""}
  ${res.exitLevel ? dots(res.exitLevel.outsideEN, "#e2241a", 2.4) : ""}
  <g font-size="11" fill="#333">
    <rect x="${pad}" y="${H - 92}" width="14" height="10" fill="#16a34a" fill-opacity="0.25" stroke="#16a34a"/>
    <text x="${pad + 20}" y="${H - 83}">граница ЗУ (ГПЗУ, МСК-77)</text>
    <circle cx="${pad + 7}" cy="${H - 66}" r="3" fill="#1f9d55"/>
    <text x="${pad + 20}" y="${H - 62}">срез основания (0 м) — в границах</text>
    <circle cx="${pad + 7}" cy="${H - 48}" r="3" fill="#e2241a"/>
    <text x="${pad + 20}" y="${H - 44}">${res.exitLevel ? `срез ${res.exitLevel.hRel} м — выступает за границы` : "выступов нет"}</text>
  </g>
  <line x1="${bx}" y1="${by}" x2="${bx + barLen}" y2="${by}" stroke="#222" stroke-width="2"/>
  <text x="${bx + barLen + 6}" y="${by + 4}" font-size="11" fill="#222">10 м · север ↑</text>
</svg>`;
}
