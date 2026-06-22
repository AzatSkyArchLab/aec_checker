import { LibreDwg, Dwg_File_Type } from "@mlightcad/libredwg-web";

/**
 * Парсер DWG (нативно, через WASM-порт libredwg). Извлекает кривые по слоям,
 * находит слой(и) с границей земельного участка и собирает замкнутые контуры
 * в координатах модели DWG (предполагается привязка к МСК-77). Ось/проекцию
 * добивает вызывающий (gis.ts): пробует обе оси и берёт ту, что в Москве.
 */
export interface DwgRing {
  pts: { x: number; y: number }[]; // координаты модели DWG (как есть)
  layer: string;
  closed: boolean;
}
export interface DwgCandidate {
  layer: string;
  score: number; // 0..5 — уверенность, что это граница ЗУ
  n: number; // число замкнутых контуров на слое
}
export interface DwgParseResult {
  rings: DwgRing[]; // контуры-кандидаты (с выбранного слоя ЗУ либо крупнейший)
  chosenLayer: string; // имя выбранного слоя (или "")
  candidates: DwgCandidate[]; // все слои с контурами + их «ЗУ-оценка» (для проверки/выбора)
  allLayers: string[]; // все слои с кривыми
  matchedByLayer: boolean; // контур взят с распознанного слоя ЗУ (а не fallback)
}

/**
 * Оценка слоя как границы ЗУ (имена в реальных DWG не унифицированы —
 * «1границы зу из ппт», «1границапоГПЗУ», «Граница ЗУ», «межевание» и т.п.).
 * 5 — ГПЗУ (самый точный), ниже — межевание/кадастр, ЗУ/участок, ППТ, любая граница.
 * Кириллица: НЕ используем \b (в JS он только ASCII) — границы слова через [^а-я].
 */
function zuScore(layer: string): number {
  const s = (layer || "").toLowerCase().replace(/ё/g, "е");
  if (/гпзу/.test(s)) return 5;
  if (/межев|кадастр|надел|сервитут/.test(s)) return 4;
  if (/(^|[^а-я])зу([^а-я]|$)|зем[._ \-]*уч|участок|участк|\bучаст/.test(s)) return 3;
  if (/границ.*(зу|ппт|участ|межев|надел)|(зу|ппт|участ|межев|надел).*границ/.test(s)) return 3;
  if (/ппт/.test(s)) return 2;
  if (/границ|контур|обрез|отвод/.test(s)) return 1;
  return 0;
}

const CURVE_TYPES = new Set(["LWPOLYLINE", "POLYLINE", "LINE"]);

// Единый инстанс libredwg (WASM 6.3 МБ): создаём один раз — повторный create()
// порождает второй emscripten-модуль и подвешивает парсинг.
let libPromise: Promise<Awaited<ReturnType<typeof LibreDwg.create>>> | null = null;
function getLib() {
  if (!libPromise) libPromise = LibreDwg.create();
  return libPromise;
}

