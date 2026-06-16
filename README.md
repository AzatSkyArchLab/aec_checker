# AGR Checker — модульный IFC-парсер

Веб-приложение для разбора IFC-моделей: загрузите файл `.ifc` — увидите список
всех элементов, полную карту атрибутов и property sets выбранного объекта, плюс
интерактивное 3D-превью модели.

Работает полностью в браузере (парсинг через WASM), без бэкенда.

## Возможности

- 📂 Загрузка `.ifc` через кнопку или drag&drop
- 🌲 Список элементов, сгруппированный по типу IFC, с поиском
- 🔍 Все атрибуты выбранного элемента + property sets и quantity sets
- 🧊 3D-просмотр геометрии (three.js), выбор элемента кликом в сцене
- ↔️ Двусторонняя связь: выбор в списке подсвечивает объект в 3D и наоборот

## Архитектура (модульная)

```
src/
├─ core/              ← ядро: чтение IFC, без UI и three.js
│  ├─ types.ts        ← доменные типы (контракт между слоями)
│  └─ ifc-parser.ts   ← обёртка над web-ifc: элементы, свойства, геометрия
├─ viewer/
│  └─ viewer.ts       ← three.js-сцена, рендер геометрии, выбор кликом
├─ ui/
│  ├─ element-list.ts ← левая панель (дерево элементов + поиск)
│  └─ properties-panel.ts ← правая панель (атрибуты + Pset)
└─ main.ts            ← склейка: file → parser → {viewer, list, panel}
```

Ядро (`core/`) ничего не знает про DOM и three.js — его можно переиспользовать
в другом интерфейсе или на сервере.

## Запуск

```bash
npm install     # ставит зависимости и копирует WASM в public/
npm run dev     # http://localhost:5173
```

## Сборка

```bash
npm run build   # типизация + сборка в dist/
npm run preview # локальный просмотр сборки
```

## Деплой на GitHub Pages

`base: "./"` в `vite.config.ts` делает сборку переносимой (корень или подпапка).
Воркфлоу `.github/workflows/deploy.yml` собирает и публикует `dist/` на Pages при
push в `main`. Включите Pages в настройках репозитория: Settings → Pages →
Source → **GitHub Actions**.

## Стек

- [web-ifc](https://github.com/ThatOpen/engine_web-ifc) — WASM-парсер IFC
- [three.js](https://threejs.org/) — 3D-рендер
- [Vite](https://vitejs.dev/) + TypeScript
