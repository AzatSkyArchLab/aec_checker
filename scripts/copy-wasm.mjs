// Копирует WASM-бинарники web-ifc в public/, чтобы Vite отдавал их как статику.
// Запускается автоматически в postinstall / predev / prebuild.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "web-ifc");
const dest = join(root, "public");

// Single-threaded бинарник достаточно для просмотрщика и не требует COOP/COEP-заголовков.
const files = ["web-ifc.wasm"];

mkdirSync(dest, { recursive: true });

let copied = 0;
for (const f of files) {
  const from = join(src, f);
  if (!existsSync(from)) {
    console.warn(`[copy-wasm] не найден ${from} — пропуск`);
    continue;
  }
  copyFileSync(from, join(dest, f));
  copied++;
}
console.log(`[copy-wasm] скопировано файлов: ${copied} → public/`);
