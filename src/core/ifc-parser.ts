import { IfcAPI, IFCPRODUCT } from "web-ifc";
import type {
  IfcElement,
  IfcElementInfo,
  IfcMeshData,
  IfcProperty,
  IfcPropertySet,
} from "./types.ts";
import { runChecks, type CheckResult } from "./checks/index.ts";

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
  async open(data: Uint8Array): Promise<void> {
    await this.init();
    this.close();
    // COORDINATE_TO_ORIGIN: центрируем геореференс-модели у начала координат,
    // иначе огромные координаты дают артефакты точности float32 в three.js.
    this.modelID = this.api.OpenModel(data, { COORDINATE_TO_ORIGIN: true });
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

  /** Прогоняет все зарегистрированные проверки (геопривязка и т.д.). */
  async runChecks(): Promise<CheckResult[]> {
    this.assertOpen();
    return runChecks({ api: this.api, modelID: this.modelID });
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
   * Извлекает всю геометрию модели в нейтральном виде для three.js.
   * Вершины де-интерливятся: web-ifc отдаёт [x,y,z, nx,ny,nz] на вершину.
   */
  getMeshes(): IfcMeshData[] {
    this.assertOpen();
    const meshes: IfcMeshData[] = [];
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

        const vertexCount = verts.length / 6;
        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);
        for (let v = 0; v < vertexCount; v++) {
          positions[v * 3] = verts[v * 6];
          positions[v * 3 + 1] = verts[v * 6 + 1];
          positions[v * 3 + 2] = verts[v * 6 + 2];
          normals[v * 3] = verts[v * 6 + 3];
          normals[v * 3 + 1] = verts[v * 6 + 4];
          normals[v * 3 + 2] = verts[v * 6 + 5];
        }

        meshes.push({
          expressID: mesh.expressID,
          positions,
          normals,
          indices: new Uint32Array(indices),
          color: { r: pg.color.x, g: pg.color.y, b: pg.color.z, a: pg.color.w },
          matrix: Array.from(pg.flatTransformation),
        });
      }
    });
    return meshes;
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
