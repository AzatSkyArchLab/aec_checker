import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { GpzuPoint } from "./gpzu.ts";
import { classifyRings, runGis01 as runGis01Calc, sketchSvg } from "./gis01.ts";
import type { FbxGeom } from "./gis01.ts";

/**
 * ГИС-режим: FBX в МСК-77 → нижний срез модели → точки на карте «как в FBX»,
 * совмещённые с кадастром Москвы (MVT-слой 101 metatiler, как в generative_concepts).
 *
 * МСК-77 (выверена, см. rosreestr.py): tmerc lat_0=55°40′, lon_0=37.5°, Красовский +
 * towgs84 Пулково-1942→WGS84. proj4 отдаёт [east, north].
 */
const MSK77 =
  "+proj=tmerc +lat_0=55.66666666666667 +lon_0=37.5 +k=1 +x_0=0 +y_0=0 +ellps=krass +towgs84=23.57,-140.95,-79.8,0,0.35,0.79,-0.22 +units=m +no_defs";

// Кадастр: MVT-сервер metatiler (Swagger /tiles/{layer}/{z}/{x}/{y}); 101 = кадастр Москвы.
const METATILER_BASE = "https://meta-tiler-stage.metapolis.su";
const CADASTRE_LAYER_ID = 101;
const CADASTRE_SRC_LAYER = "main"; // имя source-layer в MVT этого сервера
const REDLINES_LAYER_ID = 347001; // красные линии (импорт в metatiler)
const REDLINES_SRC_LAYER = "main";
const REDLINES_COLOR = "#dc2626";
const OSM_TILES = "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png";

const FOOTPRINT_COLOR = "#e8590c";
const CADASTRE_COLOR = "#1f77b4";
const TARGET_COLOR = "#ffd400";
const GPZU_COLOR = "#16a34a"; // зелёный — авторитетный участок из ГПЗУ (МСК-77)
// Палитра для нескольких моделей одновременно (цветокодировка контуров на карте).
const MODEL_PALETTE = ["#e8590c", "#7048e8", "#0ca678", "#e64980", "#1098ad", "#f08c00", "#4263eb", "#ae3ec9"];
type Pt = [number, number];

/** Геопривязка модели (для диагностики «объект вне ЗУ» в GIS-01). */
type ModelGeo =
  | { source: "fbx" }
  | { source: "ifc"; ok: boolean; lat?: number; lng?: number; method?: string; inMoscow?: boolean; reason?: string };

/** Размещённая на карте модель здания (FBX или IFC). Несколько сосуществуют. */
interface PlacedModel {
  id: string;
  name: string;
  kind: "fbx" | "ifc";
  geom: FbxGeom; // для многоуровневых срезов GIS-01
  geo: ModelGeo;
  footprint: Footprint; // нижний срез в координатах модели (hA,hB)
  center: Pt; // центр модели [hA,hB] (для маркера и оси доворота)
  color: string;
  info: string; // краткая строка для панели
}

/** Граница ЗУ (из ГПЗУ или DWG). Несколько сосуществуют; GIS-01 берёт объединение. */
interface Boundary {
  id: string;
  name: string;
  kind: "gpzu" | "dwg";
  rings: GpzuPoint[][]; // МСК-77, X=север Y=восток (один участок: внешний+дырки/мультиконтур)
  info: string; // краткая строка для панели
  ok: boolean; // распознано/геопривязка вменяемая
}

/** Набор красных линий из GeoJSON (WGS84), временно client-side. */
interface RedLineSet {
  id: string;
  name: string;
  n: number;
  features: unknown[];
}

/** Результат GIS-01 по одной модели — для модалки и панели. */
export interface ModelCheckResult {
  modelId: string;
  name: string;
  color: string;
  status: "pass" | "warn" | "fail";
  summary: string;
  diagnostic: string;
  svg: string;
}

export class GisView {
  private map: maplibregl.Map | null = null;
  private ready: Promise<void> | null = null;
  private proj4: any = null;
  private markers: maplibregl.Marker[] = [];
  /**
   * (горизонт. координаты среза) → (east, north) МСК-77. FBXLoader и web-ifc дают
   * Y-up: ось0=East, ось2=−North — единая конвенция для всех моделей (константа).
   */
  private toMsk = (a: number, b: number): Pt => [a, -b];
  /**
   * Ручная калибровка сдвига в МСК-77 (м): ΔВосток, ΔСевер. Кадастр (НСПД,
   * индикативный) и FBX (привязан к точной выписке) расходятся на десятки
   * метров — этот сдвиг дотягивает модели до кадастра. Применяется до proj4,
   * т.е. полностью в кадре МСК-77. Хранится в localStorage (один на все модели).
   */
  private calibE = 0;
  private calibN = 0;
  /** Доворот вокруг общего центра моделей (град) — убирает остаточный поворот. */
  private calibRot = 0;
  /** Общий центр всех моделей в МСК-77 (raw, до калибровки) — ось доворота. */
  private calibPivot: Pt | null = null;
  /** Центр целевого участка (кадастр/ГПЗУ) в МСК-77 (для «совместить центр»). */
  private targetMsk: Pt | null = null;
  /** Загруженные модели зданий (FBX/IFC) — все рисуются и проверяются одновременно. */
  private models: PlacedModel[] = [];
  /** Загруженные границы ЗУ (ГПЗУ/DWG) — объединение участвует в GIS-01. */
  private boundaries: Boundary[] = [];
  /** Загруженные наборы красных линий (GeoJSON, client-side). */
  private redlineSets: RedLineSet[] = [];
  private seq = 0;
  /** Последний прогон GIS-01 (для перерисовки панели). */
  private lastChecks: ModelCheckResult[] | null = null;
  /** Колбэк «показать отчёт проверок» (модалку открывает main.ts). */
  private onShowChecks: (() => void) | null = null;

  constructor(
    private mapEl: HTMLElement,
    private statusEl: HTMLElement,
    private infoEl: HTMLElement,
    private dropzone: HTMLElement,
    private cadastreToggle: HTMLInputElement,
    private redLinesToggle: HTMLInputElement,
  ) {
    this.cadastreToggle.addEventListener("change", () => {
      this.setCadastreVisible(this.cadastreToggle.checked);
    });
    this.redLinesToggle.addEventListener("change", () => {
      this.setRedLinesVisible(this.redLinesToggle.checked);
    });
    try {
      const saved = JSON.parse(localStorage.getItem("gis-calib") || "null");
      if (saved && Number.isFinite(saved.e) && Number.isFinite(saved.n)) {
        this.calibE = saved.e;
        this.calibN = saved.n;
        if (Number.isFinite(saved.rot)) this.calibRot = saved.rot;
      }
    } catch {
      /* нет сохранённой калибровки — старт с нуля */
    }
  }

