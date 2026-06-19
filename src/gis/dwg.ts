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
export interface DwgParseResult {
  rings: DwgRing[]; // контуры-кандидаты (замкнутые / из сегментов)
  zuLayers: string[]; // слои, похожие на ЗУ
  allLayers: string[]; // все слои с кривыми
  matchedByLayer: boolean; // контур взят со слоя ЗУ (а не fallback)
}

// Слой ЗУ: «участок / граница / ЗУ / межевание / кадастр / надел / ГПЗУ / ПЗУ / отвод / красные линии».
const ZU_LAYER_RE =
  /участ|границ|\bз\.?у\.?\b|зем.?уч|меже|кадастр|надел|гпзу|\bпзу\b|отвод|red[\s_-]?line|красн/i;

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
  const zuLayers = allLayers.filter((l) => ZU_LAYER_RE.test(l));

  // Берём контуры со слоёв ЗУ; если таких слоёв нет — крупнейший замкнутый контур всего чертежа.
  let rings = closedRings.filter((r) => zuLayers.some((zl) => zl === r.layer));
  let matchedByLayer = rings.length > 0;
  if (rings.length === 0) {
    const closed = closedRings.filter((r) => r.closed);
    const pool = closed.length ? closed : closedRings;
    if (pool.length) {
      pool.sort((a, b) => ringArea(b.pts) - ringArea(a.pts));
      rings = [pool[0]]; // крупнейший контур как предполагаемая граница
    }
  } else {
    rings.sort((a, b) => ringArea(b.pts) - ringArea(a.pts));
  }

  return { rings, zuLayers, allLayers, matchedByLayer };
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
