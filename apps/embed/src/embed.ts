import {
  AUTOFILL_MAX_PHOTO_BYTES,
  AUTOFILL_PROTOCOL_VERSION,
  isAutofillDecodeData,
  isAutofillFrameMessage,
  type AutofillDecodedDocument,
  type AutofillEmbedMetricEvent,
  type AutofillFrameMessage,
} from "@consulta-dev/autofill/protocol";
import "./embed.css";
import type { EmbedQrScanner } from "./qr-scanner.js";
import type * as PdfJs from "pdfjs-dist/build/pdf.mjs";
import { MAX_QR_PIXELS } from "./qr-worker-protocol.js";

const PROJECT_ID_PATTERN = /^pub_[A-Za-z0-9_-]{8,128}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 3;
const MAX_RENDER_EDGE = 2_048;
// The entry bundle is emitted below assets/, while the baseline WASM is at
// the root of the immutable embed release. Resolve against the module URL so
// this works both below /embed/v<version>/ on the CDN and in Vite dev mode.
const readerWasmUrl = new URL(/* @vite-ignore */ "../zxing_reader.wasm", import.meta.url).toString();
const qrOnlyModuleUrl = import.meta.env.VITE_CONSULTA_QR_ONLY_MODULE_URL?.trim();
const qrOnlyWasmUrl = import.meta.env.VITE_CONSULTA_QR_ONLY_WASM_URL?.trim();

