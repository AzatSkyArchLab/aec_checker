import { IfcAPI, IFCPRODUCT } from "web-ifc";
import type {
  IfcElement,
  IfcElementInfo,
  IfcMeshData,
  IfcProperty,
  IfcPropertySet,
  ModelOffset,
} from "./types.ts";
import { runChecks, type CheckOutcome } from "./checks/index.ts";
import {
  computeFootprint,
  footprintToGeo,
  getGeoReference,
  type FootprintResult,
} from "./geo.ts";

/**
 * Тонкая модульная обёртка над web-ifc.
 *
 * Отвечает только за чтение IFC: список элементов, атрибуты + property sets,
 * геометрия. Ничего не знает про three.js и DOM — это переиспользуемое ядро.
 */
export class IfcParser {
  private api: IfcAPI;
  private modelID = -1;
  private ready = false;

  /** Смещение модели: мировая координата IFC = позиция_меша + offset. */
  private offset: ModelOffset = { x: 0, y: 0, z: 0 };
  /** Последняя построенная геометрия (для среза по Z=0). */
  private meshes: IfcMeshData[] = [];
  /** Мета загруженного файла (для проверок именования/размера/формата). */
  private fileName = "";
  private fileSize = 0;

  constructor() {
    this.api = new IfcAPI();
  }

  /** Инициализирует WASM. Идемпотентно. */
  async init(): Promise<void> {
    if (this.ready) return;
    // WASM лежит в public/ → отдаётся по BASE_URL и в dev, и в проде.
    this.api.SetWasmPath(import.meta.env.BASE_URL, true);
    await this.api.Init();
    this.ready = true;
  }

  /** Загружает модель из бинарных данных файла. Закрывает предыдущую. */
  async open(
    data: Uint8Array,
    meta?: { fileName?: string; fileSize?: number },
  ): Promise<void> {
    await this.init();
    this.close();
    // БЕЗ COORDINATE_TO_ORIGIN: рецентрируем сами (getMeshes), чтобы знать offset
    // и корректно резать на исходном уровне Z=0 + привязывать к координатам.
    this.modelID = this.api.OpenModel(data);
    this.offset = { x: 0, y: 0, z: 0 };
    this.meshes = [];
    this.fileName = meta?.fileName ?? "";
    this.fileSize = meta?.fileSize ?? data.byteLength;
  }

  /** Закрывает текущую модель и освобождает память. */
  close(): void {
    if (this.modelID !== -1) {
      this.api.CloseModel(this.modelID);
      this.modelID = -1;
    }
  }

  get isOpen(): boolean {
    return this.modelID !== -1;
  }

  // ── Элементы ──────────────────────────────────────────────────────────────

