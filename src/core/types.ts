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

/**
 * Геометрия одного размещённого меша — сырьё для three.js.
 * Позиции уже в мировых координатах IFC, со снятым смещением модели (offset),
 * чтобы числа были небольшими для float32. Матрица размещения запечена.
 */
export interface IfcMeshData {
  expressID: number;
  positions: Float32Array; // xyz, по 3 на вершину
  normals: Float32Array; // xyz, по 3 на вершину
  indices: Uint32Array;
  /** Цвет RGBA из IFC-материала, компоненты 0..1. */
  color: { r: number; g: number; b: number; a: number };
}

/** Смещение модели: мировая координата IFC = позиция_меша + offset. */
export interface ModelOffset {
  x: number;
  y: number;
  z: number;
}

/** Точка на плоскости (мировые координаты IFC, метры). */
export type Point2 = [x: number, y: number];

/** Гео-координата [широта, долгота] для Leaflet. */
export type LatLng = [lat: number, lng: number];

/**
 * Привязка локальных координат IFC к WGS84: точка отсчёта + орты «восток/север»
 * в локальной системе + масштаб. localToGeo считает тангенциальную проекцию.
 */
export interface GeoReference {
  lat0: number;
  lng0: number;
  east: Point2; // единичный вектор «географический восток» в локальных XY
  north: Point2; // единичный вектор «географический север» в локальных XY
  scale: number;
  /** Человекочитаемое описание метода привязки. */
  method: string;
}

/** Результат среза модели на уровне 0: контуры в мировых координатах IFC. */
export interface Footprint {
  rings: Point2[][]; // замкнутые контуры
  lines: Point2[][]; // незамкнутые отрезки/цепочки
}

/** Контур, спроецированный на карту (WGS84). */
export interface GeoFootprint {
  anchor: LatLng;
  rings: LatLng[][];
  lines: LatLng[][];
  method: string;
}
