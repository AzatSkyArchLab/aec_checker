#!/usr/bin/env python3
"""Генерирует ПРИВАТНЫЙ каталог проверок ЦИМ АГР в public/checks-catalog.json
из xlsx-реестра. Файл gitignore'нится — в публичный репо не попадает, движок
грузит его в рантайме. Запуск: python3 scripts/gen-catalog.py [путь_к_xlsx]
"""
import json
import sys
from pathlib import Path

import openpyxl

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Downloads" / "Проверки IFC.xlsx"
OUT = Path(__file__).resolve().parent.parent / "public" / "checks-catalog.json"

# Проверки, не выполнимые из одного IFC-файла в браузере (нужны внешние артефакты
# или экспертная оценка) → помечаем как "manual".
MANUAL_CATEGORIES = {"Юридическая значимость", "Аннотации"}
MANUAL_IDS = {"IFC-05", "IFC-21", "IFC-85", "IFC-86", "IFC-87", "IFC-88"}

wb = openpyxl.load_workbook(SRC, data_only=True, read_only=True)
ws = wb.worksheets[0]
rows = list(ws.iter_rows(values_only=True))
header = [str(c).strip() if c else "" for c in rows[0]]


def col(name):
    return header.index(name)


idx = {
    "id": col("ID"),
    "category": col("Категория"),
    "name": col("Наименование проверки"),
    "source": col("Источник (НПА)"),
    "algorithm": col("Алгоритм проверки"),
    "priority": col("Приоритет"),
    "complexity": col("Сложность"),
    "automatable": col("Автоматизируемость"),
}


def s(v):
    return "" if v is None else str(v).strip()


specs = []
for row in rows[1:]:
    if not row or not row[idx["id"]]:
        continue
    cid = s(row[idx["id"]])
    cat = s(row[idx["category"]])
    mode = "manual" if (cat in MANUAL_CATEGORIES or cid in MANUAL_IDS) else "auto"
    specs.append({
        "id": cid,
        "category": cat,
        "name": s(row[idx["name"]]),
        "source": s(row[idx["source"]]),
        "algorithm": s(row[idx["algorithm"]]),
        "priority": s(row[idx["priority"]]) or "Med",
        "complexity": s(row[idx["complexity"]]) or "Med",
        "automatable": s(row[idx["automatable"]]) or "Да",
        "mode": mode,
    })

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(specs, ensure_ascii=False, indent=0), encoding="utf-8")
print(f"checks-catalog.json: {len(specs)} проверок → {OUT}")
