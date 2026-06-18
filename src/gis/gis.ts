import "leaflet/dist/leaflet.css";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

/**
 * ГИС-режим: FBX в МСК-77 → нижний срез модели → контур на OSM-карте «как в FBX».
 * Проекция МСК-77 (выверена, см. rosreestr.py): tmerc lat_0=55°40′, lon_0=37.5°,
 * Красовский + towgs84 Пулково-1942→WGS84. proj4 отдаёт [east, north].
 */
const MSK77 =
  "+proj=tmerc +lat_0=55.66666666666667 +lon_0=37.5 +k=1 +x_0=0 +y_0=0 +ellps=krass +towgs84=23.57,-140.95,-79.8,0,0.35,0.79,-0.22 +units=m +no_defs";

const FOOTPRINT_COLOR = "#e8590c";
type Pt = [number, number];

export class GisView {
  private L: any = null;
  private map: any = null;
  private layer: any = null;
  private proj4: any = null;
  /** (горизонт. координаты среза) → (east, north) МСК-77. Задаётся по оси «верх». */
  private toMsk: (a: number, b: number) => Pt = (a, b) => [a, b];

  constructor(
    private mapEl: HTMLElement,
    private statusEl: HTMLElement,
    private infoEl: HTMLElement,
    private dropzone: HTMLElement,
  ) {}

  private setStatus(t: string): void {
    this.statusEl.textContent = t;
  }

  /** Загружает FBX, режет низ модели, проецирует в WGS84, кладёт на карту. */
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
      // Вертикальная ось — у которой центр ближе всего к нулю (МСК-77 X,Y ~ тысячи м,
      // высота/отметка — десятки/сотни). Остальные две — горизонталь.
      const vAxis = [0, 1, 2].reduce((a, i) => (Math.abs(center[i]) < Math.abs(center[a]) ? i : a), 0);
      const [hA, hB] = [0, 1, 2].filter((i) => i !== vAxis) as [number, number];

      await this.ensureProj4();
      // FBX из МСК-77 — Z-up; FBXLoader поворачивает в Y-up как (x,y,z)→(x,z,-y).
      // Поэтому ось1 = высота, ось0 = East (Y_МСК), ось2 = -North (X_МСК).
      // → горизонтальная пара (hA,hB)=(0,2): east = hA, north = -hB.
      this.toMsk = vAxis === 1 ? (a, b) => [a, -b] : (a, b) => [a, b];
      console.log("[GIS] bbox min", min, "max", max, "| вертикаль = ось", vAxis);

      // Срез нижней части модели: vAxis = minV + 0.01.
      const sliceV = min[vAxis] + 0.01;
      const footprint = sliceFootprint(meshes, vAxis, hA, hB, sliceV);

      await this.ensureMap();
      this.draw(footprint, [center[hA], center[hB]]);

      this.setStatus(
        `${file.name} · ${(verts / 1000).toFixed(0)}k вершин · ${tris ? "меш" : "точки"} · контуров: ${footprint.rings.length + footprint.lines.length + footprint.points.length}`,
      );
      this.showInfo(min, max, vAxis);
    } catch (err) {
      console.error(err);
      this.setStatus("Ошибка загрузки FBX");
      this.dropzone.classList.remove("hidden");
    }
  }

  /** МСК-77 (east=Y, north=X) → [lat, lng]. */
  private toWgs84(east: number, north: number): [number, number] {
    const [lng, lat] = this.proj4(MSK77, "WGS84", [east, north]);
    return [lat, lng];
  }

  private draw(fp: Footprint, centerMsk: Pt): void {
    const L = this.L;
    this.layer.clearLayers();
    const bounds = L.latLngBounds([]);
    const toLL = (p: Pt) => {
      const [e, n] = this.toMsk(p[0], p[1]);
      return this.toWgs84(e, n);
    };

    for (const ring of fp.rings) {
      const ll = ring.map(toLL).filter(valid);
      if (ll.length >= 3) {
        L.polygon(ll, { color: FOOTPRINT_COLOR, weight: 2, fillOpacity: 0.25 }).addTo(this.layer);
        ll.forEach((p: Pt) => bounds.extend(p));
      }
    }
    for (const line of fp.lines) {
      const ll = line.map(toLL).filter(valid);
      if (ll.length >= 2) {
        L.polyline(ll, { color: FOOTPRINT_COLOR, weight: 2 }).addTo(this.layer);
        ll.forEach((p: Pt) => bounds.extend(p));
      }
    }
    for (const pt of fp.points) {
      const ll = toLL(pt);
      if (!valid(ll)) continue;
      L.circleMarker(ll, { radius: 2, color: FOOTPRINT_COLOR, fillOpacity: 0.7, weight: 0 }).addTo(this.layer);
      bounds.extend(ll);
    }

    const c = toLL(centerMsk);
    if (valid(c)) {
      L.circleMarker(c, { radius: 7, color: "#fff", weight: 2, fillColor: FOOTPRINT_COLOR, fillOpacity: 1 })
        .addTo(this.layer)
        .bindTooltip("Модель (срез у основания)", { permanent: true, direction: "top" });
      bounds.extend(c);
    }

    const fit = () => {
      this.map.invalidateSize();
      if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 20 });
      else if (valid(c)) this.map.setView(c, 17);
    };
    fit();
    setTimeout(fit, 80);
  }

  private showInfo(min: number[], max: number[], vAxis: number): void {
    this.infoEl.hidden = false;
    const f = (n: number) => n.toFixed(1);
    this.infoEl.innerHTML = `
      <div class="gis-info-row"><b>МСК-77 bbox</b></div>
      <div class="gis-info-row">X: ${f(min[0])} … ${f(max[0])}</div>
      <div class="gis-info-row">Y: ${f(min[1])} … ${f(max[1])}</div>
      <div class="gis-info-row">Z: ${f(min[2])} … ${f(max[2])}</div>
      <div class="gis-info-row">вертикаль: ось ${vAxis} · срез +0.01 от низа</div>`;
  }

  private async ensureProj4(): Promise<void> {
    if (this.proj4) return;
    this.proj4 = (await import("proj4")).default;
  }

  private async ensureMap(): Promise<void> {
    if (this.map) return;
    const mod: any = await import("leaflet");
    this.L = mod.default ?? mod;
    const L = this.L;
    this.map = L.map(this.mapEl, { zoomControl: true, maxZoom: 22, preferCanvas: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxNativeZoom: 19,
      maxZoom: 22,
      attribution: "© OpenStreetMap",
    }).addTo(this.map);
    this.layer = L.layerGroup().addTo(this.map);
    this.map.setView([55.75, 37.62], 10);
  }
}

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

/** Нижний срез: пересечение с плоскостью vAxis=sliceV, контур в (hA,hB). */
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

  // Точечные FBX (облака без граней): берём вершины у самого низа.
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

function valid(ll: [number, number]): boolean {
  return (
    Number.isFinite(ll[0]) &&
    Number.isFinite(ll[1]) &&
    Math.abs(ll[0]) <= 90 &&
    Math.abs(ll[1]) <= 180
  );
}
