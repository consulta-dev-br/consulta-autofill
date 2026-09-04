import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const embedDirectory = resolve(import.meta.dirname, "..");
const distributionDirectory = resolve(embedDirectory, "dist");
const indexPath = resolve(distributionDirectory, "index.html");
const scriptPath = resolve(distributionDirectory, "assets", "consulta-embed.js");
const stylesheetPath = resolve(distributionDirectory, "assets", "consulta-embed.css");
const wasmPath = resolve(distributionDirectory, "zxing_reader.wasm");

for (const path of [indexPath, scriptPath, stylesheetPath, wasmPath]) {
  if (!existsSync(path)) throw new Error(`Build versionado do embed não contém ${path}.`);
}

const index = readFileSync(indexPath, "utf8");
if (!index.includes('src="./assets/consulta-embed.js"') || !index.includes('href="./assets/consulta-embed.css"')) {
  throw new Error("O HTML do embed não referencia os entry assets relativos esperados.");
}
if (/\b(?:src|href)="\/(?!\/)/.test(index)) {
  throw new Error("O HTML do embed contém um asset absoluto e não pode ser hospedado sob um path versionado.");
}

const assetScripts = readdirSync(resolve(distributionDirectory, "assets"))
  .filter((entry) => entry.endsWith(".js"))
  .map((entry) => readFileSync(resolve(distributionDirectory, "assets", entry), "utf8"));
if (!assetScripts.some((source) => source.includes("../zxing_reader.wasm")) || assetScripts.some((source) => /new URL\([^)]*window\.location\.origin/.test(source))) {
  throw new Error("O bundle do embed não resolve o baseline WASM em relação ao módulo versionado.");
}
if (assetScripts.some((source) => /new URL\(`?\/assets\//.test(source))) {
  throw new Error("O bundle do embed contém um Worker ou asset absoluto fora do path versionado.");
}

console.log(JSON.stringify({
  success: true,
  entry: "assets/consulta-embed.js",
  stylesheet: "assets/consulta-embed.css",
  wasm: "zxing_reader.wasm",
}, null, 2));
