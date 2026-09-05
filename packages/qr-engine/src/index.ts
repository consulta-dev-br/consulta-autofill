import {
  prepareZXingModule,
  purgeZXingModule,
  readBarcodes,
  type ZXingModuleOverrides,
} from "zxing-wasm/reader";

let activeZXingEngines = 0;

/** Bytes extracted from a QR Code. Decoding the official document remains private. */
export type QrPayloadBytes = Uint8Array;

export interface QrEngine {
  prepare(): Promise<void>;
  scan(input: ImageData | Blob): Promise<QrPayloadBytes | null>;
  dispose(): void;
}

export interface ZXingWasmQrEngineOptions {
  /**
   * Version-pinned Reader WASM asset served by the direct scanner runtime or a partner
   * deployment. Keeping this explicit avoids an implicit third-party CDN
   * request at scan time.
   */
  wasmUrl?: string;
  /** Useful for deterministic Node tests; browser integrations should use wasmUrl. */
  wasmBinary?: ArrayBuffer;
}

type RgbaPixmap = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export interface ConsultaQrOnlyModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  readQrCodeFromPixmap(
    pointer: number,
    width: number,
    height: number,
  ): { format?: unknown; bytes?: unknown; error?: unknown };
}

export type ConsultaQrOnlyModuleFactory = (options: {
  locateFile: (path: string, prefix: string) => string;
}) => Promise<ConsultaQrOnlyModule>;

export interface ConsultaQrOnlyEngineOptions {
  /** URL of the versioned Emscripten ES module produced by the QR-only recipe. */
  moduleUrl?: string;
  /** URL of the versioned QR-only WASM binary on the same trusted origin. */
  wasmUrl: string;
  /** Dependency injection for deterministic tests; production uses moduleUrl. */
  moduleFactory?: ConsultaQrOnlyModuleFactory;
}

export interface FallbackQrEngineOptions {
  primary: QrEngine;
  fallback: QrEngine;
}

const MAX_QR_PIXELS = 4_194_304;

function isRgbaPixmap(value: unknown): value is RgbaPixmap {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<RgbaPixmap>;
  const { data, width, height } = image;
  if (
    !(data instanceof Uint8ClampedArray) ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    return false;
  }
  const pixelCount = width * height;
  return pixelCount <= MAX_QR_PIXELS && data.byteLength === pixelCount * 4;
}

function isModuleFactory(value: unknown): value is ConsultaQrOnlyModuleFactory {
  return typeof value === "function";
}

function assertConsultaQrOnlyModule(value: unknown): asserts value is ConsultaQrOnlyModule {
  if (!value || typeof value !== "object") throw new Error("O módulo QR-only não foi inicializado.");
  const module = value as Partial<ConsultaQrOnlyModule>;
  if (
    !(module.HEAPU8 instanceof Uint8Array) ||
    typeof module._malloc !== "function" ||
    typeof module._free !== "function" ||
    typeof module.readQrCodeFromPixmap !== "function"
  ) {
    throw new Error("O módulo QR-only não expõe a interface esperada.");
  }
}

async function pixmapFromBlob(blob: Blob): Promise<RgbaPixmap> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    throw new Error("Este navegador não consegue preparar a imagem para o leitor QR-only.");
  }
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, Math.sqrt(MAX_QR_PIXELS / (bitmap.width * bitmap.height)));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Não foi possível preparar a imagem para o leitor QR-only.");
    context.drawImage(bitmap, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } finally {
    canvas.width = 1;
    canvas.height = 1;
    bitmap.close();
  }
}

async function asRgbaPixmap(input: ImageData | Blob): Promise<RgbaPixmap> {
  if (isRgbaPixmap(input)) return input;
  if (input instanceof Blob) return pixmapFromBlob(input);
  throw new Error("A imagem fornecida ao leitor QR-only é inválida ou grande demais.");
}

/**
 * QR-only adapter over `zxing-wasm/reader`. It deliberately constrains the
 * reader to QRCode and returns raw bytes rather than text, since the bytes are
 * forwarded to the private Consulta decoder without interpretation here.
 */
export class ZXingWasmQrEngine implements QrEngine {
  private preparation: Promise<void> | null = null;
  private disposed = false;
  private readonly overrides: ZXingModuleOverrides;

  constructor({ wasmUrl, wasmBinary }: ZXingWasmQrEngineOptions) {
    if ((wasmUrl ? 1 : 0) + (wasmBinary ? 1 : 0) !== 1) {
      throw new Error("Informe exatamente um de wasmUrl ou wasmBinary para o leitor QR.");
    }
    if (wasmBinary) {
      this.overrides = { wasmBinary };
    } else {
      const resolved = new URL(wasmUrl as string, globalThis.location?.href).toString();
      this.overrides = {
        locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? resolved : `${prefix}${path}`),
      };
    }
    activeZXingEngines += 1;
  }

  async prepare(): Promise<void> {
    this.assertActive();
    if (!this.preparation) {
      const module = prepareZXingModule({
        overrides: this.overrides,
        fireImmediately: true,
      });
      this.preparation = module.then(() => undefined).catch((error: unknown) => {
        this.preparation = null;
        throw error;
      });
    }
    await this.preparation;
  }

  async scan(input: ImageData | Blob): Promise<QrPayloadBytes | null> {
    await this.prepare();
    const [result] = await readBarcodes(input, {
      formats: ["QRCode"],
      maxNumberOfSymbols: 1,
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
      tryDownscale: true,
    });
    return result?.bytes ? result.bytes.slice() : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.preparation = null;
    activeZXingEngines = Math.max(0, activeZXingEngines - 1);
    if (activeZXingEngines === 0) purgeZXingModule();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("O leitor QR já foi descartado.");
  }
}

