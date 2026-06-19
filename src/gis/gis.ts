import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

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
const OSM_TILES = "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png";

const FOOTPRINT_COLOR = "#e8590c";
const CADASTRE_COLOR = "#1f77b4";
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

  constructor(
    private mapEl: HTMLElement,
    private statusEl: HTMLElement,
    private infoEl: HTMLElement,
    private dropzone: HTMLElement,
    private cadastreToggle: HTMLInputElement,
  ) {
    this.cadastreToggle.addEventListener("change", () => {
      this.setCadastreVisible(this.cadastreToggle.checked);
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

      const { meshes, min, max, verts, tris } = collectWorld(group);
      if (verts === 0) {
        this.setStatus("В FBX не найдено геометрии");
        return;
      }
      const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      const vAxis = [0, 1, 2].reduce((a, i) => (Math.abs(center[i]) < Math.abs(center[a]) ? i : a), 0);
      const [hA, hB] = [0, 1, 2].filter((i) => i !== vAxis) as [number, number];

      await this.ensureProj4();
      // FBX из МСК-77 — Z-up; FBXLoader поворачивает в Y-up (x,y,z)→(x,z,-y):
      // ось1 = высота, ось0 = East (Y_МСК), ось2 = -North (X_МСК).
      this.toMsk = vAxis === 1 ? (a, b) => [a, -b] : (a, b) => [a, b];

      const sliceV = min[vAxis] + 0.01;
      const footprint = sliceFootprint(meshes, vAxis, hA, hB, sliceV);

      await this.ensureMap();
      this.draw(footprint, [center[hA], center[hB]]);

      this.setStatus(
        `${file.name} · ${(verts / 1000).toFixed(0)}k вершин · ${tris ? "меш" : "точки"} · точек среза: ${footprint.points.length || footprint.rings.reduce((s, r) => s + r.length, 0)}`,
      );
      this.showInfo(min, max, vAxis);
    } catch (err) {
      console.error(err);
      this.setStatus("Ошибка загрузки FBX");
      this.dropzone.classList.remove("hidden");
    }
  }

  private toWgs84(east: number, north: number): [number, number] {
    const [lng, lat] = this.proj4(MSK77, "WGS84", [east, north]);
    return [lng, lat]; // GeoJSON-порядок [lng, lat]
  }
  private ll(p: Pt): [number, number] {
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
    return this.toWgs84(e + this.calibE, n + this.calibN);
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
    this.updateCalibReadout();
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