  private setStatus(t: string): void {
    this.statusEl.textContent = t;
  }

  /** Поднимает карту (basemap + кадастр) — вызывается при входе в ГИС. */
  open(): void {
    void this.ensureMap();
    this.renderPanel();
  }

  /** main.ts задаёт колбэк открытия отчёта проверок (модалка с эскизами по каждой модели). */
  setChecksViewer(cb: () => void): void {
    this.onShowChecks = cb;
  }

  /**
   * Единый загрузчик: принимает любой микс файлов (FBX/IFC/DWG/PDF/GeoJSON),
   * определяет тип по расширению, обрабатывает по очереди и кладёт всё на карту
   * одновременно (модели — цветокодированные срезы, ЗУ — зелёным, кр. линии — красным).
   */
  async openFiles(files: File[]): Promise<void> {
    const list = files.filter(Boolean);
    if (list.length === 0) return;
    this.dropzone.classList.add("hidden");
    try {
      await this.ensureMap();
      await this.ensureProj4();
    } catch (err) {
      console.error(err);
      this.setStatus(this.loadErr(err, "карты"));
      return;
    }
    let ok = 0;
    const errs: string[] = [];
    for (const f of list) {
      this.setStatus(`Обработка «${f.name}» (${ok + errs.length + 1}/${list.length})…`);
      try {
        await this.ingestOne(f);
        ok++;
        this.redrawAll(false); // инкрементально, без зума
        this.renderPanel();
      } catch (err) {
        console.error(err);
        errs.push(`${f.name} — ${this.loadErr(err)}`);
      }
    }
    this.redrawAll(true); // финальный fit по всему набору
    this.renderPanel();
    const parts = [
      this.models.length ? `моделей: ${this.models.length}` : "",
      this.boundaries.length ? `границ ЗУ: ${this.boundaries.length}` : "",
      this.redlineSets.length ? `кр. линий: ${this.redlineSets.reduce((s, r) => s + r.n, 0)}` : "",
    ].filter(Boolean);
    const head = ok > 0 ? `Загружено · ${parts.join(" · ") || "нет данных"}` : "Ничего не загружено";
    this.setStatus(errs.length ? `${head}. Ошибки: ${errs.join("; ")}` : head);
  }

  // Тонкие обёртки под старые точки входа (drop/инпуты) — всё идёт через openFiles.
  loadFbx(file: File): Promise<void> { return this.openFiles([file]); }
  openIfc(file: File): Promise<void> { return this.openFiles([file]); }
  openGpzu(file: File): Promise<void> { return this.openFiles([file]); }
  openDwg(file: File): Promise<void> { return this.openFiles([file]); }
  openRedLines(file: File): Promise<void> { return this.openFiles([file]); }

  /** Понятное сообщение об ошибке; ловит сбой ленивого чанка после редеплоя. */
  private loadErr(err: unknown, what = ""): string {
    const m = err instanceof Error ? err.message : String(err);
    if (/dynamically imported module|module script failed|Failed to fetch|Loading chunk|importing a module|error loading dynamically/i.test(m))
      return "вышла новая версия — обновите страницу (Cmd/Ctrl+Shift+R)";
    return what ? `ошибка загрузки ${what}: ${m}` : m;
  }

  /** Диспетчер по расширению одного файла. */
  private async ingestOne(file: File): Promise<void> {
    const name = file.name.toLowerCase();
    if (name.endsWith(".fbx")) await this.addFbx(file);
    else if (name.endsWith(".ifc")) await this.addIfc(file);
    else if (name.endsWith(".dwg")) await this.addDwg(file);
    else if (name.endsWith(".pdf")) await this.addGpzu(file);
    else if (name.endsWith(".geojson") || name.endsWith(".json")) await this.addRedLines(file);
    else throw new Error("неподдерживаемый тип файла");
  }

  /** FBX → мировые меши (Y-up) → модель в коллекцию. */
  private async addFbx(file: File): Promise<void> {
    const buf = await file.arrayBuffer();
    const group = new FBXLoader().parse(buf, "");
    group.updateMatrixWorld(true);
    const world = collectWorld(group);
    if (world.verts === 0) throw new Error("в FBX не найдено геометрии");
    this.addModel(world, file.name, "fbx", { source: "fbx" });
  }

  /** IFC → web-ifc меши (Y-up) + геопривязка → модель в коллекцию. */
  private async addIfc(file: File): Promise<void> {
    const { IfcParser } = await import("../core/ifc-parser.ts");
    const parser = new IfcParser();
    const buf = new Uint8Array(await file.arrayBuffer());
    await parser.open(buf, { fileName: file.name, fileSize: buf.length });
    const world = ifcMeshesToWorld(parser.getMeshes());
    let geo: ModelGeo;
    try {
      const g = await parser.geoReference();
      if (g.ok) {
        const { lat0, lng0, method } = g.ref;
        const inM = lat0 >= 55.09 && lat0 <= 56.08 && lng0 >= 36.75 && lng0 <= 38.0;
        geo = { source: "ifc", ok: true, lat: lat0, lng: lng0, method, inMoscow: inM };
      } else {
        geo = { source: "ifc", ok: false, reason: g.reason };
      }
    } catch {
      geo = { source: "ifc", ok: false, reason: "ошибка чтения геопривязки" };
    }
    parser.close();
    if (world.verts === 0) throw new Error("в IFC не найдено геометрии");
    this.addModel(world, file.name, "ifc", geo);
  }

  /**
   * Общая укладка модели (FBX/IFC) в коллекцию: оба источника Y-up (FBXLoader и
   * web-ifc), поэтому ось/срез/калибровка/GIS-01 — единые. Рисование — в redrawAll.
   */
  private addModel(
    world: { meshes: WorldMesh[]; min: number[]; max: number[]; verts: number; tris: number },
    name: string,
    kind: "fbx" | "ifc",
    geo: ModelGeo,
  ): void {
    const { meshes, min, max, verts, tris } = world;
    // ось1=высота, ось0=East, ось2=−North (Y-up). center в горизонт. осях [hA=0, hB=2].
    const vAxis = 1, hA = 0, hB = 2;
    const center: Pt = [(min[hA] + max[hA]) / 2, (min[hB] + max[hB]) / 2];
    const footprint = sliceFootprint(meshes, vAxis, hA, hB, min[vAxis] + 0.01);
    const geom: FbxGeom = { meshes, min, max, vAxis, hA, hB, isCloud: tris === 0 };
    const nPts = footprint.points.length || footprint.rings.reduce((s, r) => s + r.length, 0);
    this.models.push({
      id: `m${++this.seq}`,
      name,
      kind,
      geom,
      geo,
      footprint,
      center,
      color: MODEL_PALETTE[this.models.length % MODEL_PALETTE.length],
      info: `${(verts / 1000).toFixed(0)}k вершин · ${tris ? "меш" : "точки"} · срез: ${nPts} тчк`,
    });
  }

