import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceDirectory = resolve(import.meta.dirname, "..");
const releaseVersion = process.env.CONSULTA_RELEASE_VERSION;
const outputDirectory = resolve(process.env.CONSULTA_RELEASE_OUTPUT_DIR || resolve(workspaceDirectory, ".release-artifacts"));
const packageDirectory = resolve(outputDirectory, "packages");
const cdnDirectory = resolve(outputDirectory, "cdn");

const packages = [
  {
    name: "@consulta-dev/autofill",
    directory: resolve(workspaceDirectory, "packages", "autofill"),
    entry: "dist/index.js",
    cdnPath: "autofill",
    cdnFilename: "consulta-autofill.min.js",
  },
  {
    name: "@consulta-dev/qr-engine",
    directory: resolve(workspaceDirectory, "packages", "qr-engine"),
    entry: "dist/index.js",
    cdnPath: "qr-engine",
    cdnFilename: "consulta-qr-engine.min.js",
  },
];
const localPackageVersions = new Map(packages.map((definition) => [
  definition.name,
  readJson(resolve(definition.directory, "package.json")).version,
]));

if (!releaseVersion || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(releaseVersion)) {
  throw new Error("Defina CONSULTA_RELEASE_VERSION com uma versão semver, sem o prefixo v.");
}

if (existsSync(outputDirectory) && readdirSync(outputDirectory).length > 0) {
  throw new Error(`A saída de release já contém arquivos: ${outputDirectory}. Escolha um diretório vazio.`);
}

function digest(bytes, algorithm = "sha256") {
  return createHash(algorithm).update(bytes).digest("hex");
}

