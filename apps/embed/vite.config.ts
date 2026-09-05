import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // The hosted shell lives below an immutable version path such as
  // /embed/v1.2.3/. Relative URLs keep every emitted Worker, PDF worker and
  // stylesheet inside that release instead of resolving at the CDN origin.
  base: "./",
  build: {
    emptyOutDir: true,
    // Development-only benchmark pages must never be emitted by the hosted
    // embed build. The QR benchmark starts its own ephemeral Vite server.
    rollupOptions: {
      // The direct scanner is imported as an ES module by the public Web
      // Component, so its named export must survive Rollup's entry analysis.
      preserveEntrySignatures: "strict",
      input: {
        embed: resolve(import.meta.dirname, "index.html"),
        "direct-scanner": resolve(import.meta.dirname, "src/direct-entry.ts"),
      },
      output: {
        // The release shell references these two entry assets directly. Their
        // enclosing version directory is immutable, so stable names do not
        // weaken cache safety and avoid a second runtime manifest lookup.
        entryFileNames: (chunk) => chunk.name === "direct-scanner"
          ? "assets/consulta-direct-scanner.js"
          : "assets/consulta-embed.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (asset) => asset.name?.endsWith(".css")
          ? "assets/consulta-embed.css"
          : "assets/[name]-[hash][extname]",
      },
    },
  },
});