  /** ГПЗУ (PDF) → участок по координатам поворотных точек (МСК-77) в коллекцию границ. */
  private async addGpzu(file: File): Promise<void> {
    const { parseGpzu } = await import("./gpzu.ts");
    const parcel = await parseGpzu(file);
    if (parcel.rings.length === 0) throw new Error("в ГПЗУ не найдена таблица координат поворотных точек");
    const npts = parcel.rings.reduce((s, r) => s + r.length, 0);
    const meta = [parcel.cadNumber, parcel.area && `${parcel.area} м²`].filter(Boolean).join(" · ");
    this.boundaries.push({
      id: `b${++this.seq}`,
      name: file.name,
      kind: "gpzu",
      rings: parcel.rings,
      ok: true,
      info: `${meta ? meta + " · " : ""}${npts} тчк`,
    });
  }

  /**
   * DWG → кривые по слоям → граница ЗУ (по имени слоя или крупнейший замкнутый
   * контур) → участок (МСК-77, авто-детект оси) в коллекцию границ.
   */
  private async addDwg(file: File): Promise<void> {
    const { parseDwg } = await import("./dwg.ts");
    const res = await parseDwg(file);
    if (res.rings.length === 0)
      throw new Error(`контур ЗУ не найден (слои: ${res.allLayers.slice(0, 6).join(", ") || "—"})`);
    const toGpzu = this.pickDwgAxis(res.rings);
    const rings = res.rings.map((r) => r.pts.map(toGpzu));
    const npts = rings.reduce((s, r) => s + r.length, 0);
    const others = res.candidates
      .filter((c) => c.score > 0 && c.layer !== res.chosenLayer)
      .slice(0, 3)
      .map((c) => `${c.layer}(${c.score})`);
    const layerInfo = res.matchedByLayer
      ? `слой «${res.chosenLayer}»`
      : `крупнейший контур (слой ЗУ не распознан: «${res.chosenLayer}»)`;
    const hint = others.length ? ` · др.: ${others.join(", ")}` : "";
    this.boundaries.push({
      id: `b${++this.seq}`,
      name: file.name,
      kind: "dwg",
      rings,
      ok: res.matchedByLayer,
      info: `${layerInfo} · ${npts} тчк${hint}`,
    });
  }

  /**
   * Красные линии из GeoJSON (WGS84) → набор client-side слоя. Временно, пока
   * импорт в metatiler не починен; потом заменим на тайлы 347001.
   */
  private async addRedLines(file: File): Promise<void> {
    const gj = JSON.parse(await file.text());
    const fc =
      gj?.type === "FeatureCollection"
        ? gj
        : { type: "FeatureCollection", features: gj?.type === "Feature" ? [gj] : [] };
    const features: unknown[] = Array.isArray(fc.features) ? fc.features : [];
    if (features.length === 0) throw new Error("нет объектов (ожидался GeoJSON FeatureCollection)");
    this.redlineSets.push({ id: `r${++this.seq}`, name: file.name, n: features.length, features });
    this.rebuildRedlines();
    this.redLinesToggle.checked = true;
    this.setRedLinesVisible(true);
  }

  /** Пересобирает client-side слой красных линий из всех загруженных наборов. */
  private rebuildRedlines(): void {
    const src = this.map?.getSource("redlines-local") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({ type: "FeatureCollection", features: this.redlineSets.flatMap((s) => s.features) } as any);
  }

  /** Авто-детект оси DWG→МСК-77: пробуем обе ориентации, берём попадание в Москву. */
  private pickDwgAxis(rings: { pts: { x: number; y: number }[] }[]): (p: { x: number; y: number }) => GpzuPoint {
    let sx = 0, sy = 0, k = 0;
    for (const r of rings) for (const p of r.pts) { sx += p.x; sy += p.y; k++; }
    const cx = sx / k, cy = sy / k;
    const inMoscow = (lng: number, lat: number) => lat >= 55.09 && lat <= 56.08 && lng >= 36.75 && lng <= 38.0;
    const llA = this.toWgs84(cx, cy); // A: east=x, north=y
    const llB = this.toWgs84(cy, cx); // B: east=y, north=x
    const aOk = inMoscow(llA[0], llA[1]);
    const bOk = inMoscow(llB[0], llB[1]);
    if (bOk && !aOk) return (p) => ({ X: p.x, Y: p.y }); // north=x, east=y
    return (p) => ({ X: p.y, Y: p.x }); // дефолт A: north=y, east=x
  }

  /** Рисует участок ГПЗУ (МСК-77 → WGS84 тем же proj4, что FBX) и делает его целью совмещения. */
  /** Пере-рисовывает всё (модели + границы) и при fit масштабирует на весь набор. */
  private redrawAll(fit: boolean): void {
    if (!this.map) return;
    this.recomputePivot();
    const bounds = new maplibregl.LngLatBounds();
    this.drawModels(bounds);
    this.drawBoundaries(bounds);
    if (fit && !bounds.isEmpty()) this.map.fitBounds(bounds, { padding: 70, maxZoom: 19, duration: 0 });
    this.map.resize();
  }

  /** Общий центр всех моделей в МСК-77 (raw, до калибровки) — ось доворота. */
  private recomputePivot(): void {
    if (this.models.length === 0) { this.calibPivot = null; return; }
    let se = 0, sn = 0;
    for (const m of this.models) { const [e, n] = this.toMsk(m.center[0], m.center[1]); se += e; sn += n; }
    this.calibPivot = [se / this.models.length, sn / this.models.length];
  }

