import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

/** Точка границы участка в МСК-77 (как в выписке/ГПЗУ: X=север, Y=восток). */
export interface GpzuPoint {
  X: number; // север
  Y: number; // восток
}
export interface GpzuParcel {
  rings: GpzuPoint[][];
  cadNumber?: string;
  area?: string;
  address?: string;
}

/**
 * Парсит ГПЗУ (PDF): извлекает «Перечень координат характерных точек» в МСК-77.
 * Формат строки таблицы: «<№> <X,дроб> <Y,дроб>» (десятичная запятая, X=север Y=восток).
 * Кольца разбиваются по сбросу номера точки на 1 (граница участка + зоны размещения).
 */
export async function parseGpzu(file: File): Promise<GpzuParcel> {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
  }

  const cadNumber = text.match(/\b(\d{2}:\d{2}:\d{6,7}:\d{1,6})\b/)?.[1];
  const area = text
    .match(/Площадь[^0-9]*([0-9][0-9\s]*(?:[.,]\d+)?)\s*(?:±[\s0-9]*)?\s*кв\.?\s*м/i)?.[1]
    ?.replace(/\s+/g, "");
  const address = text.match(/Местонахождение[^:]*:?\s*([^\n]{5,120})/i)?.[1]?.trim();

  // Триплеты: номер точки (1–3 цифры) + X + Y (3–6 целых цифр, десятичная , или .).
  const re = /(?:^|\s)(\d{1,3})\s+(-?\d{3,6}[.,]\d+)\s+(-?\d{3,6}[.,]\d+)(?=\s|$)/g;
  const triples: { n: number; X: number; Y: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    triples.push({
      n: Number(m[1]),
      X: parseFloat(m[2].replace(",", ".")),
      Y: parseFloat(m[3].replace(",", ".")),
    });
  }

  // Разбивка на кольца: новое кольцо при возврате номера к 1.
  const rings: GpzuPoint[][] = [];
  let cur: GpzuPoint[] = [];
  for (const t of triples) {
    if (t.n === 1 && cur.length > 0) {
      rings.push(cur);
      cur = [];
    }
    cur.push({ X: t.X, Y: t.Y });
  }
  if (cur.length) rings.push(cur);

  // Оставляем только осмысленные кольца (≥3 точки).
  return { rings: rings.filter((r) => r.length >= 3), cadNumber, area, address };
}
