import {
  AUTOFILL_MAX_PHOTO_BYTES,
  isAutofillDecodeData,
  type AutofillDecodeData,
  type AutofillDecodedDocument,
  type AutofillEmbedMetricEvent,
} from "@consulta-dev/autofill/protocol";
import directStyles from "./direct.css?inline";
import type { EmbedQrScanner } from "./qr-scanner.js";
import type * as PdfJs from "pdfjs-dist/build/pdf.mjs";
import { MAX_QR_PIXELS } from "./qr-worker-protocol.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 3;
const MAX_RENDER_EDGE = 2_048;
// The direct runtime is emitted below assets/ and the immutable reader WASM
// stays at the root of the same release directory.
const readerWasmUrl = new URL(/* @vite-ignore */ "../zxing_reader.wasm", import.meta.url).toString();
const qrOnlyModuleUrl = import.meta.env.VITE_CONSULTA_QR_ONLY_MODULE_URL?.trim();
const qrOnlyWasmUrl = import.meta.env.VITE_CONSULTA_QR_ONLY_WASM_URL?.trim();

type PdfJsModule = typeof PdfJs;
type DecodedResult = {
  document: AutofillDecodedDocument;
  fields: Record<string, string>;
  photoUrl: string | null;
};

export type DirectScannerConfig = {
  projectId: string;
  sessionId: string;
  expiresAt: string;
  photoEnabled: boolean;
  branding: {
    name: string;
    accentColor: string;
    showPoweredBy: boolean;
  };
  presentation: { layout: "compact" | "standard" };
};

export type DirectScannerCallbacks = {
  decode(payloadBase64: string, includePhoto: boolean): Promise<AutofillDecodeData>;
  confirm(fields: Record<string, string>, document: AutofillDecodedDocument): void;
  cancel(): void;
  metric(event: AutofillEmbedMetricEvent): void;
  error(message: string): void;
};

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

