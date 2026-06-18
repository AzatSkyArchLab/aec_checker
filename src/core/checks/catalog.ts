import type { CheckSpec } from "./types.ts";

/**
 * Загрузчик ПРИВАТНОГО каталога проверок ЦИМ АГР.
 *
 * Сами проверки (алгоритмы + НПА) не хранятся в публичном репозитории — они
 * лежат в public/checks-catalog.json (gitignore) и грузятся в рантайме.
 * Если файла нет (публичная сборка «только движок») — возвращаем пустой список,
 * и приложение показывает лишь реализованные проверки по их generic-описанию.
 */
let cache: CheckSpec[] | null = null;

export async function loadCatalog(): Promise<CheckSpec[]> {
  if (cache) return cache;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}checks-catalog.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as CheckSpec[];
    cache = Array.isArray(data) ? data : [];
  } catch {
    cache = []; // приватный каталог отсутствует — режим «только движок»
  }
  return cache;
}