type EmbedQuery = { projectId: string; nonce: string; parentOrigin: string };
type BootstrapConfig = {
  projectId: string;
  sessionId: string;
  expiresAt: string;
  photoEnabled: boolean;
  branding: BootstrapBranding;
  presentation: BootstrapPresentation;
};
type BootstrapBranding = {
  mode: "consulta" | "partner";
  name: string;
  accentColor: string;
  showPoweredBy: boolean;
};
type BootstrapPresentation = { layout: "compact" | "standard" };
type PdfJsModule = typeof PdfJs;
type DecodedResult = {
  document: AutofillDecodedDocument;
  fields: Record<string, string>;
  photoUrl: string | null;
};
type SessionPayload = { sessionToken: string; bootstrapUrl: string; parentOrigin: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function exactOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && isLocalHost(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function queryFromLocation(): EmbedQuery | null {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("project_id") || "";
  const nonce = params.get("nonce") || "";
  const parentOrigin = exactOrigin(params.get("parent_origin") || "");
  return PROJECT_ID_PATTERN.test(projectId) && NONCE_PATTERN.test(nonce) && parentOrigin
    ? { projectId, nonce, parentOrigin }
    : null;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function messageText(value: unknown, fallback: string): string {
  return isRecord(value) && isRecord(value.error) && typeof value.error.message === "string" ? value.error.message : fallback;
}

function consultaBranding(): BootstrapBranding {
  return {
    mode: "consulta",
    name: "Consulta Autofill",
    accentColor: "#155EEF",
    showPoweredBy: true,
  };
}

function bootstrapBranding(value: unknown): BootstrapBranding {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim().length < 1 || value.name.trim().length > 60) {
    return consultaBranding();
  }
  if (typeof value.accent_color !== "string" || !/^#[0-9A-F]{6}$/i.test(value.accent_color) || typeof value.show_powered_by !== "boolean") {
    return consultaBranding();
  }
  const name = value.name.trim();
  const accentColor = value.accent_color.toUpperCase();
  if (value.mode === "partner" && value.show_powered_by === false) {
    return { mode: "partner", name, accentColor, showPoweredBy: false };
  }
  if (value.mode === "consulta" && value.show_powered_by === true && name === "Consulta Autofill" && accentColor === "#155EEF") {
    return consultaBranding();
  }
  return consultaBranding();
}

function bootstrapPresentation(value: unknown): BootstrapPresentation {
  return isRecord(value) && value.layout === "standard" ? { layout: "standard" } : { layout: "compact" };
}

function accentForeground(accentColor: string): string {
  const red = Number.parseInt(accentColor.slice(1, 3), 16);
  const green = Number.parseInt(accentColor.slice(3, 5), 16);
  const blue = Number.parseInt(accentColor.slice(5, 7), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1_000;
  return luminance > 160 ? "#101828" : "#FFFFFF";
}

function sessionPayload(value: unknown, query: EmbedQuery): SessionPayload | null {
  if (!isRecord(value)) return null;
  const token = value.session_token;
  const url = value.bootstrap_url;
  if (
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 4_096 ||
    typeof url !== "string" ||
    value.parent_origin !== query.parentOrigin
  ) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const local = parsed.protocol === "http:" && isLocalHost(parsed.hostname);
    if ((parsed.protocol !== "https:" && !local) || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  return { sessionToken: token, bootstrapUrl: url, parentOrigin: query.parentOrigin };
}

function bootstrapConfig(value: unknown, query: EmbedQuery, sessionId: string): BootstrapConfig | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  const data = value.data;
  if (
    data.protocol_version !== AUTOFILL_PROTOCOL_VERSION ||
    data.project_id !== query.projectId ||
    data.session_id !== sessionId ||
    typeof data.expires_at !== "string" ||
    typeof data.photo_enabled !== "boolean" ||
    !Array.isArray(data.allowed_document_types)
  ) {
    return null;
  }
  const validTypes = data.allowed_document_types.every((type) => type === "cnh-e" || type === "crlv-e");
  if (!validTypes || !data.allowed_document_types.length || Date.parse(data.expires_at) <= Date.now()) return null;
  return {
    projectId: query.projectId,
    sessionId,
    expiresAt: data.expires_at,
    photoEnabled: data.photo_enabled,
    branding: bootstrapBranding(data.branding),
    presentation: bootstrapPresentation(data.presentation),
  };
}

function decodeResult(value: unknown): DecodedResult | null {
  if (!isAutofillDecodeData(value)) return null;
  const fields = { ...value.fields };
  let photoUrl: string | null = null;
  if (value.photo) {
    const bytes = fromBase64(value.photo.base64);
    if (bytes && bytes.byteLength <= AUTOFILL_MAX_PHOTO_BYTES) {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      photoUrl = URL.createObjectURL(new Blob([copy.buffer], { type: value.photo.mime_type }));
      bytes.fill(0);
    }
  }
  return { document: { type: value.document.type, label: value.document.label }, fields, photoUrl };
}

function fieldLabel(key: string): string {
  const labels: Record<string, string> = {
    full_name: "Nome completo",
    cpf: "CPF",
    birth_date: "Data de nascimento",
    mother_name: "Nome da mãe",
    cnh_number: "Número da CNH",
    category: "Categoria",
    validity_date: "Validade",
    license_plate: "Placa",
    renavam: "RENAVAM",
    vehicle_brand: "Marca/modelo",
    vehicle_year: "Ano do veículo",
  };
  return labels[key] || key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

class EmbedController {
  private readonly panel: HTMLElement;
  private readonly status: HTMLElement;
  private engine: EmbedQrScanner | null = null;
  private enginePromise: Promise<EmbedQrScanner> | null = null;
  private pdfPromise: Promise<PdfJsModule> | null = null;
  private port: MessagePort | null = null;
  private sessionId: string | null = null;
  private config: BootstrapConfig | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: number | null = null;
  private looping = false;
  private scanning = false;
  private payload: Uint8Array | null = null;
  private result: DecodedResult | null = null;
  private disposed = false;
  private readyAttempts = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly query: EmbedQuery,
  ) {
    root.innerHTML = `
      <section class="shell"><header><div class="brand"><span class="mark">✓</span><span class="brand-name">Consulta Autofill</span></div><button type="button" class="close" aria-label="Fechar">×</button></header><main class="embed-body"><section class="panel" aria-live="polite"></section></main><p class="powered">Powered by consulta.dev.br</p><p class="status" role="status" aria-live="polite"></p></section>`;
    const panel = root.querySelector<HTMLElement>(".panel");
    const status = root.querySelector<HTMLElement>(".status");
    if (!panel || !status) throw new Error("Não foi possível inicializar o Autofill.");
    this.panel = panel;
    this.status = status;
    root.querySelector<HTMLButtonElement>(".close")?.addEventListener("click", () => this.cancel());
  }

  init(): void {
    window.addEventListener("message", this.receiveWindowMessage);
    this.loading("Conectando ao Autofill", "Aguardando a sessão segura do seu cadastro…");
    this.announceReady();
  }

  private announceReady(): void {
    if (this.disposed || this.port || this.readyAttempts >= 3) return;
    this.readyAttempts += 1;
    window.parent.postMessage({ protocol: "consulta-autofill", version: 1, type: "embed.ready", project_id: this.query.projectId, nonce: this.query.nonce }, this.query.parentOrigin);
    window.setTimeout(() => this.announceReady(), 600);
  }

  private readonly receiveWindowMessage = (event: MessageEvent<unknown>): void => {
    if (this.port || event.origin !== this.query.parentOrigin || event.source !== window.parent || event.ports.length !== 1) return;
    if (!isAutofillFrameMessage(event.data) || event.data.type !== "parent.session") return;
    if (event.data.project_id !== this.query.projectId || event.data.nonce !== this.query.nonce) return;
    const payload = sessionPayload(event.data.payload, this.query);
    if (!payload) {
      this.error("A sessão recebida não é válida. Feche e tente novamente.");
      return;
    }
    this.sessionId = event.data.session_id;
    this.port = event.ports[0];
    this.port.onmessage = this.receivePortMessage;
    this.port.start();
    window.removeEventListener("message", this.receiveWindowMessage);
    void this.bootstrap(payload);
  };

  private async bootstrap(payload: SessionPayload): Promise<void> {
    try {
      this.setStatus("Validando sessão segura…");
      const response = await fetch(payload.bootstrapUrl, {
        method: "POST", mode: "cors", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_token: payload.sessionToken, parent_origin: payload.parentOrigin }),
      });
      const body: unknown = await response.json().catch(() => null);
      const config = this.sessionId ? bootstrapConfig(body, this.query, this.sessionId) : null;
      if (!response.ok || !config) throw new Error(messageText(body, "Não foi possível validar esta sessão Autofill."));
      this.config = config;
      this.applyBranding(config.branding);
      this.setStatus("Pronto para ler seu documento.");
      this.options();
    } catch (cause) {
      this.error(cause instanceof Error ? cause.message : "Não foi possível validar esta sessão Autofill.");
    }
  }

  private readonly receivePortMessage = (event: MessageEvent<unknown>): void => {
    if (!this.config || !isAutofillFrameMessage(event.data)) return;
    const message = event.data;
    if (message.project_id !== this.config.projectId || message.session_id !== this.config.sessionId || message.nonce !== this.query.nonce) return;
    if (message.type === "parent.error") {
      this.error(messageText(message.payload, "Não foi possível decodificar o documento."));
      return;
    }
    if (message.type === "parent.close") return this.shutdown();
    if (message.type !== "parent.result") return;
    const result = decodeResult(message.payload);
    if (!result) return this.error("A resposta recebida não segue o contrato do Autofill.");
    this.result = result;
    this.clearPayload();
    this.setStatus("Confira os dados antes de preencher o formulário.");
    this.review();
  };

  private options(): void {
    if (!this.config || this.disposed) return;
    this.stopCamera();
    this.clearResult();
    this.clearPayload();
    const compact = this.config.presentation.layout === "compact";
    const card = this.card(
      "Como prefere ler o documento?",
      compact
        ? "Escolha uma opção para encontrar o QR Code."
        : "O QR Code é lido neste dispositivo. Seus dados só seguem para validação após sua confirmação.",
    );
    const actions = document.createElement("div"); actions.className = compact ? "actions actions-compact" : "actions";
    actions.append(
      this.option("◉", "Usar câmera", "Aponte a câmera para o QR Code do documento.", () => void this.startCamera(), compact),
      this.option("▧", "Enviar imagem", "JPG, PNG ou WebP com o QR Code visível.", () => this.filePicker("image/*"), compact),
      this.option("▤", "Enviar PDF", "Lemos até as três primeiras páginas do documento.", () => this.filePicker("application/pdf"), compact),
    );
    const notice = document.createElement("div"); notice.className = "notice";
    notice.textContent = compact
      ? "🔒 A câmera só é ativada após seu toque. Nada é enviado para analytics."
      : "🔒 A câmera só é ativada após seu toque. O componente não envia imagens, QR Codes ou dados para analytics.";
    card.append(actions, notice); this.panel.replaceChildren(card);
  }

  private async startCamera(): Promise<void> {
    if (!this.config || !navigator.mediaDevices?.getUserMedia) return this.error("A câmera não está disponível neste navegador.");
    this.stopCamera();
    const card = this.card("Posicione o QR Code", "Mantenha o documento iluminado e enquadre o QR dentro da área marcada.");
    const camera = document.createElement("div"); camera.className = "camera";
    const video = document.createElement("video"); video.autoplay = true; video.muted = true; video.playsInline = true;
    const guide = document.createElement("div"); guide.className = "guide"; guide.setAttribute("aria-hidden", "true"); camera.append(video, guide);
    const actions = document.createElement("div"); actions.className = "actions";
    actions.append(this.button("Voltar", "secondary", () => this.options()));
    card.append(camera, actions); this.panel.replaceChildren(card); this.video = video;
    this.setStatus("Solicitando acesso à câmera…");
    this.metric("camera_requested");
    // Start the scanner before the permission prompt resolves. ZXing/WASM can
    // initialize while the person decides, so the first camera frame is ready
    // to scan as soon as permission is granted. This uses no camera pixels.
    const scannerReady = this.prepareScanner();
    // Observe a late Worker error if permission is denied before preparation
    // completes. The awaited path below still receives the original failure.
    void scannerReady.catch(() => {});
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (this.disposed || !this.video) return stream.getTracks().forEach((track) => track.stop());
      this.stream = stream; this.video.srcObject = stream; await this.video.play();
      await scannerReady;
      if (this.disposed || this.video !== video || this.stream !== stream) return stream.getTracks().forEach((track) => track.stop());
      this.looping = true; this.metric("camera_granted");
      this.setStatus("Procurando o QR Code…"); this.schedule(250);
    } catch (cause) {
      if (stream && this.stream !== stream) stream.getTracks().forEach((track) => track.stop());
      const denied = cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError");
      if (denied) this.metric("camera_denied");
      this.error(denied ? "A câmera foi bloqueada. Você pode enviar uma imagem ou PDF." : "Não foi possível iniciar a câmera ou preparar o leitor QR.");
    }
  }

  private schedule(delay: number): void {
    if (!this.looping || this.disposed) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; void this.scanCamera(); }, delay);
  }

  private async scanCamera(): Promise<void> {
    if (!this.video || !this.looping || this.scanning) return;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !this.video.videoWidth || !this.video.videoHeight) return this.schedule(250);
    this.scanning = true;
    try {
      const payload = await this.scanImage(this.videoImage());
      if (payload) { this.payload = payload; this.stopCamera(); this.metric("qr_found"); this.setStatus("QR Code encontrado."); return this.confirmPayload(); }
    } catch {
      // The scheduled loop keeps trying the next camera frame.
    } finally {
      this.scanning = false;
      if (this.looping && !this.payload) this.schedule(450);
    }
  }

  private videoImage(): ImageData {
    if (!this.video) throw new Error("A câmera não está ativa.");
    const scale = Math.min(1, 1_280 / Math.max(this.video.videoWidth, this.video.videoHeight));
    const width = Math.max(1, Math.round(this.video.videoWidth * scale)); const height = Math.max(1, Math.round(this.video.videoHeight * scale));
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("Não foi possível preparar a imagem da câmera.");
    context.drawImage(this.video, 0, 0, width, height); const image = context.getImageData(0, 0, width, height); canvas.width = 1; canvas.height = 1; return image;
  }

  /** Lazily imports the QR reader so opening the source selector stays small. */
  private async scanner(): Promise<EmbedQrScanner> {
    if (this.engine) return this.engine;
    if (!this.enginePromise) {
      this.enginePromise = import("./qr-scanner.js")
        .then(({ EmbedQrScanner }) => {
          const scanner = new EmbedQrScanner({
            baselineWasmUrl: readerWasmUrl,
            ...(qrOnlyModuleUrl && qrOnlyWasmUrl ? { qrOnlyModuleUrl, qrOnlyWasmUrl } : {}),
          });
          if (this.disposed) {
            scanner.dispose();
            throw new Error("O leitor QR foi descartado.");
          }
          this.engine = scanner;
          return scanner;
        })
        .catch((cause) => {
          this.enginePromise = null;
          throw cause;
        });
    }
    return this.enginePromise;
  }

  private async prepareScanner(): Promise<EmbedQrScanner> {
    const scanner = await this.scanner();
    try {
      await scanner.prepare();
      return scanner;
    } catch (cause) {
      if (this.engine === scanner) {
        scanner.dispose();
        this.engine = null;
        this.enginePromise = null;
      }
      throw cause;
    }
  }

  /** Loads PDF.js only when someone selects a PDF instead of adding it to boot. */
  private async pdfjs(): Promise<PdfJsModule> {
    if (!this.pdfPromise) {
      this.pdfPromise = Promise.all([
        import("pdfjs-dist/build/pdf.mjs"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ])
        .then(([pdfjs, worker]) => {
          pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
          return pdfjs;
        })
        .catch((cause) => {
          this.pdfPromise = null;
          throw cause;
        });
    }
    return this.pdfPromise;
  }

  private async scanImage(image: ImageData): Promise<Uint8Array | null> {
    try {
      const scanner = await this.prepareScanner();
      return await scanner.scan(image);
    } finally {
      // The Worker owns the transferred buffer after postMessage; in the
      // compatibility path this clears the main-thread copy instead.
      if (image.data.byteLength) image.data.fill(0);
    }
  }

  private imageDataFromDrawable(source: CanvasImageSource, naturalWidth: number, naturalHeight: number): ImageData {
    if (!Number.isSafeInteger(naturalWidth) || !Number.isSafeInteger(naturalHeight) || naturalWidth < 1 || naturalHeight < 1) {
      throw new Error("Não foi possível preparar a imagem para o leitor QR.");
    }
    const scale = Math.min(1, Math.sqrt(MAX_QR_PIXELS / (naturalWidth * naturalHeight)));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    try {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Não foi possível preparar a imagem para o leitor QR.");
      context.drawImage(source, 0, 0, width, height);
      return context.getImageData(0, 0, width, height);
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  private async imageDataFromFile(file: Blob): Promise<ImageData> {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file);
        try {
          return this.imageDataFromDrawable(bitmap, bitmap.width, bitmap.height);
        } finally {
          bitmap.close();
        }
      } catch {
        // Fall through to Image for browsers that expose createImageBitmap but
        // cannot decode this image format through it.
      }
    }
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Não foi possível abrir esta imagem."));
        image.src = objectUrl;
      });
      return this.imageDataFromDrawable(image, image.naturalWidth, image.naturalHeight);
    } finally {
      image.onload = null;
      image.onerror = null;
      image.src = "";
      URL.revokeObjectURL(objectUrl);
    }
  }

  private filePicker(accept: string): void {
    const input = document.createElement("input"); input.type = "file"; input.accept = accept; input.className = "hidden";
    input.addEventListener("change", () => { const file = input.files?.[0]; input.remove(); if (file) void this.scanFile(file); });
    this.root.append(input); input.click();
  }

  private async scanFile(file: File): Promise<void> {
    if (!file.size || file.size > MAX_UPLOAD_BYTES) return this.error("Escolha um arquivo de até 10 MB.");
    const pdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!pdf && !file.type.startsWith("image/")) return this.error("Envie uma imagem (JPG, PNG ou WebP) ou um PDF.");
    this.stopCamera(); this.loading("Lendo o documento", pdf ? "Procurando o QR nas páginas iniciais do PDF…" : "Procurando o QR na imagem…");
    try {
      const payload = pdf ? await this.scanPdf(file) : await this.scanImage(await this.imageDataFromFile(file));
      if (!payload) throw new Error("Não encontramos um QR Code neste arquivo.");
      this.payload = payload; this.metric("qr_found"); this.setStatus("QR Code encontrado."); this.confirmPayload();
    } catch (cause) {
      this.error(cause instanceof Error ? cause.message : "Não foi possível ler este arquivo.");
    }
  }

  private async scanPdf(file: File): Promise<Uint8Array | null> {
    this.setStatus("Preparando o leitor de PDF…");
    const { AnnotationMode, getDocument } = await this.pdfjs();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const task = getDocument({ data: bytes, stopAtErrors: true, disableFontFace: true, enableXfa: false, maxImageSize: MAX_RENDER_EDGE * MAX_RENDER_EDGE });
    try {
      const pdf = await task.promise;
      const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);
      for (let number = 1; number <= pages; number += 1) {
        this.setStatus(`Lendo a página ${number} de ${pages}…`);
        const page = await pdf.getPage(number);
        try {
          const natural = page.getViewport({ scale: 1 }); const scale = Math.max(.2, Math.min(2, MAX_RENDER_EDGE / Math.max(natural.width, natural.height)));
          const viewport = page.getViewport({ scale }); const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
          const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("Não foi possível renderizar o PDF.");
          await page.render({ canvas, viewport, annotationMode: AnnotationMode.DISABLE }).promise;
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          let result: Uint8Array | null;
          try {
            result = await this.scanImage(image);
          } finally {
            canvas.width = 1;
            canvas.height = 1;
          }
          if (result) return result;
        } finally { page.cleanup(); }
      }
      return null;
    } finally {
      await task.destroy(); bytes.fill(0);
    }
  }

  private confirmPayload(): void {
    if (!this.payload || !this.config) return;
    const card = this.card("QR Code encontrado", "Antes de buscar os dados, confirme o que deseja incluir na leitura.");
    const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = "✓ QR Code pronto para leitura"; card.append(badge);
    let includePhoto = false;
    if (this.config.photoEnabled) {
      const label = document.createElement("label"); label.className = "check"; const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.addEventListener("change", () => { includePhoto = checkbox.checked; });
      const text = document.createElement("span"); text.textContent = "Incluir a foto retornada pelo documento nesta revisão. Esta opção é opcional e fica desmarcada por padrão."; label.append(checkbox, text); card.append(label);
    }
    const actions = document.createElement("div"); actions.className = "actions";
    actions.append(this.button("Buscar dados do documento", "primary", () => this.requestDecode(includePhoto)), this.button("Ler outro documento", "secondary", () => this.options()));
    card.append(actions); this.panel.replaceChildren(card);
  }

  private requestDecode(includePhoto: boolean): void {
    if (!this.payload || !this.config) return;
    if (Date.parse(this.config.expiresAt) <= Date.now()) return this.error("A sessão expirou. Feche e abra o Autofill novamente.");
    this.loading("Buscando os dados", "O serviço está validando o documento. Isso pode levar alguns segundos…"); this.setStatus("Decodificando documento…");
    this.post("embed.payload", { payload_base64: base64(this.payload), include_photo: includePhoto });
  }

  private review(): void {
    if (!this.result) return;
    const card = this.card("Confira antes de preencher", "Você pode editar os campos abaixo. Os valores existentes no formulário parceiro serão preservados por padrão.");
    const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = `✓ ${this.result.document.label} reconhecida`; card.append(badge);
    if (this.result.photoUrl) { const photo = document.createElement("img"); photo.className = "photo"; photo.src = this.result.photoUrl; photo.alt = "Foto retornada pelo documento"; card.append(photo); }
    const inputs = new Map<string, HTMLInputElement>();
    for (const [key, value] of Object.entries(this.result.fields)) {
      const field = document.createElement("div"); field.className = "field"; const label = document.createElement("label"); const input = document.createElement("input"); const id = `consulta-field-${key}`;
      label.htmlFor = id; label.textContent = fieldLabel(key); input.id = id; input.value = value; input.autocomplete = "off"; field.append(label, input); card.append(field); inputs.set(key, input);
    }
    const actions = document.createElement("div"); actions.className = "actions";
    actions.append(this.button("Preencher formulário", "primary", () => {
      const fields = Object.fromEntries(Array.from(inputs, ([key, input]) => [key, input.value])); this.post("embed.confirm", { document: this.result?.document, fields }); this.setStatus("Preenchendo o formulário parceiro…");
    }), this.button("Ler outro documento", "secondary", () => this.options()));
    card.append(actions); this.panel.replaceChildren(card);
  }

  private loading(title: string, text: string): void {
    const card = this.card(title, text); const spinner = document.createElement("span"); spinner.className = "spinner"; spinner.setAttribute("aria-hidden", "true"); card.querySelector("p")?.prepend(spinner); this.panel.replaceChildren(card); this.setStatus(text);
  }

  private error(text: string): void {
    this.metric("error");
    this.stopCamera(); const card = this.card("Não foi possível concluir a leitura", text); card.classList.add("error"); const actions = document.createElement("div"); actions.className = "actions";
    if (this.config) actions.append(this.button("Tentar novamente", "primary", () => this.options())); actions.append(this.button("Fechar", "secondary", () => this.cancel())); card.append(actions); this.panel.replaceChildren(card); this.setStatus(text);
  }

  private card(title: string, text: string): HTMLElement {
    const card = document.createElement("section"); card.className = "card"; const heading = document.createElement("h1"); heading.textContent = title; const description = document.createElement("p"); description.textContent = text; card.append(heading, description); return card;
  }

  private applyBranding(branding: BootstrapBranding): void {
    this.root.style.setProperty("--consulta-brand-accent", branding.accentColor);
    this.root.style.setProperty("--consulta-brand-foreground", accentForeground(branding.accentColor));
    const brandName = this.root.querySelector<HTMLElement>(".brand-name");
    const powered = this.root.querySelector<HTMLElement>(".powered");
    if (brandName) brandName.textContent = branding.name;
    if (powered) powered.hidden = !branding.showPoweredBy;
  }

  private option(icon: string, title: string, text: string, action: () => void, compact = false): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = compact ? "option option-compact" : "option";
    button.setAttribute("aria-label", `${title}. ${text}`);
    button.title = text;
    const symbol = document.createElement("span"); symbol.className = "icon"; symbol.textContent = icon;
    const copy = document.createElement("span"); const heading = document.createElement("strong"); heading.textContent = title; copy.append(heading);
    if (!compact) {
      const description = document.createElement("span"); description.textContent = text; copy.append(description);
      const arrow = document.createElement("span"); arrow.className = "arrow"; arrow.textContent = "›";
      button.append(symbol, copy, arrow);
    } else {
      button.append(symbol, copy);
    }
    button.addEventListener("click", action);
    return button;
  }

  private button(label: string, kind: "primary" | "secondary", action: () => void): HTMLButtonElement {
    const button = document.createElement("button"); button.type = "button"; button.className = `button ${kind}`; button.textContent = label; button.addEventListener("click", action); return button;
  }

  private post(type: AutofillFrameMessage["type"], payload?: unknown): void {
    if (!this.port || !this.sessionId || this.disposed) return;
    this.port.postMessage({ protocol: "consulta-autofill", version: AUTOFILL_PROTOCOL_VERSION, type, project_id: this.query.projectId, session_id: this.sessionId, nonce: this.query.nonce, payload } satisfies AutofillFrameMessage);
  }

  /** The frame never sends a value, field name, QR payload or error text as telemetry. */
  private metric(event: AutofillEmbedMetricEvent): void {
    this.post("embed.metric", { event });
  }

  private cancel(): void { this.post("embed.cancel"); this.shutdown(); }

  private stopCamera(): void {
    this.looping = false; if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; } this.stream?.getTracks().forEach((track) => track.stop()); this.stream = null; if (this.video) this.video.srcObject = null; this.video = null;
  }

  private clearPayload(): void { this.payload?.fill(0); this.payload = null; }
  private clearResult(): void { if (this.result?.photoUrl) URL.revokeObjectURL(this.result.photoUrl); this.result = null; }

  private shutdown(): void {
    if (this.disposed) return;
    this.disposed = true; window.removeEventListener("message", this.receiveWindowMessage); this.stopCamera(); this.clearPayload(); this.clearResult(); this.port?.close(); this.port = null; this.engine?.dispose(); this.engine = null; this.panel.replaceChildren(this.card("Scanner fechado", "Você pode fechar esta janela e voltar ao cadastro.")); this.setStatus("Scanner fechado.");
  }

  private setStatus(text: string): void { this.status.textContent = text; }
}

export function startEmbed(root: HTMLElement): void {
  const query = queryFromLocation();
  if (!query) {
    root.textContent = "Esta janela do Consulta Autofill não recebeu uma configuração válida.";
    return;
  }
  new EmbedController(root, query).init();
}
