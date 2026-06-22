import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { GpzuPoint } from "./gpzu.ts";
import { classifyRings, runGis01 as runGis01Calc, sketchSvg } from "./gis01.ts";

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
type Pt = [number, number];

export class GisView {
  private map: maplibregl.Map | null = null;
  private ready: Promise<void> | null = null;
  private proj4: any = null;
  private centerMarker: maplibregl.Marker | null = null;
  /** (горизонт. координаты среза) → (east, north) МСК-77. */
  private toMsk: (a: number, b: number) => Pt = (a, b) => [a, b];
  /**
   * Ручная калибровка сдвига в МСК-77 (м): ΔВосток, ΔСевер. Кадастр (НСПД,
   * индикативный) и FBX (привязан к точной выписке) расходятся на десятки
   * метров — этот сдвиг дотягивает модель до кадастра. Применяется до proj4,
   * т.е. полностью в кадре МСК-77. Хранится в localStorage (один на все модели).
   */
  private calibE = 0;
  private calibN = 0;
  /** Доворот FBX вокруг центра модели (град) — убирает остаточный поворот. */
  private calibRot = 0;
  /** Кэш последнего среза/центра для пере-отрисовки при изменении калибровки. */
  private lastFp: Footprint | null = null;
  private lastCenter: Pt | null = null;
  /** Центр целевого участка (кадастр/ГПЗУ) в МСК-77 (для «совместить центр»). */
  private targetMsk: Pt | null = null;
  /** Кольца участка из ГПЗУ (МСК-77, X=север Y=восток). */
  private gpzuRings: GpzuPoint[][] | null = null;
  /** Геометрия последней модели (FBX/IFC) для многоуровневых срезов в GIS-01. */
  private fbx: import("./gis01.ts").FbxGeom | null = null;
  /** Источник и геопривязка модели (для диагностики «объект вне ЗУ» в GIS-01). */
  private modelGeo:
    | { source: "fbx" }
    | { source: "ifc"; ok: boolean; lat?: number; lng?: number; method?: string; inMoscow?: boolean; reason?: string }
    | null = null;

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
  }

  /** Загружает FBX, режет низ модели, проецирует в WGS84, кладёт точки на карту. */
  async loadFbx(file: File): Promise<void> {
    this.setStatus(`Чтение «${file.name}»…`);
    this.dropzone.classList.add("hidden");
    try {
      const buf = await file.arrayBuffer();
      const group = new FBXLoader().parse(buf, "");
      group.updateMatrixWorld(true);
      const world = collectWorld(group);
      if (world.verts === 0) {
        this.setStatus("В FBX не найдено геометрии");
        return;
      }
      this.modelGeo = { source: "fbx" };
      await this.placeModel(world, file.name);
    } catch (err) {
      console.error(err);
      this.setStatus("Ошибка загрузки FBX");
      this.dropzone.classList.remove("hidden");
    }
  }

  /**
   * Общая укладка модели (FBX или IFC) на карту: оба источника дают геометрию
   * в Y-up (FBXLoader и web-ifc), поэтому ось/срез/калибровка/GIS-01 — единые.
   */
  private async placeModel(
    world: { meshes: WorldMesh[]; min: number[]; max: number[]; verts: number; tris: number },
    fileName: string,
  ): Promise<void> {
    const { meshes, min, max, verts, tris } = world;
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    // FBXLoader и web-ifc отдают Y-up → вертикаль всегда ось1 (надёжнее эвристики
    // по |center|, которая ломалась для моделей у начала координат).
    const vAxis = 1;
    const [hA, hB] = [0, 2] as [number, number];

    await this.ensureProj4();
    // ось1 = высота, ось0 = East (Y_МСК), ось2 = -North (X_МСК) — общая конвенция Y-up.
    this.toMsk = (a, b) => [a, -b];

    const sliceV = min[vAxis] + 0.01;
    const footprint = sliceFootprint(meshes, vAxis, hA, hB, sliceV);
    this.fbx = { meshes, min, max, vAxis, hA, hB, isCloud: tris === 0 };

    await this.ensureMap();
    this.draw(footprint, [center[hA], center[hB]]);
    this.setStatus(
      `${fileName} · ${(verts / 1000).toFixed(0)}k вершин · ${tris ? "меш" : "точки"} · точек среза: ${footprint.points.length || footprint.rings.reduce((s, r) => s + r.length, 0)}`,
    );
    this.showInfo(min, max, vAxis);
  }

  /** Загружает IFC: web-ifc → меши (Y-up) → тот же конвейер, что FBX (срез на карту + GIS-01). */
  async openIfc(file: File): Promise<void> {
    this.setStatus(`Чтение IFC «${file.name}»…`);
    this.dropzone.classList.add("hidden");
    try {
      await this.ensureMap(); // карта до тяжёлого парсинга web-ifc
      const { IfcParser } = await import("../core/ifc-parser.ts");
      const parser = new IfcParser();
      const buf = new Uint8Array(await file.arrayBuffer());
      await parser.open(buf, { fileName: file.name, fileSize: buf.length });
      const world = ifcMeshesToWorld(parser.getMeshes());
      // Захватываем геопривязку IFC ДО закрытия модели (для диагностики GIS-01).
      try {
        const geo = await parser.geoReference();
        if (geo.ok) {
          const { lat0, lng0, method } = geo.ref;
          const inM = lat0 >= 55.09 && lat0 <= 56.08 && lng0 >= 36.75 && lng0 <= 38.0;
          this.modelGeo = { source: "ifc", ok: true, lat: lat0, lng: lng0, method, inMoscow: inM };
        } else {
          this.modelGeo = { source: "ifc", ok: false, reason: geo.reason };
        }
      } catch {
        this.modelGeo = { source: "ifc", ok: false, reason: "ошибка чтения геопривязки" };
      }
      parser.close();
      if (world.verts === 0) {
        this.setStatus("В IFC не найдено геометрии");
        return;
      }
      await this.placeModel(world, file.name);
    } catch (err) {
      console.error(err);
      this.setStatus(`Ошибка загрузки IFC: ${(err as Error).message}`);
      this.dropzone.classList.remove("hidden");
    }
  }

  /** Загружает ГПЗУ (PDF), строит участок по координатам поворотных точек (МСК-77). */
  async openGpzu(file: File): Promise<void> {
    this.setStatus(`Чтение ГПЗУ «${file.name}»…`);
    this.dropzone.classList.add("hidden");
    try {
      const { parseGpzu } = await import("./gpzu.ts");
      const parcel = await parseGpzu(file);
      if (parcel.rings.length === 0) {
        this.setStatus("В ГПЗУ не найдена таблица координат поворотных точек");
        return;
      }
      this.gpzuRings = parcel.rings;
      await this.ensureProj4();
      await this.ensureMap();
      this.drawGpzu(true);
      const npts = parcel.rings.reduce((s, r) => s + r.length, 0);
      const info = [parcel.cadNumber, parcel.area && `${parcel.area} м²`].filter(Boolean).join(" · ");
      this.setStatus(`ГПЗУ: ${file.name}${info ? " · " + info : ""} · точек: ${npts}`);
    } catch (err) {
      console.error(err);
      this.setStatus("Ошибка чтения ГПЗУ");
    }
  }

  /**
   * Загружает DWG: извлекает кривые по слоям, находит границу ЗУ (по имени слоя
   * или крупнейший замкнутый контур), кладёт как участок (МСК-77) — как ГПЗУ.
   * Без ГПЗУ этот контур используется для GIS-01.
   */
  async openDwg(file: File): Promise<void> {
    this.setStatus(`Чтение DWG «${file.name}»…`);
    this.dropzone.classList.add("hidden");
    try {
      // Сначала поднимаем карту и proj4 — ДО тяжёлого синхронного парсинга DWG
      // (libredwg.convert блокирует главный поток и иначе ломает загрузку карты).
      await this.ensureMap();
      await this.ensureProj4();
      const { parseDwg } = await import("./dwg.ts");
      const res = await parseDwg(file);
      if (res.rings.length === 0) {
        this.setStatus(`DWG: контур ЗУ не найден. Слои: ${res.allLayers.slice(0, 8).join(", ") || "—"}`);
        return;
      }
      const toGpzu = this.pickDwgAxis(res.rings);
      this.gpzuRings = res.rings.map((r) => r.pts.map(toGpzu));
      this.drawGpzu(true);
      const npts = this.gpzuRings.reduce((s, r) => s + r.length, 0);
      // Какие слои ещё похожи на ЗУ (для контроля/выбора, пока имена не унифицированы).
      const others = res.candidates
        .filter((c) => c.score > 0 && c.layer !== res.chosenLayer)
        .slice(0, 4)
        .map((c) => `${c.layer}(${c.score})`);
      const layerInfo = res.matchedByLayer
        ? `слой «${res.chosenLayer}»`
        : `крупнейший контур (слой ЗУ не распознан — проверьте «${res.chosenLayer}»)`;
      const hint = others.length ? ` · др. кандидаты: ${others.join(", ")}` : "";
      this.setStatus(`DWG: ${file.name} · ${layerInfo} · точек: ${npts}${hint}`);
    } catch (err) {
      console.error(err);
      this.setStatus(`Ошибка чтения DWG: ${(err as Error).message}`);
    }
  }

  /**
   * Загружает красные линии из GeoJSON (WGS84) и кладёт client-side слоем на карту.
   * Временно, пока импорт в metatiler не починен; потом заменим на тайлы 347001.
   */
  async openRedLines(file: File): Promise<void> {
    this.setStatus(`Чтение красных линий «${file.name}»…`);
    this.dropzone.classList.add("hidden");
    try {
      await this.ensureMap();
      const gj = JSON.parse(await file.text());
      const fc =
        gj?.type === "FeatureCollection"
          ? gj
          : { type: "FeatureCollection", features: gj?.type === "Feature" ? [gj] : [] };
      const n = Array.isArray(fc.features) ? fc.features.length : 0;
      if (n === 0) {
        this.setStatus("В файле красных линий нет объектов (ожидался GeoJSON FeatureCollection)");
        return;
      }
      (this.map!.getSource("redlines-local") as maplibregl.GeoJSONSource).setData(fc);
      this.redLinesToggle.checked = true;
      this.setRedLinesVisible(true);
      // если модель/ЗУ ещё не загружены — подвинем карту к линиям, чтобы их было видно
      if (!this.fbx && !this.gpzuRings) {
        const b = new maplibregl.LngLatBounds();
        let cnt = 0;
        const extend = (c: unknown): void => {
          if (Array.isArray(c) && typeof c[0] === "number") {
            b.extend(c as [number, number]);
            cnt++;
          } else if (Array.isArray(c)) {
            for (const x of c) extend(x);
          }
        };
        for (const f of fc.features) extend((f as { geometry?: { coordinates?: unknown } })?.geometry?.coordinates);
        if (cnt > 0) this.map!.fitBounds(b, { padding: 60, maxZoom: 16, duration: 0 });
      }
      this.setStatus(`Красные линии: ${file.name} · объектов: ${n}`);
    } catch (err) {
      console.error(err);
      this.setStatus(`Ошибка чтения красных линий: ${(err as Error).message}`);
    }
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
  private drawGpzu(fit: boolean): void {
    if (!this.map || !this.gpzuRings) return;
    const map = this.map;
    const bounds = new maplibregl.LngLatBounds();
    // Классифицируем кольца на внешние контуры + дырки → GeoJSON Polygon с дырками
    // (MapLibre вырезает дырки в заливке).
    const ringsEN: Pt[][] = this.gpzuRings.map((r) => r.map((p) => [p.Y, p.X] as Pt)); // [east,north]
    const polys = classifyRings(ringsEN);
    const toCoords = (ring: Pt[]): [number, number][] => {
      const c = ring.map(([e, n]) => this.toWgs84(e, n)).filter((p) => Math.abs(p[1]) <= 90);
      c.forEach((p) => bounds.extend(p));
      const a = c[0], z = c[c.length - 1];
      if (a && z && (a[0] !== z[0] || a[1] !== z[1])) c.push(a); // замкнуть
      return c;
    };
    const features = polys
      .filter((poly) => poly.exterior.length >= 3)
      .map((poly) => ({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [toCoords(poly.exterior), ...poly.holes.filter((h) => h.length >= 3).map(toCoords)],
        },
        properties: {},
      }));
    (map.getSource("gpzu") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features,
    } as any);

    // Центр участка в МСК-77 → цель для «совместить центр» (north=X, east=Y).
    let sX = 0, sY = 0, n = 0;
    for (const r of this.gpzuRings) for (const p of r) { sX += p.X; sY += p.Y; n++; }
    if (n > 0) {
      this.targetMsk = [sY / n, sX / n]; // [east, north]
      const snapBtn = this.infoEl.querySelector<HTMLButtonElement>("#gis-snap");
      if (snapBtn) snapBtn.hidden = false;
      const tInfo = this.infoEl.querySelector("#gis-target-info");
      if (tInfo) tInfo.textContent = `Цель: участок ГПЗУ, центр МСК-77 E ${(sY / n).toFixed(1)} N ${(sX / n).toFixed(1)}`;
    }

    if (fit && !bounds.isEmpty()) map.fitBounds(bounds, { padding: 80, maxZoom: 19, duration: 0 });
    map.resize();
  }

  private toWgs84(east: number, north: number): [number, number] {
    const [lng, lat] = this.proj4(MSK77, "WGS84", [east, north]);
    return [lng, lat]; // GeoJSON-порядок [lng, lat]
  }
  /** Горизонтальные координаты среза FBX → МСК-77 [east,north] с учётом калибровки. */
  private toMskCal(p: Pt): Pt {
    let [e, n] = this.toMsk(p[0], p[1]);
    // Доворот вокруг центра модели (в кадре МСК-77), затем сдвиг.
    if (this.calibRot !== 0 && this.lastCenter) {
      const [e0, n0] = this.toMsk(this.lastCenter[0], this.lastCenter[1]);
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
   * Проверка GIS-01 «Здание полностью в границах ЗУ».
   * Нужны загруженные ГПЗУ (участок) и FBX (здание). Возвращает результат +
   * SVG-эскиз (вид сверху). Сами вычисления — в gis01.ts.
   */
  async runGis01(): Promise<{ status: string; summary: string; svg: string } | null> {
    if (!this.fbx) {
      this.setStatus("GIS-01: сначала загрузите модель (FBX/IFC)");
      return null;
    }
    if (!this.gpzuRings || this.gpzuRings.length === 0) {
      this.setStatus("GIS-01: сначала загрузите ГПЗУ или DWG (границу ЗУ)");
      return null;
    }
    const ringsEN: Pt[][] = this.gpzuRings.map((r) => r.map((p) => [p.Y, p.X] as Pt)); // [east,north]
    const parcelPolys = classifyRings(ringsEN); // внешние контуры + дырки
    const res = runGis01Calc(this.fbx, parcelPolys, (p) => this.toMskCal(p));

    // Если объект ни одной точкой не попал в ЗУ — диагностируем геопривязку
    // (детально — в эскиз/отчёт; в заголовке оставляем краткий вердикт).
    const diagnostic = res.noOverlap ? this.geoDiagnostic() : "";
    const svg = sketchSvg(res, { diagnostic });
    this.setStatus(`GIS-01: ${res.summary}`);
    return { status: res.status, summary: res.summary, svg };
  }

  /** Диагностика геопривязки модели для случая «объект вне ЗУ». */
  private geoDiagnostic(): string {
    const g = this.modelGeo;
    if (!g) return "Источник модели неизвестен — проверьте координаты модели и ЗУ.";
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

  private draw(fp: Footprint, centerMsk: Pt, fit = true): void {
    this.lastFp = fp;
    this.lastCenter = centerMsk;
    const map = this.map!;
    const features: any[] = [];
    const bounds = new maplibregl.LngLatBounds();
    const ext = (c: [number, number]) => {
      if (Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[1]) <= 90) bounds.extend(c);
    };

    for (const ring of fp.rings) {
      const coords = ring.map((p) => this.ll(p)).filter((c) => Math.abs(c[1]) <= 90);
      if (coords.length >= 3) {
        features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: { k: "ring" } });
        coords.forEach(ext);
      }
    }
    for (const line of fp.lines) {
      const coords = line.map((p) => this.ll(p)).filter((c) => Math.abs(c[1]) <= 90);
      if (coords.length >= 2) {
        features.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { k: "line" } });
        coords.forEach(ext);
      }
    }
    if (fp.points.length) {
      const coords = fp.points.map((p) => this.ll(p)).filter((c) => Math.abs(c[1]) <= 90);
      coords.forEach((c) => {
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: { k: "pt" } });
        ext(c);
      });
    }

    (map.getSource("footprint") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features,
    } as any);

    const c = this.ll(centerMsk);
    this.centerMarker?.remove();
    if (Math.abs(c[1]) <= 90) {
      this.centerMarker = new maplibregl.Marker({ color: FOOTPRINT_COLOR })
        .setLngLat(c)
        .setPopup(new maplibregl.Popup({ offset: 24 }).setText("Модель (срез у основания)"))
        .addTo(map);
      ext(c);
    }

    if (fit && !bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 60, maxZoom: 19, duration: 0 });
    }
    map.resize();
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
    if (this.lastFp && this.lastCenter) this.draw(this.lastFp, this.lastCenter, false);
  }

  private updateCalibReadout(): void {
    const el = this.infoEl.querySelector("#gis-calib-val");
    if (el)
      el.textContent = `ΔВ ${this.calibE.toFixed(1)} · ΔС ${this.calibN.toFixed(1)} м · ∠ ${this.calibRot.toFixed(1)}°`;
  }

  private showInfo(min: number[], max: number[], vAxis: number): void {
    this.infoEl.hidden = false;
    const f = (n: number) => n.toFixed(1);
    this.infoEl.innerHTML = `
      <div class="gis-info-row"><b>МСК-77 bbox</b></div>
      <div class="gis-info-row">X: ${f(min[0])} … ${f(max[0])}</div>
      <div class="gis-info-row">Y: ${f(min[1])} … ${f(max[1])}</div>
      <div class="gis-info-row">Z: ${f(min[2])} … ${f(max[2])}</div>
      <div class="gis-info-row">вертикаль: ось ${vAxis} · срез +0.01 от низа</div>
      <div class="gis-target">
        <div class="gis-info-row"><b>Мой участок</b> (кад. №)</div>
        <div class="gis-target-row">
          <input id="gis-cadnum" type="text" placeholder="77:06:0005005:..." spellcheck="false" />
          <button id="gis-cadfind" title="найти участок в видимой области">Найти</button>
        </div>
        <div id="gis-target-info" class="gis-info-row gis-target-info"></div>
        <button id="gis-snap" class="gis-snap" hidden>Совместить центр модели ↹ участок</button>
      </div>
      <div class="gis-calib">
        <div class="gis-info-row"><b>Калибровка к кадастру</b> <span id="gis-calib-val"></span></div>
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
    this.wireCalibControls();
    this.wireTargetControls();
    this.updateCalibReadout();
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

  /** Сдвигает калибровку так, чтобы центр модели совпал с центром целевого участка. */
  private snapToTarget(): void {
    if (!this.targetMsk || !this.lastCenter) return;
    const [be, bn] = this.toMsk(this.lastCenter[0], this.lastCenter[1]);
    this.applyCalib(this.targetMsk[0] - be, this.targetMsk[1] - bn, this.calibRot);
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
    map.addSource("footprint", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "fp-fill",
      type: "fill",
      source: "footprint",
      filter: ["==", ["get", "k"], "ring"],
      paint: { "fill-color": FOOTPRINT_COLOR, "fill-opacity": 0.25 },
    });
    map.addLayer({
      id: "fp-line",
      type: "line",
      source: "footprint",
      filter: ["in", ["get", "k"], ["literal", ["ring", "line"]]],
      paint: { "line-color": FOOTPRINT_COLOR, "line-width": 2 },
    });
    map.addLayer({
      id: "fp-pt",
      type: "circle",
      source: "footprint",
      filter: ["==", ["get", "k"], "pt"],
      paint: { "circle-radius": 2.5, "circle-color": FOOTPRINT_COLOR, "circle-opacity": 0.8 },
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