export async function parseDwg(file: File): Promise<DwgParseResult> {
  const buf = await file.arrayBuffer();
  const lib = await getLib();
  const ptr = lib.dwg_read_data(buf, Dwg_File_Type.DWG);
  if (ptr == null) throw new Error("libredwg: не удалось прочитать DWG");
  const db = lib.convert(ptr as number);
  try {
    lib.dwg_free(ptr as number);
  } catch {
    /* free best-effort */
  }

  const entities: any[] = (db && (db.entities as any[])) || [];
  const layersWithCurves = new Set<string>();
  // Группируем замкнутые контуры и сегменты (LINE) по слоям.
  const closedRings: DwgRing[] = [];
  const segsByLayer = new Map<string, [P, P][]>();

  for (const e of entities) {
    const type = String(e.type || "");
    if (!CURVE_TYPES.has(type)) continue;
    const layer = String(e.layer || "0");
    layersWithCurves.add(layer);

    if (type === "LWPOLYLINE" || type === "POLYLINE") {
      const verts = (e.vertices || []) as any[];
      const pts = verts
        .map((v) => ({ x: num(v.x), y: num(v.y) }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (pts.length >= 3) {
        const closed = (e.flag & 1) === 1 || (e.closed === true);
        closedRings.push({ pts, layer, closed });
      }
    } else if (type === "LINE") {
      const a: P = [num(e.startPoint?.x), num(e.startPoint?.y)];
      const b: P = [num(e.endPoint?.x), num(e.endPoint?.y)];
      if (a.every(Number.isFinite) && b.every(Number.isFinite)) {
        (segsByLayer.get(layer) ?? segsByLayer.set(layer, []).get(layer)!).push([a, b]);
      }
    }
  }

  // Сегменты LINE → замкнутые кольца (по слою).
  for (const [layer, segs] of segsByLayer) {
    for (const loop of stitch(segs)) {
      if (loop.length >= 3) closedRings.push({ pts: loop.map(([x, y]) => ({ x, y })), layer, closed: true });
    }
  }

  const allLayers = [...layersWithCurves].sort();

  // Оцениваем каждый слой, где есть контуры, и берём контуры с слоя(ёв) с макс. ЗУ-оценкой.
  const byLayer = new Map<string, DwgRing[]>();
  for (const r of closedRings) (byLayer.get(r.layer) ?? byLayer.set(r.layer, []).get(r.layer)!).push(r);
  const candidates: DwgCandidate[] = [...byLayer.entries()]
    .map(([layer, rs]) => ({ layer, score: zuScore(layer), n: rs.length }))
    .sort((a, b) => b.score - a.score || b.n - a.n);

  const bestScore = candidates.length ? candidates[0].score : 0;
  let rings: DwgRing[];
  let matchedByLayer = false;
  let chosenLayer = "";
  if (bestScore > 0) {
    const bestLayers = candidates.filter((c) => c.score === bestScore).map((c) => c.layer);
    rings = closedRings.filter((r) => bestLayers.includes(r.layer)).sort((a, b) => ringArea(b.pts) - ringArea(a.pts));
    matchedByLayer = true;
    chosenLayer = bestLayers.join(", ");
  } else {
    // ни один слой не похож на ЗУ — крупнейший замкнутый контур всего чертежа.
    const pool = (closedRings.filter((r) => r.closed).length ? closedRings.filter((r) => r.closed) : closedRings)
      .slice()
      .sort((a, b) => ringArea(b.pts) - ringArea(a.pts));
    rings = pool.length ? [pool[0]] : [];
    chosenLayer = pool.length ? pool[0].layer : "";
  }

  return { rings, chosenLayer, candidates, allLayers, matchedByLayer };
}

// ── утилиты ──────────────────────────────────────────────────────────────────
type P = [number, number];

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function ringArea(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}

/** Сшивка отрезков в замкнутые кольца (порог 1 мм). */
function stitch(segs: [P, P][]): P[][] {
  const key = (p: P) => `${Math.round(p[0] * 1000)}_${Math.round(p[1] * 1000)}`;
  const ek = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const pos = new Map<string, P>();
  const adj = new Map<string, Set<string>>();
  const edges = new Set<string>();
  for (const [a, b] of segs) {
    const ka = key(a), kb = key(b);
    if (ka === kb) continue;
    pos.set(ka, a);
    pos.set(kb, b);
    (adj.get(ka) ?? adj.set(ka, new Set()).get(ka)!).add(kb);
    (adj.get(kb) ?? adj.set(kb, new Set()).get(kb)!).add(ka);
    edges.add(ek(ka, kb));
  }
  const loops: P[][] = [];
  const used = new Set<string>();
  for (const start of edges) {
    if (used.has(start)) continue;
    const first = start.split("|")[0];
    const path = [first];
    let cur = first;
    for (let g = 0; g < edges.size + 1; g++) {
      const next = [...(adj.get(cur) ?? [])].find((n) => !used.has(ek(cur, n)));
      if (next == null) break;
      used.add(ek(cur, next));
      path.push(next);
      cur = next;
      if (cur === first) break;
    }
    if (cur === first && path.length >= 4) loops.push(path.map((k) => pos.get(k)!));
  }
  return loops;
}