  /**
   * Все элементы модели (подтипы IfcProduct: стены, плиты, пространства и т.д.).
   */
  getElements(): IfcElement[] {
    this.assertOpen();
    const ids = this.api.GetLineIDsWithType(this.modelID, IFCPRODUCT, true);
    const out: IfcElement[] = [];
    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      out.push(this.toElement(id));
    }
    return out;
  }

  // ── Проверки модели ─────────────────────────────────────────────────────────

  /** Прогоняет весь каталог проверок ЦИМ АГР по модели. */
  async runChecks(): Promise<CheckOutcome[]> {
    this.assertOpen();
    return runChecks({
      api: this.api,
      modelID: this.modelID,
      fileName: this.fileName,
      fileSize: this.fileSize,
    });
  }

  private toElement(expressID: number): IfcElement {
    const typeCode = this.api.GetLineType(this.modelID, expressID);
    let name: string | number | boolean | null = null;
    let globalId: string | number | boolean | null = null;
    try {
      const line = this.api.GetLine(this.modelID, expressID, false);
      name = this.scalar(line?.Name);
      globalId = this.scalar(line?.GlobalId);
    } catch {
      /* строка без читаемых атрибутов — оставляем null */
    }
    return {
      expressID,
      typeCode,
      typeName: this.typeName(typeCode),
      name: name != null ? String(name) : null,
      globalId: globalId != null ? String(globalId) : null,
    };
  }

  // ── Свойства выбранного элемента ────────────────────────────────────────────

  /** Полная карточка элемента: прямые атрибуты + property/quantity sets. */
  async getElementInfo(expressID: number): Promise<IfcElementInfo> {
    this.assertOpen();
    const element = this.toElement(expressID);
    const attributes = this.readAttributes(expressID);
    const propertySets = await this.readPropertySets(expressID);
    return { element, attributes, propertySets };
  }

  /** Прямые атрибуты сущности (Name, ObjectType, Tag, PredefinedType, ...). */
  private readAttributes(expressID: number): IfcProperty[] {
    const line = this.api.GetLine(this.modelID, expressID, false);
    const out: IfcProperty[] = [];
    for (const key of Object.keys(line)) {
      if (key === "expressID" || key === "type") continue;
      const raw = line[key];
      const value = this.displayValue(raw);
      if (value === null && Array.isArray(raw) && raw.length === 0) continue;
      out.push({ name: key, value });
    }
    return out;
  }

  /** Property sets и quantity sets, привязанные к элементу (свои + от типа). */
  private async readPropertySets(expressID: number): Promise<IfcPropertySet[]> {
    const sets: IfcPropertySet[] = [];

    // Прямые Pset/Qto элемента.
    // ВАЖНО: includeTypeProperties=true ломает web-ifc для элементов без типа
    // (возвращает пустой массив) — поэтому берём прямые с false, а свойства
    // типа добираем отдельно через getTypeProperties ниже.
    try {
      const direct = await this.api.properties.getPropertySets(
        this.modelID,
        expressID,
        true,
        false,
      );
      for (const ps of direct as Record<string, any>[]) {
        this.pushSet(ps, sets, false);
      }
    } catch {
      /* у элемента нет свойств */
    }

    // Pset/Qto, заданные на типе элемента (IfcXxxType.HasPropertySets).
    try {
      const types = await this.api.properties.getTypeProperties(
        this.modelID,
        expressID,
        true,
      );
      for (const t of types as Record<string, any>[]) {
        const has = t?.HasPropertySets;
        if (Array.isArray(has)) {
          for (const ps of has) this.pushSet(ps, sets, true);
        }
      }
    } catch {
      /* у элемента нет типа — это нормально */
    }

    return sets;
  }

  /** Нормализует сырой Pset/Qto web-ifc в IfcPropertySet и добавляет в список. */
  private pushSet(
    ps: Record<string, any>,
    sets: IfcPropertySet[],
    fromType: boolean,
  ): void {
    if (!ps) return;
    const name = this.scalar(ps?.Name);
    if (Array.isArray(ps?.HasProperties)) {
      sets.push({
        expressID: ps.expressID,
        name: name != null ? String(name) : "(Pset без имени)",
        kind: fromType ? "type" : "pset",
        properties: ps.HasProperties.map((p: any) => this.toProperty(p)).filter(
          Boolean,
        ) as IfcProperty[],
      });
    } else if (Array.isArray(ps?.Quantities)) {
      sets.push({
        expressID: ps.expressID,
        name: name != null ? String(name) : "(Qto без имени)",
        kind: "qto",
        properties: ps.Quantities.map((q: any) => this.toQuantity(q)).filter(
          Boolean,
        ) as IfcProperty[],
      });
    }
  }

  private toProperty(p: Record<string, any>): IfcProperty | null {
    const name = this.scalar(p?.Name);
    if (name == null) return null;
    let value: IfcProperty["value"] = null;
    if (p.NominalValue !== undefined) value = this.primitive(p.NominalValue);
    else if (Array.isArray(p.EnumerationValues))
      value = p.EnumerationValues.map((v: any) => this.primitive(v)).join(", ");
    else if (Array.isArray(p.ListValues))
      value = p.ListValues.map((v: any) => this.primitive(v)).join(", ");
    const unit = this.scalar(p?.Unit);
    return {
      name: String(name),
      value,
      unit: unit != null ? String(unit) : undefined,
    };
  }

  private toQuantity(q: Record<string, any>): IfcProperty | null {
    const name = this.scalar(q?.Name);
    if (name == null) return null;
    const valueKey = [
      "LengthValue",
      "AreaValue",
      "VolumeValue",
      "CountValue",
      "WeightValue",
      "TimeValue",
    ].find((k) => q[k] !== undefined);
    const value = valueKey ? this.primitive(q[valueKey]) : null;
    return { name: String(name), value };
  }

  // ── Геометрия ──────────────────────────────────────────────────────────────

  /**
   * Извлекает всю геометрию в мировых координатах IFC. Матрица размещения
   * запекается в вершины (float64), затем вычитается центр bbox (offset) —
   * так числа малы для float32, а offset позволяет вернуться к мировым координатам.
   * Вершины web-ifc де-интерливятся: [x,y,z, nx,ny,nz] на вершину.
   */
  getMeshes(): IfcMeshData[] {
    this.assertOpen();
    const meshes: IfcMeshData[] = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    this.api.StreamAllMeshes(this.modelID, (mesh) => {
      const placed = mesh.geometries;
      for (let i = 0; i < placed.size(); i++) {
        const pg = placed.get(i);
        const geom = this.api.GetGeometry(this.modelID, pg.geometryExpressID);
        const verts = this.api.GetVertexArray(
          geom.GetVertexData(),
          geom.GetVertexDataSize(),
        );
        const indices = this.api.GetIndexArray(
          geom.GetIndexData(),
          geom.GetIndexDataSize(),
        );
        const m = pg.flatTransformation; // 4x4 column-major

        const vertexCount = verts.length / 6;
        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);
        for (let v = 0; v < vertexCount; v++) {
          const lx = verts[v * 6], ly = verts[v * 6 + 1], lz = verts[v * 6 + 2];
          const nx = verts[v * 6 + 3], ny = verts[v * 6 + 4], nz = verts[v * 6 + 5];
          // Мировые координаты (float64): применяем матрицу размещения.
          const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
          const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
          const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
          positions[v * 3] = wx;
          positions[v * 3 + 1] = wy;
          positions[v * 3 + 2] = wz;
          // Нормали: только вращение (placement IFC жёсткий).
          normals[v * 3] = m[0] * nx + m[4] * ny + m[8] * nz;
          normals[v * 3 + 1] = m[1] * nx + m[5] * ny + m[9] * nz;
          normals[v * 3 + 2] = m[2] * nx + m[6] * ny + m[10] * nz;
          if (wx < minX) minX = wx;
          if (wy < minY) minY = wy;
          if (wz < minZ) minZ = wz;
          if (wx > maxX) maxX = wx;
          if (wy > maxY) maxY = wy;
          if (wz > maxZ) maxZ = wz;
        }

        meshes.push({
          expressID: mesh.expressID,
          positions,
          normals,
          indices: new Uint32Array(indices),
          color: { r: pg.color.x, g: pg.color.y, b: pg.color.z, a: pg.color.w },
        });
      }
    });

    // Центр bbox → offset; вычитаем из всех позиций (рецентрирование).
    this.offset = meshes.length
      ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 }
      : { x: 0, y: 0, z: 0 };
    for (const m of meshes) {
      for (let i = 0; i < m.positions.length; i += 3) {
        m.positions[i] -= this.offset.x;
        m.positions[i + 1] -= this.offset.y;
        m.positions[i + 2] -= this.offset.z;
      }
    }
    this.meshes = meshes;
    return meshes;
  }

  /** Смещение модели: мировая координата IFC = позиция_меша + offset. */
  getModelOffset(): ModelOffset {
    return this.offset;
  }

  // ── Гео: срез на уровне 0 + привязка к карте ──────────────────────────────────

  /**
   * Делает горизонтальный срез на уровне Z=0 и проецирует контур на карту,
   * если у модели есть геопривязка. Геометрия должна быть уже построена (getMeshes).
   */
  async getFootprintGeo(): Promise<FootprintResult> {
    this.assertOpen();
    if (this.meshes.length === 0) {
      return { ok: false, reason: "Геометрия не построена" };
    }
    const refRes = await getGeoReference(this.api, this.modelID);
    if (!refRes.ok) return refRes;

    const footprint = computeFootprint(this.meshes, this.offset);
    if (footprint.rings.length === 0 && footprint.lines.length === 0) {
      return {
        ok: false,
        reason: "Срез на уровне 0 пуст — на этой высоте нет геометрии",
      };
    }
    return { ok: true, footprint: footprintToGeo(footprint, refRes.ref) };
  }

  // ── Утилиты ──────────────────────────────────────────────────────────────

  private typeName(typeCode: number): string {
    try {
      return this.api.GetNameFromTypeCode(typeCode);
    } catch {
      return `TYPE_${typeCode}`;
    }
  }

  /** Достаёт примитивное значение из обёртки web-ifc { type, value } либо примитива. */
  private scalar(v: any): string | number | boolean | null {
    if (v == null) return null;
    if (typeof v === "object" && "value" in v) return v.value ?? null;
    if (typeof v === "object") return null;
    return v;
  }

  private primitive(v: any): string | number | boolean | null {
    const s = this.scalar(v);
    return s;
  }

  /** Человекочитаемое представление произвольного атрибута для UI. */
  private displayValue(v: any): string | number | boolean | null {
    if (v == null) return null;
    if (Array.isArray(v)) {
      const parts = v.map((x) => this.displayValue(x)).filter((x) => x != null);
      return parts.length ? parts.join(", ") : null;
    }
    if (typeof v === "object") {
      // Ссылка на другую строку: { type: 5, value: <expressID> }
      if (v.type === 5 && typeof v.value === "number") return `#${v.value}`;
      if ("value" in v) return v.value ?? null;
      return null;
    }
    return v;
  }

  private assertOpen(): void {
    if (this.modelID === -1) throw new Error("IFC-модель не загружена");
  }
}
