/**
 * Доменные типы IFC-парсера.
 * Намеренно не зависят ни от web-ifc, ни от three.js —
 * это контракт между ядром (core), вьювером (viewer) и UI.
 */

/** Краткая запись об элементе модели (для списка/дерева). */
export interface IfcElement {
  /** express ID — уникальный номер строки в IFC-файле. */
  expressID: number;
  /** Числовой код типа web-ifc (например, код IFCWALL). */
  typeCode: number;
  /** Человекочитаемое имя типа, например "IFCWALL". */
  typeName: string;
  /** Атрибут Name, если задан. */
  name: string | null;
  /** GlobalId (GUID), если задан. */
  globalId: string | null;
}

/** Одно свойство внутри property set. */
export interface IfcProperty {
  name: string;
  value: string | number | boolean | null;
  /** Единица измерения / тип значения, если удалось извлечь. */
  unit?: string;
}

/** Набор свойств (Pset) или набор количеств (Qto). */
export interface IfcPropertySet {
  expressID: number;
  name: string;
  /** "pset" — IfcPropertySet, "qto" — IfcElementQuantity, "type" — свойства типа. */
  kind: "pset" | "qto" | "type";
  properties: IfcProperty[];
}

/** Полная информация по выбранному элементу. */
export interface IfcElementInfo {
  element: IfcElement;
  /** Прямые атрибуты сущности (Name, ObjectType, Tag, PredefinedType, ...). */
  attributes: IfcProperty[];
  /** Property sets и quantity sets. */
  propertySets: IfcPropertySet[];
}

/** Геометрия одного размещённого меша — сырьё для three.js. */
export interface IfcMeshData {
  expressID: number;
  positions: Float32Array; // xyz, по 3 на вершину
  normals: Float32Array; // xyz, по 3 на вершину
  indices: Uint32Array;
  /** Цвет RGBA из IFC-материала, компоненты 0..1. */
  color: { r: number; g: number; b: number; a: number };
  /** 4x4 матрица размещения (column-major, как у three.js). */
  matrix: number[];
}
