/**
 * Территория Москвы для фильтра геопривязки.
 *
 * Bounding box = объединение прямоугольников «город + анклав Зеленоград» и
 * «Новая Москва (ТиНАО)» + запас 0.05°. Выверен по контрольным точкам:
 * внутри — Кремль (55.752, 37.618), Зеленоград (55.99, 37.21), Внуково,
 * Троицк, ЮЗ-точка Новой Москвы (55.142, 36.803); снаружи — Нью-Йорк, Берлин,
 * (0,0). Это грубый фильтр «точно вне Москвы»; для строгой принадлежности нужен
 * реальный полигон границ (OSM relations 2263058/2263059).
 */
export const MOSCOW_BOUNDS = {
  latMin: 55.09,
  latMax: 56.08,
  lngMin: 36.75,
  lngMax: 38.0,
} as const;

/** Точка (WGS84) попадает в bbox территории Москвы? */
export function isInMoscow(lat: number, lng: number): boolean {
  return (
    lat >= MOSCOW_BOUNDS.latMin &&
    lat <= MOSCOW_BOUNDS.latMax &&
    lng >= MOSCOW_BOUNDS.lngMin &&
    lng <= MOSCOW_BOUNDS.lngMax
  );
}

/** Грубая подсказка, куда указывают координаты (для сообщения об ошибке). */
export function describeLocation(lat: number, lng: number): string {
  if (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01) {
    return "нулевые координаты — привязка по умолчанию";
  }
  if (lng >= -125 && lng <= -66 && lat >= 24 && lat <= 50) return "вероятно США";
  if (lng < 0) return "западное полушарие";
  if (lat >= 35 && lat <= 71 && lng >= -11 && lng <= 40) return "Европа, вне Москвы";
  return "вне территории Москвы";
}
