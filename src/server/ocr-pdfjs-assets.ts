import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// PDF.js loads its JBIG2/OpenJPEG decoders dynamically. Keep the maintained
// package's JS fallbacks beside the server bundle so scanned marks aren't lost.
export function pdfJsImageOptions(): { wasmUrl: string; useWasm: false; useSystemFonts: true } {
  const candidates = [
    new URL("./wasm/", import.meta.url),
    new URL("../wasm/", import.meta.url),
    new URL("../../node_modules/pdfjs-dist/wasm/", import.meta.url),
  ];
  const directory = candidates.find((candidate) =>
    existsSync(fileURLToPath(new URL("jbig2_nowasm_fallback.js", candidate))));
  if (!directory) throw new Error("pdfjs_image_decoder_unavailable");
  return { wasmUrl: directory.href, useWasm: false, useSystemFonts: true };
}