function integrity(bytes) {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isSemver(value) {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

function assertReleasePackageManifest(definition, manifest, source) {
  if (!manifest || manifest.name !== definition.name || !isSemver(manifest.version)) {
    throw new Error(`O package.json de ${definition.name} é inválido para publicação.`);
  }
  if (manifest.version !== releaseVersion) {
    throw new Error(`A versão de ${definition.name} (${manifest.version}) precisa corresponder à coleção ${releaseVersion}. Execute pnpm version-packages antes de criar a tag.`);
  }
  if (source.tag && manifest.version === "0.0.0") {
    throw new Error("A versão de desenvolvimento 0.0.0 não pode ser publicada a partir de uma tag.");
  }
}

function fileInfo(path) {
  const bytes = readFileSync(path);
  return { bytes: bytes.byteLength, sha256: digest(bytes), integrity: integrity(bytes) };
}

function relativePath(path) {
  const value = relative(outputDirectory, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`)) throw new Error("O artefato de release saiu do diretório de saída.");
  return value.split(sep).join("/");
}

function filesIn(directory) {
  const paths = [];
  for (const name of readdirSync(directory).sort()) {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) paths.push(...filesIn(path));
    else paths.push(path);
  }
  return paths;
}

/**
 * A browser-facing entry can import another emitted ES module. Publish every
 * JavaScript module from dist, preserving its relative path, so imports such
 * as `./protocol.js` resolve beside the canonical CDN entrypoint. The package
 * tarball remains the source of truth for every byte copied to the CDN.
 */
function browserModuleAssets(definition) {
  const distributionDirectory = resolve(definition.directory, "dist");
  const assets = filesIn(distributionDirectory)
    .filter((path) => /\.(?:m?js)$/.test(path))
    .map((path) => {
      const source = relative(definition.directory, path).split(sep).join("/");
      const relativeDistributionPath = relative(distributionDirectory, path).split(sep).join("/");
      if (
        !source.startsWith("dist/") ||
        !relativeDistributionPath ||
        relativeDistributionPath.startsWith("../") ||
        relativeDistributionPath.split("/").some((component) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(component))
      ) {
        throw new Error(`O módulo de browser de ${definition.name} tem um caminho de saída inválido.`);
      }
      return {
        source,
        filename: source === definition.entry ? definition.cdnFilename : relativeDistributionPath,
      };
    });

  if (!assets.some((asset) => asset.source === definition.entry)) {
    throw new Error(`A entrada de browser de ${definition.name} não foi gerada em dist.`);
  }
  return assets;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspaceDirectory, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`Falha ao executar ${command} para preparar a release.`);
  }
  return result;
}

function gitRevision(args, description) {
  const result = spawnSync("git", args, { cwd: workspaceDirectory, encoding: "utf8" });
  const value = result.stdout?.trim();
  if (result.error || result.status !== 0 || !value) {
    throw new Error(`Não foi possível determinar ${description} da release.`);
  }
  return value;
}

function assertCleanWorktree() {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: workspaceDirectory,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw new Error("Não foi possível verificar se a árvore da release está limpa.");
  }
  if (result.stdout.trim()) {
    throw new Error("Uma release marcada por tag exige uma árvore Git limpa.");
  }
}

function releaseSource() {
  const commit = gitRevision(["rev-parse", "HEAD"], "o commit de origem");
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error("O commit de origem da release é inválido.");

  const tag = process.env.CONSULTA_RELEASE_SOURCE_TAG?.trim() || null;
  if (!tag) return { tag: null, commit };
  assertCleanWorktree();
  if (tag !== `v${releaseVersion}`) {
    throw new Error("CONSULTA_RELEASE_SOURCE_TAG precisa corresponder à versão da coleção.");
  }
  const tagCommit = gitRevision(["rev-parse", "--verify", `${tag}^{commit}`], "a tag de origem");
  if (tagCommit !== commit) throw new Error("O checkout não corresponde à tag de origem da release.");
  return { tag, commit };
}

function packPackage(definition) {
  const before = new Set(readdirSync(packageDirectory));
  run("pnpm", ["--filter", definition.name, "pack", "--pack-destination", packageDirectory]);
  const archive = readdirSync(packageDirectory).find((name) => name.endsWith(".tgz") && !before.has(name));
  if (!archive) throw new Error(`O pacote ${definition.name} não produziu um tarball.`);
  return resolve(packageDirectory, archive);
}

function tarballFile(archive, source) {
  const result = spawnSync("tar", ["-xOf", archive, "--", `package/${source}`], { encoding: null });
  if (result.error || result.status !== 0 || !result.stdout) {
    throw new Error(`O tarball ${archive} não contém package/${source}.`);
  }
  return result.stdout;
}

function tarballPackageManifest(archive) {
  try {
    return JSON.parse(tarballFile(archive, "package.json").toString("utf8"));
  } catch {
    throw new Error(`O tarball ${archive} não contém um package.json válido.`);
  }
}

function packageComponent(name, manifest) {
  return {
    type: "library",
    name,
    version: manifest.version,
    purl: `pkg:npm/${name}@${manifest.version}`,
    licenses: [{ license: { id: manifest.license || "NOASSERTION" } }],
  };
}

function dependencyComponents(manifest) {
  return Object.entries(manifest.dependencies || {}).map(([name, version]) => {
    const resolvedVersion = typeof version === "string" && version.startsWith("workspace:")
      ? localPackageVersions.get(name) || version
      : version;
    const dependencyManifestPath = resolve(workspaceDirectory, "node_modules", name, "package.json");
    const dependencyManifest = existsSync(dependencyManifestPath) ? readJson(dependencyManifestPath) : {};
    return {
      type: "library",
      name,
      version: resolvedVersion,
      purl: `pkg:npm/${name}@${resolvedVersion}`,
      licenses: [{ license: { id: dependencyManifest.license || "NOASSERTION" } }],
    };
  });
}

mkdirSync(packageDirectory, { recursive: true, mode: 0o700 });
mkdirSync(cdnDirectory, { recursive: true, mode: 0o700 });
const source = releaseSource();

const packageRecords = [];
const cdnAssets = [];
const equivalences = [];
const components = [];

for (const definition of packages) {
  const manifest = readJson(resolve(definition.directory, "package.json"));
  assertReleasePackageManifest(definition, manifest, source);
  const archivePath = packPackage(definition);
  const packedManifest = tarballPackageManifest(archivePath);
  if (packedManifest.name !== manifest.name || packedManifest.version !== manifest.version) {
    throw new Error(`O tarball de ${definition.name} não preserva o nome e a versão aprovados.`);
  }

  for (const asset of browserModuleAssets(definition)) {
    const sourcePath = resolve(definition.directory, asset.source);
    const cdnPath = resolve(cdnDirectory, definition.cdnPath, `v${releaseVersion}`, asset.filename);
    mkdirSync(resolve(cdnPath, ".."), { recursive: true, mode: 0o700 });
    cpSync(sourcePath, cdnPath);

    const sourceBytes = readFileSync(sourcePath);
    const packed = tarballFile(archivePath, asset.source);
    if (!sourceBytes.equals(packed)) {
      throw new Error(`Os bytes publicados no CDN divergem de ${definition.name}/${asset.source} dentro do tarball.`);
    }

    const cdnInfo = fileInfo(cdnPath);
    cdnAssets.push({ path: relativePath(cdnPath), content_type: "application/javascript; charset=utf-8", ...cdnInfo });
    equivalences.push({ package: definition.name, tarball_path: relativePath(archivePath), tarball_member: `package/${asset.source}`, cdn_path: relativePath(cdnPath), sha256: cdnInfo.sha256 });
  }

  const archiveInfo = fileInfo(archivePath);
  packageRecords.push({ name: definition.name, version: manifest.version, path: relativePath(archivePath), ...archiveInfo });
  components.push(packageComponent(definition.name, manifest), ...dependencyComponents(manifest));
}

const embedDirectory = resolve(workspaceDirectory, "apps", "embed");
const embedManifest = readJson(resolve(embedDirectory, "package.json"));
const embedBuild = resolve(embedDirectory, "dist");
if (!existsSync(embedBuild)) throw new Error("Build ausente para apps/embed/dist. Execute pnpm build antes da release.");
const embedCdnDirectory = resolve(cdnDirectory, "embed", `v${releaseVersion}`);
cpSync(embedBuild, embedCdnDirectory, { recursive: true });
for (const path of filesIn(embedCdnDirectory)) {
  const extension = path.slice(path.lastIndexOf("."));
  const contentType = extension === ".js" || extension === ".mjs"
    ? "application/javascript; charset=utf-8"
    : extension === ".css"
      ? "text/css; charset=utf-8"
      : extension === ".html"
        ? "text/html; charset=utf-8"
      : extension === ".wasm"
        ? "application/wasm"
        : "application/octet-stream";
  cdnAssets.push({ path: relativePath(path), content_type: contentType, ...fileInfo(path) });
}
components.push(packageComponent("@consulta-dev/embed", { ...embedManifest, version: releaseVersion }), ...dependencyComponents(embedManifest));

const uniqueComponents = Array.from(new Map(components.map((component) => [component.purl, component])).values()).sort((left, right) => left.purl.localeCompare(right.purl));
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    component: {
      type: "application",
      name: "consulta-autofill-release",
      version: releaseVersion,
      licenses: [{ license: { id: "Apache-2.0" } }],
    },
  },
  components: uniqueComponents,
};

const releaseManifest = {
  schema_version: 2,
  release_version: releaseVersion,
  source,
  packages: packageRecords.sort((left, right) => left.name.localeCompare(right.name)),
  cdn_assets: cdnAssets.sort((left, right) => left.path.localeCompare(right.path)),
  equivalences,
  qr_only_candidate_included: false,
};

writeFileSync(resolve(outputDirectory, "release-manifest.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
writeFileSync(resolve(outputDirectory, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });

const checksums = filesIn(outputDirectory)
  .filter((path) => relativePath(path) !== "SHA256SUMS")
  .map((path) => `${digest(readFileSync(path))}  ${relativePath(path)}`)
  .sort()
  .join("\n");
writeFileSync(resolve(outputDirectory, "SHA256SUMS"), `${checksums}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });

console.log(JSON.stringify({
  success: true,
  release_version: releaseVersion,
  source,
  packages: packageRecords.length,
  cdn_assets: cdnAssets.length,
  qr_only_candidate_included: false,
}, null, 2));
