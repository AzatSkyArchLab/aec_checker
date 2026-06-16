import { defineConfig } from "vite";

// Относительный base ('./') делает сборку переносимой:
// работает и на корне домена, и на GitHub Pages в подпапке (/agr_checker/).
// WASM-файлы лежат в public/ и резолвятся через import.meta.env.BASE_URL.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000, // web-ifc + three — крупные чанки, это ок
  },
  // web-ifc подтягивает .wasm как ассет — исключаем из dep-оптимизации
  optimizeDeps: {
    exclude: ["web-ifc"],
  },
});