  /** Рисует нижние срезы всех моделей (цветокодировано) + маркеры центров. */
  private drawModels(bounds: maplibregl.LngLatBounds): void {
    const map = this.map!;
    const features: any[] = [];
    const ext = (c: [number, number]) => {
      if (Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[1]) <= 90) bounds.extend(c);
    };
    for (const m of this.models) {
      const color = m.color;
      for (const ring of m.footprint.rings) {
        const coords = ring.map((p) => this.ll(p)).filter((c) => Math.abs(c[1]) <= 90);
        if (coords.length >= 3) {
          features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: { k: "ring", color } });
          coords.forEach(ext);
        }
      }
      for (const line of m.footprint.lines) {
        const coords = line.map((p) => this.ll(p)).filter((c) => Math.abs(c[1]) <= 90);
        if (coords.length >= 2) {
          features.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { k: "line", color } });
          coords.forEach(ext);
        }
      }
      for (const p of m.footprint.points) {
        const c = this.ll(p);
        if (Math.abs(c[1]) <= 90) {
          features.push({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: { k: "pt", color } });
          ext(c);
        }
      }
    }
    (map.getSource("footprint") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features } as any);

    this.clearMarkers();
    for (const m of this.models) {
      const c = this.ll(m.center);
      if (Math.abs(c[1]) <= 90) {
        const mk = new maplibregl.Marker({ color: m.color })
          .setLngLat(c)
          .setPopup(new maplibregl.Popup({ offset: 24 }).setText(`${m.name} (срез у основания)`))
          .addTo(map);
        this.markers.push(mk);
        ext(c);
      }
    }
  }

  /** Рисует все границы ЗУ (ГПЗУ+DWG) зелёным; цель «совместить центр» = крупнейший участок. */
  private drawBoundaries(bounds: maplibregl.LngLatBounds): void {
    const map = this.map!;
    const features: any[] = [];
    const toCoords = (ring: Pt[]): [number, number][] => {
      const c = ring.map(([e, n]) => this.toWgs84(e, n)).filter((p) => Math.abs(p[1]) <= 90);
      c.forEach((p) => bounds.extend(p));
      const a = c[0], z = c[c.length - 1];
      if (a && z && (a[0] !== z[0] || a[1] !== z[1])) c.push(a);
      return c;
    };
    let best: { area: number; c: Pt } | null = null;
    for (const b of this.boundaries) {
      const ringsEN: Pt[][] = b.rings.map((r) => r.map((p) => [p.Y, p.X] as Pt)); // [east,north]
      for (const poly of classifyRings(ringsEN)) {
        if (poly.exterior.length < 3) continue;
        features.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [toCoords(poly.exterior), ...poly.holes.filter((h) => h.length >= 3).map(toCoords)] },
          properties: { id: b.id },
        });
        const area = ringAreaEN(poly.exterior);
        const c = centroidEN(poly.exterior);
        if (c && (!best || area > best.area)) best = { area, c };
      }
    }
    (map.getSource("gpzu") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features } as any);

    if (best) {
      this.targetMsk = best.c; // [east, north]
      const snapBtn = this.infoEl.querySelector<HTMLButtonElement>("#gis-snap");
      if (snapBtn) snapBtn.hidden = false;
      const tInfo = this.infoEl.querySelector("#gis-target-info");
      if (tInfo) tInfo.textContent = `Цель: участок ЗУ, центр МСК-77 E ${best.c[0].toFixed(1)} N ${best.c[1].toFixed(1)}`;
    }
  }

  private clearMarkers(): void {
    for (const m of this.markers) m.remove();
    this.markers = [];
  }

  /** Удаляет загруженный элемент (модель/границу/кр.линии) по id и пере-рисовывает. */
  removeItem(id: string): void {
    this.models = this.models.filter((m) => m.id !== id);
    this.boundaries = this.boundaries.filter((b) => b.id !== id);
    const before = this.redlineSets.length;
    this.redlineSets = this.redlineSets.filter((r) => r.id !== id);
    if (this.redlineSets.length !== before) this.rebuildRedlines();
    // перенумеруем цвета моделей по палитре после удаления
    this.models.forEach((m, i) => (m.color = MODEL_PALETTE[i % MODEL_PALETTE.length]));
    this.redrawAll(false);
    this.renderPanel();
    this.setStatus("Элемент удалён");
  }

  private toWgs84(east: number, north: number): [number, number] {
    const [lng, lat] = this.proj4(MSK77, "WGS84", [east, north]);
    return [lng, lat]; // GeoJSON-порядок [lng, lat]
  }
  /** Горизонтальные координаты среза модели → МСК-77 [east,north] с учётом калибровки. */
  private toMskCal(p: Pt): Pt {
    let [e, n] = this.toMsk(p[0], p[1]);
    // Доворот вокруг общего центра моделей (в кадре МСК-77), затем сдвиг.
    if (this.calibRot !== 0 && this.calibPivot) {
      const [e0, n0] = this.calibPivot;
      const th = (this.calibRot * Math.PI) / 180;
      const cos = Math.cos(th), sin = Math.sin(th);
      const de = e - e0, dn = n - n0;
      e = e0 + de * cos - dn * sin;
      n = n0 + de * sin + dn * cos;
    }
    return [e + this.calibE, n + this.calibN];
  }
  private ll(p: Pt): [number, number] {
    const [e, n] = this.toMskCal(p);
    return this.toWgs84(e, n);
  }

  /**
   * Проверка GIS-01 «Здание полностью в границах ЗУ» — по КАЖДОЙ модели.
   * Нужны хотя бы одна граница ЗУ (ГПЗУ/DWG) и хотя бы одна модель (FBX/IFC).
   * Каждая модель проверяется против ОБЪЕДИНЕНИЯ всех границ; возвращается список
   * вердиктов (по модели) + SVG-эскиз каждой. Сами вычисления — в gis01.ts.
   */
  runAllChecks(): { perModel: ModelCheckResult[]; counts: { pass: number; warn: number; fail: number } } | null {
    if (this.models.length === 0) {
      this.setStatus("GIS-01: сначала загрузите модель (FBX/IFC)");
      return null;
    }
    if (this.boundaries.length === 0) {
      this.setStatus("GIS-01: сначала загрузите ГПЗУ или DWG (границу ЗУ)");
      return null;
    }
    // Объединение всех границ ЗУ (внешние контуры + дырки из всех источников).
    const parcelPolys = this.boundaries.flatMap((b) =>
      classifyRings(b.rings.map((r) => r.map((p) => [p.Y, p.X] as Pt))),
    );
    const perModel: ModelCheckResult[] = this.models.map((m) => {
      const res = runGis01Calc(m.geom, parcelPolys, (p) => this.toMskCal(p));
      const diagnostic = res.noOverlap ? this.geoDiagnostic(m.geo) : "";
      const svg = sketchSvg(res, { diagnostic, file: `${m.name} (${m.kind.toUpperCase()})` });
      return { modelId: m.id, name: m.name, color: m.color, status: res.status, summary: res.summary, diagnostic, svg };
    });
    const counts = { pass: 0, warn: 0, fail: 0 };
    for (const r of perModel) counts[r.status]++;
    this.setStatus(`GIS-01 · моделей: ${perModel.length} — ✓${counts.pass} ⚠${counts.warn} ✗${counts.fail}`);
    this.renderPanel(perModel);
    return { perModel, counts };
  }

  /** Диагностика геопривязки конкретной модели для случая «объект вне ЗУ». */
  private geoDiagnostic(g: ModelGeo): string {
    if (g.source === "fbx") {
      return "FBX не несёт геопривязку в МСК-77 (голая геометрия от начала координат). Если объект вне ЗУ — модель смоделирована НЕ в МСК-77 либо смещена: совместите центр и докалибруйте, либо проверьте экспорт координат.";
    }
    // IFC
    if (g.ok) {
      const coord = `${g.lat?.toFixed(5)}°, ${g.lng?.toFixed(5)}°`;
      if (g.inMoscow) {
        return `Проблема IFC: геопривязка (${g.method}) даёт якорь ${coord} В Москве, но геометрия модели вне ЗУ — проверьте локальные размещения (IfcLocalPlacement), единицы и смещение модели относительно базовой точки.`;
      }
      return `Проблема IFC: геопривязка (${g.method}) ведёт ВНЕ Москвы — якорь ${coord}. Координаты заданы в чужой СК (не МСК-77) — типично для Revit-дефолта. Нужна корректная привязка МСК-77 (IfcMapConversion/IfcProjectedCRS или IfcSite lat/lng).`;
    }
    return `Проблема IFC: геопривязка отсутствует/не вычислена (${g.reason}). Модель нельзя позиционировать по IFC-гео — задайте МСК-77 (IfcMapConversion + IfcProjectedCRS=МСК-77, либо IfcSite RefLatitude/RefLongitude).`;
  }

  /** Меняет калибровку (ΔВосток, ΔСевер в м; Δθ в град), сохраняет, пере-рисует без зума. */
  private applyCalib(e: number, n: number, rot: number): void {
    this.calibE = Math.round(e * 100) / 100;
    this.calibN = Math.round(n * 100) / 100;
    this.calibRot = Math.round(rot * 100) / 100;
    try {
      localStorage.setItem(
        "gis-calib",
        JSON.stringify({ e: this.calibE, n: this.calibN, rot: this.calibRot }),
      );
    } catch {
      /* localStorage недоступен — калибровка только на сессию */
    }
    this.updateCalibReadout();
    this.redrawAll(false);
  }

  private updateCalibReadout(): void {
    const el = this.infoEl.querySelector("#gis-calib-val");
    if (el)
      el.textContent = `ΔВ ${this.calibE.toFixed(1)} · ΔС ${this.calibN.toFixed(1)} м · ∠ ${this.calibRot.toFixed(1)}°`;
  }

  /** Левая панель: загруженные данные (с удалением) + проверки + калибровка. */
  renderPanel(checks?: ModelCheckResult[]): void {
    if (checks) this.lastChecks = checks;
    this.infoEl.hidden = false;
    const hasModels = this.models.length > 0;
    const canCheck = hasModels && this.boundaries.length > 0;

    const items: string[] = [];
    for (const m of this.models)
      items.push(this.itemRow(m.id, m.kind.toUpperCase(), m.name, m.info, "gis-badge-model", m.color));
    for (const b of this.boundaries)
      items.push(this.itemRow(b.id, b.kind === "dwg" ? "DWG" : "ГПЗУ", b.name, b.info, b.ok ? "gis-badge-zu" : "gis-badge-warn"));
    for (const r of this.redlineSets)
      items.push(this.itemRow(r.id, "кр.линии", r.name, `${r.n} об.`, "gis-badge-rl"));
    const itemsHtml = items.length
      ? items.join("")
      : `<div class="gis-empty">Перетащите файлы (IFC / DWG / FBX / PDF / GeoJSON) или «Открыть файлы»</div>`;

    const checkRows = (this.lastChecks || [])
      .map(
        (c) => `<div class="gis-check-item">
          <span class="gis-swatch" style="background:${c.color}"></span>
          <span class="gis-check-name" title="${esc(c.summary)}">${esc(c.name)}</span>
          <span class="gis-check-badge status-${c.status}">${c.status === "pass" ? "✓" : c.status === "warn" ? "⚠" : "✗"}</span>
        </div>`,
      )
      .join("");
    const checksBody = canCheck
      ? `<button id="gis-run-checks" class="gis-run-checks">▶ GIS-01 · здание в границах ЗУ</button>${checkRows ? `<div class="gis-check-list">${checkRows}</div>` : ""}`
      : `<div class="gis-empty">Загрузите модель (FBX/IFC) и границу ЗУ (ГПЗУ/DWG)</div>`;

    this.infoEl.innerHTML = `
      <div class="gis-panel-sec">
        <div class="gis-panel-head"><b>Загруженные данные</b></div>
        <div class="gis-items">${itemsHtml}</div>
      </div>
      <div class="gis-panel-sec">
        <div class="gis-panel-head"><b>Проверки</b></div>
        ${checksBody}
      </div>
      ${hasModels ? this.calibPanelHtml() : ""}`;

    this.infoEl.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((btn) =>
      btn.addEventListener("click", () => this.removeItem(btn.dataset.del!)),
    );
    this.infoEl.querySelector<HTMLButtonElement>("#gis-run-checks")?.addEventListener("click", () => this.onShowChecks?.());
    if (hasModels) {
      this.wireCalibControls();
      this.wireTargetControls();
      this.updateCalibReadout();
    }
  }

  private itemRow(id: string, badge: string, name: string, info: string, badgeCls: string, swatch?: string): string {
    return `<div class="gis-item">
      <span class="gis-badge ${badgeCls}">${esc(badge)}</span>
      ${swatch ? `<span class="gis-swatch" style="background:${swatch}"></span>` : ""}
      <span class="gis-item-name" title="${esc(name)}">${esc(name)}</span>
      <span class="gis-item-info">${esc(info)}</span>
      <button class="gis-item-del" data-del="${id}" title="убрать">✕</button>
    </div>`;
  }

  /** Markup блока «Мой участок» + калибровка (общая на все модели). */
  private calibPanelHtml(): string {
    return `
      <div class="gis-target">
        <div class="gis-panel-head"><b>Мой участок</b> (кад. №)</div>
        <div class="gis-target-row">
          <input id="gis-cadnum" type="text" placeholder="77:06:0005005:..." spellcheck="false" />
          <button id="gis-cadfind" title="найти участок в видимой области">Найти</button>
        </div>
        <div id="gis-target-info" class="gis-info-row gis-target-info"></div>
        <button id="gis-snap" class="gis-snap" hidden>Совместить центр моделей ↹ участок</button>
      </div>
      <div class="gis-calib">
        <div class="gis-panel-head"><b>Калибровка к кадастру</b> <span id="gis-calib-val"></span></div>
        <div class="gis-calib-pad">
          <button data-calib="n+" title="север +">▲</button>
          <div class="gis-calib-mid">
            <button data-calib="e-" title="запад −">◀</button>
            <button data-calib="reset" title="сброс всего">⟲</button>
            <button data-calib="e+" title="восток +">▶</button>
          </div>
          <button data-calib="n-" title="север −">▼</button>
        </div>
        <label class="gis-calib-step">шаг сдвига
          <select id="gis-calib-step">
            <option value="0.1">0.1 м</option>
            <option value="0.5">0.5 м</option>
            <option value="1" selected>1 м</option>
            <option value="5">5 м</option>
            <option value="10">10 м</option>
          </select>
        </label>
        <div class="gis-calib-rot">
          <button data-calib="rot-" title="против часовой">↺</button>
          <select id="gis-calib-rotstep">
            <option value="0.1">0.1°</option>
            <option value="0.5" selected>0.5°</option>
            <option value="1">1°</option>
          </select>
          <button data-calib="rot+" title="по часовой">↻</button>
        </div>
      </div>`;
  }

  /** Ввод кад. номера → найти участок и кнопка «совместить центр». */
  private wireTargetControls(): void {
    const input = this.infoEl.querySelector<HTMLInputElement>("#gis-cadnum");
    const findBtn = this.infoEl.querySelector<HTMLButtonElement>("#gis-cadfind");
    const snapBtn = this.infoEl.querySelector<HTMLButtonElement>("#gis-snap");
    findBtn?.addEventListener("click", () => void this.findTargetParcel(input?.value || ""));
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.findTargetParcel(input.value);
    });
    snapBtn?.addEventListener("click", () => this.snapToTarget());
    // Если цель уже задана (ГПЗУ/кадастр загружены до FBX) — показать кнопку совмещения.
    if (this.targetMsk && snapBtn) {
      snapBtn.hidden = false;
      const tInfo = this.infoEl.querySelector("#gis-target-info");
      if (tInfo) tInfo.textContent = `Цель задана · центр МСК-77 E ${this.targetMsk[0].toFixed(1)} N ${this.targetMsk[1].toFixed(1)}`;
    }
  }

  /** Находит участок по кад. номеру в загруженных тайлах, подсвечивает, считает центр в МСК-77. */
  private async findTargetParcel(numRaw: string): Promise<void> {
    const map = this.map;
    const infoEl = this.infoEl.querySelector("#gis-target-info");
    const snapBtn = this.infoEl.querySelector<HTMLButtonElement>("#gis-snap");
    const num = numRaw.trim();
    if (!map || !num) return;
    const norm = (s: string) => s.replace(/\s+/g, "");
    const feats = map
      .querySourceFeatures("cadastre", { sourceLayer: CADASTRE_SRC_LAYER })
      .filter((f) => norm(String((f.properties as any)?.cadastral_number || "")) === norm(num));
    if (feats.length === 0) {
      this.targetMsk = null;
      (map.getSource("target") as maplibregl.GeoJSONSource)?.setData({ type: "FeatureCollection", features: [] });
      if (snapBtn) snapBtn.hidden = true;
      if (infoEl) infoEl.textContent = "не найдено в видимой области — приблизьте карту к участку";
      return;
    }
    // Подсветка всех фрагментов участка + сбор точек для центроида (WGS84).
    const fc = { type: "FeatureCollection", features: feats.map((f) => ({ type: "Feature", geometry: f.geometry, properties: {} })) };
    (map.getSource("target") as maplibregl.GeoJSONSource).setData(fc as any);
    let sx = 0, sy = 0, k = 0;
    const acc = (c: number[]) => {
      if (Number.isFinite(c[0]) && Number.isFinite(c[1])) { sx += c[0]; sy += c[1]; k++; }
    };
    const walk = (g: any) => {
      if (!g) return;
      if (g.type === "Polygon") g.coordinates.forEach((r: number[][]) => r.forEach(acc));
      else if (g.type === "MultiPolygon") g.coordinates.forEach((p: number[][][]) => p.forEach((r) => r.forEach(acc)));
    };
    feats.forEach((f) => walk(f.geometry));
    if (k === 0) return;
    const lng = sx / k, lat = sy / k;
    await this.ensureProj4();
    const [e, n] = this.proj4("WGS84", MSK77, [lng, lat]) as [number, number];
    this.targetMsk = [e, n];
    if (snapBtn) snapBtn.hidden = false;
    if (infoEl)
      infoEl.textContent = `участок найден · центр МСК-77 E ${e.toFixed(1)} N ${n.toFixed(1)} (${feats.length} фрагм.)`;
  }

  /** Сдвигает калибровку так, чтобы общий центр моделей совпал с центром целевого участка. */
  private snapToTarget(): void {
    this.recomputePivot();
    if (!this.targetMsk || !this.calibPivot) return;
    // calibPivot — центр моделей в raw МСК (до калибровки); сдвиг = target − pivot.
    this.applyCalib(this.targetMsk[0] - this.calibPivot[0], this.targetMsk[1] - this.calibPivot[1], this.calibRot);
  }

  /** Навешивает обработчики на пад калибровки в инфо-панели. */
  private wireCalibControls(): void {
    const stepEl = this.infoEl.querySelector<HTMLSelectElement>("#gis-calib-step");
    const rotStepEl = this.infoEl.querySelector<HTMLSelectElement>("#gis-calib-rotstep");
    const step = () => (stepEl ? parseFloat(stepEl.value) || 1 : 1);
    const rotStep = () => (rotStepEl ? parseFloat(rotStepEl.value) || 0.5 : 0.5);
    this.infoEl.querySelectorAll<HTMLButtonElement>("[data-calib]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const a = btn.dataset.calib;
        const s = step();
        if (a === "e+") this.applyCalib(this.calibE + s, this.calibN, this.calibRot);
        else if (a === "e-") this.applyCalib(this.calibE - s, this.calibN, this.calibRot);
        else if (a === "n+") this.applyCalib(this.calibE, this.calibN + s, this.calibRot);
        else if (a === "n-") this.applyCalib(this.calibE, this.calibN - s, this.calibRot);
        else if (a === "rot+") this.applyCalib(this.calibE, this.calibN, this.calibRot + rotStep());
        else if (a === "rot-") this.applyCalib(this.calibE, this.calibN, this.calibRot - rotStep());
        else if (a === "reset") this.applyCalib(0, 0, 0);
      });
    });
  }

  private setCadastreVisible(vis: boolean): void {
    if (!this.map) return;
    const v = vis ? "visible" : "none";
    for (const id of ["cad-fill", "cad-line"]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", v);
    }
  }

  private setRedLinesVisible(vis: boolean): void {
    if (!this.map) return;
    const v = vis ? "visible" : "none";
    for (const id of ["rl-fill", "rl-line", "rll-fill", "rll-line"]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", v);
    }
  }

  private async ensureProj4(): Promise<void> {
    if (this.proj4) return;
    this.proj4 = (await import("proj4")).default;
  }

  private ensureMap(): Promise<void> {
    if (this.ready) return this.ready;
    this.map = new maplibregl.Map({
      container: this.mapEl,
      center: [37.62, 55.75],
      zoom: 9,
      attributionControl: { compact: true },
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: [OSM_TILES],
            tileSize: 256,
            attribution: "© OpenStreetMap, © CARTO",
          },
          cadastre: {
            type: "vector",
            tiles: [`${METATILER_BASE}/tiles/${CADASTRE_LAYER_ID}/{z}/{x}/{y}`],
            minzoom: 0,
            maxzoom: 16,
          },
          redlines: {
            type: "vector",
            tiles: [`${METATILER_BASE}/tiles/${REDLINES_LAYER_ID}/{z}/{x}/{y}`],
            minzoom: 0,
            maxzoom: 16,
          },
        },
        layers: [
          { id: "osm", type: "raster", source: "osm" },
          {
            id: "cad-fill",
            type: "fill",
            source: "cadastre",
            "source-layer": CADASTRE_SRC_LAYER,
            paint: { "fill-color": CADASTRE_COLOR, "fill-opacity": 0.1 },
          },
          {
            id: "cad-line",
            type: "line",
            source: "cadastre",
            "source-layer": CADASTRE_SRC_LAYER,
            paint: { "line-color": CADASTRE_COLOR, "line-width": 0.8, "line-opacity": 0.7 },
          },
          {
            id: "rl-fill",
            type: "fill",
            source: "redlines",
            "source-layer": REDLINES_SRC_LAYER,
            filter: ["==", ["geometry-type"], "Polygon"],
            layout: { visibility: this.redLinesToggle.checked ? "visible" : "none" },
            paint: { "fill-color": REDLINES_COLOR, "fill-opacity": 0.08 },
          },
          {
            id: "rl-line",
            type: "line",
            source: "redlines",
            "source-layer": REDLINES_SRC_LAYER,
            layout: { visibility: this.redLinesToggle.checked ? "visible" : "none" },
            paint: { "line-color": REDLINES_COLOR, "line-width": 1.6, "line-opacity": 0.9 },
          },
        ],
      },
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");

    this.ready = new Promise((resolve) => {
      this.map!.on("load", () => {
        this.addFootprintLayers();
        this.wireCadastrePopup();
        resolve();
      });
    });
    return this.ready;
  }

  private addFootprintLayers(): void {
    const map = this.map!;
    // Целевой участок — под слоем FBX, ярко-жёлтым, чтобы выделялся из синего кадастра.
    map.addSource("target", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "target-fill",
      type: "fill",
      source: "target",
      paint: { "fill-color": TARGET_COLOR, "fill-opacity": 0.18 },
    });
    map.addLayer({
      id: "target-line",
      type: "line",
      source: "target",
      paint: { "line-color": TARGET_COLOR, "line-width": 3 },
    });
    // Красные линии из GeoJSON (client-side, WGS84) — временно, до тайлов metatiler.
    const rlVis = this.redLinesToggle.checked ? "visible" : "none";
    map.addSource("redlines-local", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "rll-fill",
      type: "fill",
      source: "redlines-local",
      filter: ["==", ["geometry-type"], "Polygon"],
      layout: { visibility: rlVis },
      paint: { "fill-color": REDLINES_COLOR, "fill-opacity": 0.08 },
    });
    map.addLayer({
      id: "rll-line",
      type: "line",
      source: "redlines-local",
      layout: { visibility: rlVis },
      paint: { "line-color": REDLINES_COLOR, "line-width": 1.6, "line-opacity": 0.95 },
    });
    // Участок из ГПЗУ — авторитетный эталон (МСК-77), ярко-зелёным.
    map.addSource("gpzu", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "gpzu-fill",
      type: "fill",
      source: "gpzu",
      paint: { "fill-color": GPZU_COLOR, "fill-opacity": 0.15 },
    });
    map.addLayer({
      id: "gpzu-line",
      type: "line",
      source: "gpzu",
      paint: { "line-color": GPZU_COLOR, "line-width": 2.5 },
    });
    // Срезы моделей — цвет берётся из свойства feature (цветокодировка моделей).
    const fpColor = ["coalesce", ["get", "color"], FOOTPRINT_COLOR] as any;
    map.addSource("footprint", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "fp-fill",
      type: "fill",
      source: "footprint",
      filter: ["==", ["get", "k"], "ring"],
      paint: { "fill-color": fpColor, "fill-opacity": 0.25 },
    });
    map.addLayer({
      id: "fp-line",
      type: "line",
      source: "footprint",
      filter: ["in", ["get", "k"], ["literal", ["ring", "line"]]],
      paint: { "line-color": fpColor, "line-width": 2 },
    });
    map.addLayer({
      id: "fp-pt",
      type: "circle",
      source: "footprint",
      filter: ["==", ["get", "k"], "pt"],
      paint: { "circle-radius": 2.5, "circle-color": fpColor, "circle-opacity": 0.8 },
    });
  }

  private wireCadastrePopup(): void {
    const map = this.map!;
    map.on("click", "cad-fill", (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p: any = f.properties || {};
      const row = (label: string, val: any) =>
        val ? `<div><b>${label}:</b> ${String(val)}</div>` : "";
      const html = `
        <div style="font:12px sans-serif;max-width:280px">
          ${row("Кадастровый №", p.cadastral_number)}
          ${row("Адрес", p.address)}
          ${row("Категория", p.land_category)}
          ${row("Разреш. использование", p.permitted_use)}
          ${row("Площадь, м²", p.square)}
          ${row("Статус", p.status)}
        </div>`;
      new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on("mouseenter", "cad-fill", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "cad-fill", () => (map.getCanvas().style.cursor = ""));
  }
}

// ── Утилиты ──────────────────────────────────────────────────────────────────

/** Экранирование для вставки в HTML/атрибуты панели. */
function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/** Площадь кольца [east,north] (шнуровка). */
function ringAreaEN(ring: Pt[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}
/** Центроид кольца [east,north]. */
function centroidEN(ring: Pt[]): Pt | null {
  if (ring.length === 0) return null;
  let sx = 0, sy = 0;
  for (const p of ring) { sx += p[0]; sy += p[1]; }
  return [sx / ring.length, sy / ring.length];
}

// ── Геометрия FBX ────────────────────────────────────────────────────────────

interface Footprint {
  rings: Pt[][];
  lines: Pt[][];
  points: Pt[];
}
interface WorldMesh {
  world: Float32Array;
  index: ArrayLike<number> | null;
}

function collectWorld(group: THREE.Object3D): {
  meshes: WorldMesh[];
  min: number[];
  max: number[];
  verts: number;
  tris: number;
} {
  const meshes: WorldMesh[] = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let verts = 0;
  let tris = 0;
  const v = new THREE.Vector3();
  group.traverse((o: any) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    const n = pos.count;
    const world = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
      world[i * 3] = v.x;
      world[i * 3 + 1] = v.y;
      world[i * 3 + 2] = v.z;
      if (v.x < min[0]) min[0] = v.x;
      if (v.y < min[1]) min[1] = v.y;
      if (v.z < min[2]) min[2] = v.z;
      if (v.x > max[0]) max[0] = v.x;
      if (v.y > max[1]) max[1] = v.y;
      if (v.z > max[2]) max[2] = v.z;
    }
    verts += n;
    const idx = o.geometry.index ? o.geometry.index.array : null;
    if (idx) tris += idx.length / 3;
    meshes.push({ world, index: idx });
  });
  return { meshes, min, max, verts, tris };
}

