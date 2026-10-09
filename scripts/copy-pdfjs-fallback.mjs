import { copyFile, mkdir } from "node:fs/promises";

const source = new URL("../node_modules/pdfjs-dist/wasm/", import.meta.url);
const target = new URL("../.output/server/wasm/", import.meta.url);
await mkdir(target, { recursive: true });
for (const name of ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js"]) {
  await copyFile(new URL(name, source), new URL(name, target));
}