function accentForeground(accentColor: string): string {
  const red = Number.parseInt(accentColor.slice(1, 3), 16);
  const green = Number.parseInt(accentColor.slice(3, 5), 16);
  const blue = Number.parseInt(accentColor.slice(5, 7), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1_000;
  return luminance > 160 ? "#101828" : "#FFFFFF";
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

/**
 * Browser UI mounted directly in the partner page's Shadow DOM. It only
 * handles local camera/file reading; decoding stays behind the partner bridge
 * passed as callbacks by the public Web Component.
 */
export class DirectScanner {
  private engine: EmbedQrScanner | null = null;
  private enginePromise: Promise<EmbedQrScanner> | null = null;
  private pdfPromise: Promise<PdfJsModule> | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: number | null = null;
  private looping = false;
  private scanning = false;
  private payload: Uint8Array | null = null;
  private result: DecodedResult | null = null;
  private disposed = false;
  private status: HTMLElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly config: DirectScannerConfig,
    private readonly callbacks: DirectScannerCallbacks,
  ) {
    this.applyBranding();
  }

  start(): void {
    this.options();
  }

  focus(): void {
    const preferred = this.root.querySelector<HTMLButtonElement>(".option, .button");
    (preferred ?? this.root.querySelector<HTMLButtonElement>(".close"))?.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopCamera();
    this.clearPayload();
    this.clearResult();
    this.engine?.dispose();
    this.engine = null;
    this.root.replaceChildren();
  }

  private options(): void {
    if (this.disposed) return;
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
    const actions = document.createElement("div");
    actions.className = compact ? "actions actions-compact" : "actions";
    actions.append(
      this.option("◉", "Usar câmera", "Aponte a câmera para o QR Code do documento.", () => void this.startCamera(), compact),
      this.option("▧", "Enviar imagem", "JPG, PNG ou WebP com o QR Code visível.", () => this.filePicker("image/*"), compact),
      this.option("▤", "Enviar PDF", "Lemos até as três primeiras páginas do documento.", () => this.filePicker("application/pdf"), compact),
    );
    const notice = document.createElement("div");
    notice.className = "notice";
    notice.textContent = compact
      ? "🔒 A câmera só é ativada após seu toque. Nada é enviado para analytics."
      : "🔒 A câmera só é ativada após seu toque. O componente não envia imagens, QR Codes ou dados para analytics.";
    card.append(actions, notice);
    this.render(card, "Pronto para ler seu documento.");
  }

  private async startCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) return this.error("A câmera não está disponível neste navegador.");
    this.stopCamera();
    const card = this.card("Posicione o QR Code", "Mantenha o documento iluminado e enquadre o QR dentro da área marcada.");
    const camera = document.createElement("div");
    camera.className = "camera";
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    const guide = document.createElement("div");
    guide.className = "guide";
    guide.setAttribute("aria-hidden", "true");
    camera.append(video, guide);
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(this.button("Voltar", "secondary", () => this.options()));
    card.append(camera, actions);
    this.render(card, "Solicitando acesso à câmera…");
    this.video = video;
    this.metric("camera_requested");

    // Start loading ZXing/WASM while the browser asks for permission. No
    // camera frame is read until getUserMedia resolves successfully.
    const scannerReady = this.prepareScanner();
    void scannerReady.catch(() => {});
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      if (this.disposed || !this.video) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      await scannerReady;
      if (this.disposed || this.video !== video || this.stream !== stream) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.looping = true;
      this.metric("camera_granted");
      this.setStatus("Procurando o QR Code…");
      this.schedule(250);
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
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.scanCamera();
    }, delay);
  }

  private async scanCamera(): Promise<void> {
    if (!this.video || !this.looping || this.scanning) return;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !this.video.videoWidth || !this.video.videoHeight) {
      return this.schedule(250);
    }
    this.scanning = true;
    try {
      const payload = await this.scanImage(this.videoImage());
      if (payload) {
        this.payload = payload;
        this.stopCamera();
        this.metric("qr_found");
        return this.requestDecode(false);
      }
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
    const width = Math.max(1, Math.round(this.video.videoWidth * scale));
    const height = Math.max(1, Math.round(this.video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Não foi possível preparar a imagem da câmera.");
    context.drawImage(this.video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    canvas.width = 1;
    canvas.height = 1;
    return image;
  }

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
        // Some browsers expose createImageBitmap without image decoding support.
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
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.className = "hidden";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void this.scanFile(file);
    });
    this.root.append(input);
    input.click();
  }

  private async scanFile(file: File): Promise<void> {
    if (!file.size || file.size > MAX_UPLOAD_BYTES) return this.error("Escolha um arquivo de até 10 MB.");
    const pdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!pdf && !file.type.startsWith("image/")) return this.error("Envie uma imagem (JPG, PNG ou WebP) ou um PDF.");
    this.stopCamera();
    this.loading("Lendo o documento", pdf ? "Procurando o QR nas páginas iniciais do PDF…" : "Procurando o QR na imagem…");
    try {
      const payload = pdf ? await this.scanPdf(file) : await this.scanImage(await this.imageDataFromFile(file));
      if (!payload) throw new Error("Não encontramos um QR Code neste arquivo.");
      this.payload = payload;
      this.metric("qr_found");
      await this.requestDecode(false);
    } catch (cause) {
      this.error(cause instanceof Error ? cause.message : "Não foi possível ler este arquivo.");
    }
  }

  private async scanPdf(file: File): Promise<Uint8Array | null> {
    this.setStatus("Preparando o leitor de PDF…");
    const { AnnotationMode, getDocument } = await this.pdfjs();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const task = getDocument({
      data: bytes,
      stopAtErrors: true,
      disableFontFace: true,
      enableXfa: false,
      maxImageSize: MAX_RENDER_EDGE * MAX_RENDER_EDGE,
    });
    try {
      const pdf = await task.promise;
      const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);
      for (let number = 1; number <= pages; number += 1) {
        this.setStatus(`Lendo a página ${number} de ${pages}…`);
        const page = await pdf.getPage(number);
        try {
          const natural = page.getViewport({ scale: 1 });
          const scale = Math.max(.2, Math.min(2, MAX_RENDER_EDGE / Math.max(natural.width, natural.height)));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("Não foi possível renderizar o PDF.");
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
        } finally {
          page.cleanup();
        }
      }
      return null;
    } finally {
      await task.destroy();
      bytes.fill(0);
    }
  }

  private async requestDecode(includePhoto: boolean): Promise<void> {
    if (!this.payload || this.disposed) return;
    if (Date.parse(this.config.expiresAt) <= Date.now()) return this.error("A sessão expirou. Feche e abra o Autofill novamente.");
    this.loading("Buscando os dados", "O serviço está validando o documento. Isso pode levar alguns segundos…");
    try {
      const decoded = await this.callbacks.decode(base64(this.payload), includePhoto);
      if (this.disposed) return;
      const result = decodeResult(decoded);
      if (!result) throw new Error("A resposta recebida não segue o contrato do Autofill.");
      this.result = result;
      this.clearPayload();
      this.review();
    } catch (cause) {
      if (!this.disposed) this.error(cause instanceof Error ? cause.message : "Não foi possível decodificar o documento.");
    }
  }

  private review(): void {
    if (!this.result || this.disposed) return;
    const card = this.card("Confira antes de preencher", "Você pode editar os campos abaixo. Os valores existentes no formulário parceiro serão preservados por padrão.");
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = `✓ ${this.result.document.label} reconhecida`;
    card.append(badge);
    if (this.result.photoUrl) {
      const photo = document.createElement("img");
      photo.className = "photo";
      photo.src = this.result.photoUrl;
      photo.alt = "Foto retornada pelo documento";
      card.append(photo);
    }
    const inputs = new Map<string, HTMLInputElement>();
    for (const [key, value] of Object.entries(this.result.fields)) {
      const field = document.createElement("div");
      field.className = "field";
      const label = document.createElement("label");
      const input = document.createElement("input");
      const id = `consulta-field-${key}`;
      label.htmlFor = id;
      label.textContent = fieldLabel(key);
      input.id = id;
      input.value = value;
      input.autocomplete = "off";
      field.append(label, input);
      card.append(field);
      inputs.set(key, input);
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      this.button("Preencher formulário", "primary", () => {
        const fields = Object.fromEntries(Array.from(inputs, ([key, input]) => [key, input.value]));
        this.callbacks.confirm(fields, this.result!.document);
      }),
      this.button("Ler outro documento", "secondary", () => this.options()),
    );
    card.append(actions);
    this.render(card, "Confira os dados antes de preencher o formulário.");
  }

  private loading(title: string, text: string): void {
    const card = this.card(title, text);
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    card.querySelector("p")?.prepend(spinner);
    this.render(card, text);
  }

  private error(text: string): void {
    if (this.disposed) return;
    this.metric("error");
    this.callbacks.error(text);
    this.stopCamera();
    const card = this.card("Não foi possível concluir a leitura", text);
    card.classList.add("error");
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(this.button("Tentar novamente", "primary", () => this.options()));
    card.append(actions);
    this.render(card, text);
  }

  private card(title: string, text: string): HTMLElement {
    const card = document.createElement("section");
    card.className = "card";
    const heading = document.createElement("h1");
    heading.textContent = title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.setAttribute("aria-label", "Fechar");
    close.title = "Fechar";
    close.textContent = "×";
    close.addEventListener("click", () => this.cancel());
    const description = document.createElement("p");
    description.textContent = text;
    card.append(heading, close, description);
    return card;
  }

  private render(card: HTMLElement, statusText: string): void {
    if (this.config.branding.showPoweredBy) {
      const powered = document.createElement("p");
      powered.className = "powered";
      powered.textContent = "Powered by consulta.dev.br";
      card.append(powered);
    } else {
      // A white-label project still gets its configured identity, but it
      // remains part of the one compact card instead of restoring a shell
      // header around the scanner.
      const partnerBrand = document.createElement("p");
      partnerBrand.className = "partner-brand";
      partnerBrand.textContent = this.config.branding.name;
      card.append(partnerBrand);
    }
    const status = document.createElement("p");
    status.className = "status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = statusText;
    card.append(status);
    this.root.replaceChildren(card);
    this.status = status;
  }

  private applyBranding(): void {
    this.root.style.setProperty("--consulta-brand-accent", this.config.branding.accentColor);
    this.root.style.setProperty("--consulta-brand-foreground", accentForeground(this.config.branding.accentColor));
  }

  private option(icon: string, title: string, text: string, action: () => void, compact = false): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = compact ? "option option-compact" : "option";
    button.setAttribute("aria-label", `${title}. ${text}`);
    button.title = text;
    const symbol = document.createElement("span");
    symbol.className = "icon";
    symbol.textContent = icon;
    const copy = document.createElement("span");
    const heading = document.createElement("strong");
    heading.textContent = title;
    copy.append(heading);
    if (!compact) {
      const description = document.createElement("span");
      description.textContent = text;
      copy.append(description);
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = "›";
      button.append(symbol, copy, arrow);
    } else {
      button.append(symbol, copy);
    }
    button.addEventListener("click", action);
    return button;
  }

  private button(label: string, kind: "primary" | "secondary", action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${kind}`;
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  private metric(event: AutofillEmbedMetricEvent): void {
    this.callbacks.metric(event);
  }

  private cancel(): void {
    this.callbacks.cancel();
  }

  private stopCamera(): void {
    this.looping = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
  }

  private clearPayload(): void {
    this.payload?.fill(0);
    this.payload = null;
  }

  private clearResult(): void {
    if (this.result?.photoUrl) URL.revokeObjectURL(this.result.photoUrl);
    this.result = null;
  }

  private setStatus(text: string): void {
    if (this.status) this.status.textContent = text;
  }
}

export function mountDirectScanner(
  root: HTMLElement,
  config: DirectScannerConfig,
  callbacks: DirectScannerCallbacks,
): DirectScanner {
  root.replaceChildren();
  const style = document.createElement("style");
  style.textContent = directStyles;
  const surface = document.createElement("div");
  surface.className = "direct-scanner";
  root.append(style, surface);
  const scanner = new DirectScanner(surface, config, callbacks);
  scanner.start();
  return scanner;
}