/** web-ifc меши ({positions, indices}, world Y-up) → формат конвейера FBX (с bbox). */
function ifcMeshesToWorld(ms: { positions: Float32Array; indices: ArrayLike<number> }[]): {
  meshes: WorldMesh[];
  min: number[];
  max: number[];
  verts: number;
  tris: number;
} {
  const meshes: WorldMesh[] = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let verts = 0;
  let tris = 0;
  for (const m of ms) {
    const p = m.positions;
    if (!p || p.length === 0) continue;
    meshes.push({ world: p, index: m.indices });
    verts += p.length / 3;
    tris += m.indices.length / 3;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < min[0]) min[0] = p[i];
      if (p[i] > max[0]) max[0] = p[i];
      if (p[i + 1] < min[1]) min[1] = p[i + 1];
      if (p[i + 1] > max[1]) max[1] = p[i + 1];
      if (p[i + 2] < min[2]) min[2] = p[i + 2];
      if (p[i + 2] > max[2]) max[2] = p[i + 2];
    }
  }
  return { meshes, min, max, verts, tris };
}

function sliceFootprint(
  meshes: WorldMesh[],
  vAxis: number,
  hA: number,
  hB: number,
  sliceV: number,
): Footprint {
  const rings: Pt[][] = [];
  const lines: Pt[][] = [];
  const points: Pt[] = [];
  let anyTris = false;

  for (const m of meshes) {
    const p = m.world;
    if (m.index && m.index.length >= 3) {
      anyTris = true;
      const segs: [Pt, Pt][] = [];
      for (let t = 0; t + 2 < m.index.length; t += 3) {
        const a = m.index[t] * 3;
        const b = m.index[t + 1] * 3;
        const c = m.index[t + 2] * 3;
        const pts: Pt[] = [];
        cross(p, a, b, vAxis, hA, hB, sliceV, pts);
        cross(p, b, c, vAxis, hA, hB, sliceV, pts);
        cross(p, c, a, vAxis, hA, hB, sliceV, pts);
        if (pts.length === 2) segs.push([pts[0], pts[1]]);
      }
      const { loops, open } = stitch(segs);
      rings.push(...loops);
      lines.push(...open);
    }
  }

  if (!anyTris) {
    let minV = Infinity;
    let maxV = -Infinity;
    for (const m of meshes)
      for (let i = vAxis; i < m.world.length; i += 3) {
        if (m.world[i] < minV) minV = m.world[i];
        if (m.world[i] > maxV) maxV = m.world[i];
      }
    const band = Math.max((maxV - minV) * 0.02, 0.5);
    for (const m of meshes)
      for (let i = 0; i < m.world.length; i += 3) {
        if (m.world[i + vAxis] <= minV + band) points.push([m.world[i + hA], m.world[i + hB]]);
      }
  }
  return { rings, lines, points };
}