/**
 * Adapter for the experimental QR-only ZXing-C++ artifact. It is intentionally
 * not enabled by default: callers must select a versioned module and WASM URL
 * after the artifact has passed its size, parity, memory and browser gates.
 */
export class ConsultaQrOnlyEngine implements QrEngine {
  private preparation: Promise<ConsultaQrOnlyModule> | null = null;
  private disposed = false;
  private readonly factoryLoader: () => Promise<ConsultaQrOnlyModuleFactory>;
  private readonly wasmUrl: string;

  constructor({ moduleUrl, wasmUrl, moduleFactory }: ConsultaQrOnlyEngineOptions) {
    if (!wasmUrl) throw new Error("Informe a URL do WASM QR-only.");
    if ((moduleUrl ? 1 : 0) + (moduleFactory ? 1 : 0) !== 1) {
      throw new Error("Informe exatamente um de moduleUrl ou moduleFactory para o leitor QR-only.");
    }
    this.wasmUrl = new URL(wasmUrl, globalThis.location?.href).toString();
    this.factoryLoader = moduleFactory ? async () => moduleFactory : async () => {
      const loaded: unknown = await import(/* @vite-ignore */ moduleUrl as string);
      const namespace = loaded as { default?: unknown; createConsultaQrReader?: unknown };
      const factory = namespace.default || namespace.createConsultaQrReader;
      if (!isModuleFactory(factory)) throw new Error("O módulo QR-only não exporta uma factory Emscripten.");
      return factory;
    };
  }

  async prepare(): Promise<void> {
    this.assertActive();
    if (!this.preparation) {
      this.preparation = this.factoryLoader().then((factory) => factory({
        locateFile: (path) => (path.endsWith(".wasm") ? this.wasmUrl : path),
      })).then((module) => {
        assertConsultaQrOnlyModule(module);
        return module;
      }).catch((error: unknown) => {
        this.preparation = null;
        throw error;
      });
    }
    await this.preparation;
  }

  async scan(input: ImageData | Blob): Promise<QrPayloadBytes | null> {
    await this.prepare();
    this.assertActive();
    const pixmap = await asRgbaPixmap(input);
    const module = await this.preparation;
    if (!module) throw new Error("O módulo QR-only não foi preparado.");
    const byteLength = pixmap.data.byteLength;
    const pointer = module._malloc(byteLength);
    if (!Number.isSafeInteger(pointer) || pointer < 1 || pointer + byteLength > module.HEAPU8.byteLength) {
      throw new Error("O leitor QR-only não conseguiu alocar memória suficiente.");
    }
    try {
      module.HEAPU8.set(pixmap.data, pointer);
      const result = module.readQrCodeFromPixmap(pointer, pixmap.width, pixmap.height);
      if (result?.format !== "QRCode" || !(result.bytes instanceof Uint8Array)) return null;
      return result.bytes.slice();
    } finally {
      // The input pixels can contain a document. Wipe their temporary module
      // allocation before returning it to the Emscripten allocator.
      module.HEAPU8.fill(0, pointer, pointer + byteLength);
      module._free(pointer);
    }
  }

  /**
   * Returns only the allocated WebAssembly heap capacity for diagnostics and
   * promotion tests. It never exposes memory contents or document bytes.
   */
  async memoryCapacityBytes(): Promise<number> {
    await this.prepare();
    const module = await this.preparation;
    if (!module) throw new Error("O módulo QR-only não foi preparado.");
    return module.HEAPU8.byteLength;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.preparation = null;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("O leitor QR-only já foi descartado.");
  }
}

/**
 * Starts with a candidate engine and fails closed to the known-good baseline
 * when that candidate cannot be prepared. Once a scan is under way, errors
 * are propagated rather than silently changing engines mid-document.
 */
export class FallbackQrEngine implements QrEngine {
  private selected: QrEngine | null = null;
  private preparation: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: FallbackQrEngineOptions) {}

  async prepare(): Promise<void> {
    this.assertActive();
    if (!this.preparation) {
      this.preparation = (async () => {
        try {
          await this.options.primary.prepare();
          this.selected = this.options.primary;
        } catch {
          this.options.primary.dispose();
          await this.options.fallback.prepare();
          this.selected = this.options.fallback;
        }
      })().catch((error: unknown) => {
        this.preparation = null;
        throw error;
      });
    }
    await this.preparation;
  }

  async scan(input: ImageData | Blob): Promise<QrPayloadBytes | null> {
    await this.prepare();
    if (!this.selected) throw new Error("Nenhum leitor QR está disponível.");
    return this.selected.scan(input);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.preparation = null;
    this.options.primary.dispose();
    this.options.fallback.dispose();
    this.selected = null;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("O leitor QR já foi descartado.");
  }
}

/**
 * The implementation is selected by the embed application. The interface is
 * intentionally public so partners can type their integration without access
 * to the VIO decoder.
 */
export const QR_ENGINE_INTERFACE_VERSION = 1;