function cross(
  p: Float32Array,
  i: number,
  j: number,
  vAxis: number,
  hA: number,
  hB: number,
  plane: number,
  out: Pt[],
): void {
  const vi = p[i + vAxis];
  const vj = p[j + vAxis];
  if (vi > plane === vj > plane) return;
  const t = (plane - vi) / (vj - vi);
  out.push([p[i + hA] + t * (p[j + hA] - p[i + hA]), p[i + hB] + t * (p[j + hB] - p[i + hB])]);
}

function stitch(segs: [Pt, Pt][]): { loops: Pt[][]; open: Pt[][] } {
  const key = (p: Pt) => `${Math.round(p[0] * 100)}_${Math.round(p[1] * 100)}`;
  const ek = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const pos = new Map<string, Pt>();
  const adj = new Map<string, Set<string>>();
  const edges = new Set<string>();
  for (const [a, b] of segs) {
    const ka = key(a);
    const kb = key(b);
    if (ka === kb) continue;
    pos.set(ka, a);
    pos.set(kb, b);
    (adj.get(ka) ?? adj.set(ka, new Set()).get(ka)!).add(kb);
    (adj.get(kb) ?? adj.set(kb, new Set()).get(kb)!).add(ka);
    edges.add(ek(ka, kb));
  }
  const loops: Pt[][] = [];
  const open: Pt[][] = [];
  const used = new Set<string>();
  for (const start of edges) {
    if (used.has(start)) continue;
    const first = start.split("|")[0];
    const path = [first];
    let cur = first;
    for (let guard = 0; guard < edges.size + 1; guard++) {
      const next = [...(adj.get(cur) ?? [])].find((n) => !used.has(ek(cur, n)));
      if (next == null) break;
      used.add(ek(cur, next));
      path.push(next);
      cur = next;
      if (cur === first) break;
    }
    const pts = path.map((k) => pos.get(k)!);
    if (cur === first && path.length >= 4) loops.push(pts);
    else if (pts.length >= 2) open.push(pts);
  }
  return { loops, open };
}
