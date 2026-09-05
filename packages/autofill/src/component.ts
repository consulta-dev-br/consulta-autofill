import {
  AUTOFILL_EMBED_METRIC_EVENTS,
  AUTOFILL_PROTOCOL_VERSION,
  isAutofillDecodeData,
} from "./protocol.js";
import type {
  AutofillDecodeData,
  AutofillDecodeResponse,
  AutofillDecodedDocument,
  AutofillDocumentType,
  AutofillEmbedMetricEvent,
  AutofillMetricEvent,
  AutofillSession,
  AutofillSessionResponse,
} from "./protocol.js";

const ELEMENT_NAME = "consulta-autofill";
const DOCUMENT_TYPES = new Set<AutofillDocumentType>(["auto", "cnh-e", "crlv-e"]);
const EMBED_METRIC_EVENTS = new Set<AutofillEmbedMetricEvent>(AUTOFILL_EMBED_METRIC_EVENTS);
// Keeps the package importable from SSR/build tooling. Instances are only
// constructed by the browser's Custom Elements registry.
const HTMLElementBase: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

const styleText = `
  :host { display: inline-block; font-family: ui-sans-serif, system-ui, sans-serif; }
  button { font: inherit; }
  .trigger { display: inline-flex; align-items: center; gap: .5rem; border: 0; border-radius: .7rem; padding: .65rem .9rem; color: white; background: #155eef; cursor: pointer; box-shadow: 0 1px 2px rgb(16 24 40 / .12); }
  .trigger:hover:not(:disabled) { background: #004eeb; }
  .trigger:focus-visible { outline: 3px solid #84adff; outline-offset: 3px; }
  .trigger:disabled { cursor: wait; opacity: .7; }
  .trigger-icon { justify-content: center; width: 2.45rem; height: 2.45rem; padding: .5rem; color: #155eef; background: transparent; box-shadow: none; }
  .trigger-icon:hover:not(:disabled) { background: rgb(21 94 239 / .12); }
  .trigger-icon svg { display: block; }
  .overlay { position: fixed; z-index: 2147483000; inset: 0; display: grid; place-items: center; padding: 1rem; background: rgb(16 24 40 / .58); }
  .dialog { position: relative; width: min(100%, 29rem); max-height: calc(100dvh - 2rem); outline: 0; }
  .runtime { width: 100%; }
  .loading { padding: 1rem; border: 1px solid #e4e7ec; border-radius: .85rem; color: #475467; background: #fff; box-shadow: 0 24px 48px rgb(16 24 40 / .28); text-align: center; }
  @media (max-width: 34rem) {
    .overlay { align-items: end; padding: .75rem; }
    .dialog { width: 100%; max-height: calc(100dvh - 1.5rem); }
  }
`;

type FilledDetail = {
  fields: Record<string, string>;
  filled: string[];
  preserved: string[];
  document: AutofillDecodeData["document"];
};

type DirectScannerConfig = {
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

type DirectScannerInstance = {
  dispose(): void;
  focus(): void;
};

type DirectScannerRuntime = {
  mountDirectScanner(
    root: HTMLElement,
    config: DirectScannerConfig,
    callbacks: {
      decode(payloadBase64: string, includePhoto: boolean): Promise<AutofillDecodeData>;
      confirm(fields: Record<string, string>, document: AutofillDecodedDocument): void;
      cancel(): void;
      metric(event: AutofillEmbedMetricEvent): void;
      error(message: string): void;
    },
  ): DirectScannerInstance;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isSessionResponse(value: unknown): value is AutofillSessionResponse {
  if (!isRecord(value) || typeof value.success !== "boolean") return false;
  if (!value.success) return isRecord(value.error) && typeof value.request_id === "string";
  if (!isRecord(value.data)) return false;
  const data = value.data;
  return (
    typeof data.session_id === "string"
    && typeof data.session_token === "string"
    && typeof data.project_id === "string"
    && typeof data.expires_at === "string"
    && typeof data.embed_url === "string"
    && typeof data.bootstrap_url === "string"
    && (data.direct_scanner_url === undefined || typeof data.direct_scanner_url === "string")
    && Array.isArray(data.allowed_document_types)
    && typeof data.photo_enabled === "boolean"
    && typeof value.request_id === "string"
  );
}

function isDecodeResponse(value: unknown): value is AutofillDecodeResponse {
  if (!isRecord(value) || typeof value.success !== "boolean") return false;
  if (!value.success) return isRecord(value.error) && typeof value.request_id === "string";
  return isAutofillDecodeData(value.data) && typeof value.request_id === "string";
}

function isDecodedDocument(value: unknown): value is AutofillDecodedDocument {
  return (
    isRecord(value)
    && (value.type === "cnh-e" || value.type === "crlv-e")
    && typeof value.label === "string"
    && value.label.length > 0
  );
}

function responseMessage(value: unknown, fallback: string): string {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") return fallback;
  return value.error.message;
}

function valueSetter(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): ((value: string) => void) | null {
  const prototype = element instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLSelectElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  return setter ? (value) => setter.call(element, value) : null;
}

function activeElementAcrossShadowRoots(): HTMLElement | null {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement instanceof HTMLElement) {
    active = active.shadowRoot.activeElement;
  }
  return active instanceof HTMLElement ? active : null;
}

function cameraIcon(): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "20");
  icon.setAttribute("height", "20");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");

  const body = document.createElementNS(namespace, "path");
  body.setAttribute("d", "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z");
  const lens = document.createElementNS(namespace, "circle");
  lens.setAttribute("cx", "12");
  lens.setAttribute("cy", "13");
  lens.setAttribute("r", "3");
  icon.append(body, lens);
  return icon;
}

function consultaBranding(): DirectScannerConfig["branding"] {
  return { name: "Consulta Autofill", accentColor: "#155EEF", showPoweredBy: true };
}

function bootstrapBranding(value: unknown): DirectScannerConfig["branding"] {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim().length < 1 || value.name.trim().length > 60) {
    return consultaBranding();
  }
  if (typeof value.accent_color !== "string" || !/^#[0-9A-F]{6}$/i.test(value.accent_color) || typeof value.show_powered_by !== "boolean") {
    return consultaBranding();
  }
  const name = value.name.trim();
  const accentColor = value.accent_color.toUpperCase();
  if (value.mode === "partner" && value.show_powered_by === false) return { name, accentColor, showPoweredBy: false };
  if (value.mode === "consulta" && value.show_powered_by === true && name === "Consulta Autofill" && accentColor === "#155EEF") {
    return consultaBranding();
  }
  return consultaBranding();
}

function bootstrapConfig(value: unknown, session: AutofillSession): DirectScannerConfig | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  const data = value.data;
  if (
    data.protocol_version !== AUTOFILL_PROTOCOL_VERSION
    || data.project_id !== session.project_id
    || data.session_id !== session.session_id
    || typeof data.expires_at !== "string"
    || typeof data.photo_enabled !== "boolean"
    || !Array.isArray(data.allowed_document_types)
  ) {
    return null;
  }
  const validTypes = data.allowed_document_types.every((type) => type === "cnh-e" || type === "crlv-e");
  if (!validTypes || !data.allowed_document_types.length || Date.parse(data.expires_at) <= Date.now()) return null;
  return {
    projectId: session.project_id,
    sessionId: session.session_id,
    expiresAt: data.expires_at,
    photoEnabled: data.photo_enabled,
    branding: bootstrapBranding(data.branding),
    presentation: isRecord(data.presentation) && data.presentation.layout === "standard" ? { layout: "standard" } : { layout: "compact" },
  };
}

function trustedRemoteUrl(value: string, purpose: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${purpose} não possui uma URL válida.`);
  }
  const localHttp = url.protocol === "http:" && isLocalDevelopmentHost(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp)
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error(`${purpose} precisa usar HTTPS.`);
  }
  return url;
}

export class ConsultaAutofillElement extends HTMLElementBase {
  private readonly shadow = this.attachShadow({ mode: "open" });
  private modal: HTMLElement | null = null;
  private scanner: DirectScannerInstance | null = null;
  private session: AutofillSession | null = null;
  private requestAbort: AbortController | null = null;
  private trigger: HTMLButtonElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private readonly reportedMetrics = new Set<AutofillMetricEvent>();
  private metricsOpened = false;

  connectedCallback(): void {
    this.render();
    window.addEventListener("keydown", this.handleKeydown);
    window.addEventListener("focusin", this.handleFocusIn, true);
    this.emit("consulta:ready", { protocol_version: AUTOFILL_PROTOCOL_VERSION });
  }

  disconnectedCallback(): void {
    this.destroy();
  }

  /** Opens one direct, origin-bound Autofill dialog in the component Shadow DOM. */
  async open(): Promise<void> {
    if (this.modal || this.requestAbort) return;
    const abort = new AbortController();
    this.requestAbort = abort;
    this.showLoading();
    this.setTriggerBusy(true);

    try {
      const session = await this.createPartnerSession(abort.signal);
      this.session = session;
      this.reportedMetrics.clear();
      this.metricsOpened = false;
      const runtimePromise = this.loadDirectRuntime(session);
      const config = await this.bootstrapDirectSession(session, abort.signal);
      const runtime = await runtimePromise;
      const modal = this.currentModal();
      if (!modal || abort.signal.aborted) return;
      const root = modal.querySelector<HTMLElement>(".runtime");
      if (!root) throw new Error("O diálogo Autofill não foi inicializado.");
      root.replaceChildren();
      this.scanner = runtime.mountDirectScanner(root, config, {
        decode: (payloadBase64, includePhoto) => this.decodePayload(payloadBase64, includePhoto),
        confirm: (fields, document) => this.confirmFields(fields, document),
        cancel: () => this.close(),
        metric: (event) => this.reportEmbedMetric(event),
        error: (message) => this.emitError(message),
      });
      this.metricsOpened = true;
      this.emit("consulta:opened", { project_id: session.project_id, session_id: session.session_id });
      this.reportMetric("opened");
      this.scanner.focus();
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        this.close();
        this.emitError(error instanceof Error ? error.message : "Não foi possível abrir o Consulta Autofill.");
      }
    } finally {
      if (this.requestAbort === abort) this.requestAbort = null;
      this.setTriggerBusy(false);
    }
  }

  /** Closes the dialog and drops all in-memory session references. */
  close(): void {
    if (this.metricsOpened) this.reportMetric("closed");
    this.metricsOpened = false;
    this.requestAbort?.abort();
    this.requestAbort = null;
    this.scanner?.dispose();
    this.scanner = null;
    this.modal?.remove();
    this.modal = null;
    this.session = null;
    this.setTriggerBusy(false);
    this.previousFocus?.focus?.();
    this.previousFocus = null;
  }

  /** Removes listeners and scanner resources. The element itself remains in the DOM. */
  destroy(): void {
    this.close();
    window.removeEventListener("keydown", this.handleKeydown);
    window.removeEventListener("focusin", this.handleFocusIn, true);
  }

  private render(): void {
    this.shadow.replaceChildren();
    const style = document.createElement("style");
    style.textContent = styleText;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "trigger";
    const label = this.getAttribute("label") || "Escanear documento";
    if (this.getAttribute("trigger-variant") === "icon") {
      button.classList.add("trigger-icon");
      button.setAttribute("aria-label", label);
      button.title = label;
      button.append(cameraIcon());
    } else {
      button.textContent = label;
    }
    button.setAttribute("aria-haspopup", "dialog");
    button.addEventListener("click", () => void this.open());
    this.shadow.append(style, button);
    this.trigger = button;
  }

  private setTriggerBusy(busy: boolean): void {
    if (!this.trigger) return;
    this.trigger.disabled = busy;
    this.trigger.setAttribute("aria-busy", String(busy));
  }

  private showLoading(): void {
    const active = activeElementAcrossShadowRoots();
    this.previousFocus = active && active !== document.body ? active : this.trigger;
    const overlay = this.createDialog();
    const runtime = overlay.querySelector<HTMLElement>(".runtime");
    const loading = document.createElement("section");
    loading.className = "loading";
    loading.textContent = "Preparando o scanner…";
    runtime?.replaceChildren(loading);
    overlay.querySelector<HTMLElement>(".dialog")?.focus();
  }

  private createDialog(): HTMLElement {
    this.modal?.remove();
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) this.close();
    });
    const dialog = document.createElement("section");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Consulta Autofill");
    dialog.tabIndex = -1;
    const runtime = document.createElement("div");
    runtime.className = "runtime";
    dialog.append(runtime);
    overlay.append(dialog);
    this.shadow.append(overlay);
    this.modal = overlay;
    return overlay;
  }

  private currentModal(): HTMLElement | null {
    return this.modal;
  }

  private async createPartnerSession(signal: AbortSignal): Promise<AutofillSession> {
    const endpoint = this.partnerEndpoint("session");
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: AUTOFILL_PROTOCOL_VERSION,
        document_type: this.documentType(),
      }),
      signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!isSessionResponse(body)) throw new Error("O endpoint de sessão retornou uma resposta incompatível.");
    if (!response.ok || !body.success) throw new Error(responseMessage(body, "Não foi possível criar uma sessão Autofill."));
    if (body.data.project_id !== this.requiredProjectId()) throw new Error("A sessão retornou um projeto diferente do componente.");
    return body.data;
  }

  private async bootstrapDirectSession(session: AutofillSession, signal: AbortSignal): Promise<DirectScannerConfig> {
    const url = trustedRemoteUrl(session.bootstrap_url, "O bootstrap do Autofill");
    const response = await fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_token: session.session_token, parent_origin: window.location.origin }),
      signal,
    });
    const body: unknown = await response.json().catch(() => null);
    const config = bootstrapConfig(body, session);
    if (!response.ok || !config) throw new Error(responseMessage(body, "Não foi possível validar esta sessão Autofill."));
    return config;
  }

  private async loadDirectRuntime(session: AutofillSession): Promise<DirectScannerRuntime> {
    if (!session.direct_scanner_url) {
      throw new Error("Esta API Autofill ainda não disponibiliza o scanner direto. Atualize a integração do servidor.");
    }
    const url = trustedRemoteUrl(session.direct_scanner_url, "O runtime direto do Autofill");
    const loaded: unknown = await import(/* @vite-ignore */ url.toString());
    if (!isRecord(loaded) || typeof loaded.mountDirectScanner !== "function") {
      throw new Error("O runtime direto do Autofill não possui a interface esperada.");
    }
    return loaded as DirectScannerRuntime;
  }

  private async decodePayload(payloadBase64: string, includePhoto: boolean): Promise<AutofillDecodeData> {
    if (!this.session) throw new Error("A sessão Autofill foi encerrada.");
    this.requestAbort = new AbortController();
    try {
      const response = await fetch(this.partnerEndpoint("decode"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: AUTOFILL_PROTOCOL_VERSION,
          session_token: this.session.session_token,
          payload_base64: payloadBase64,
          include_photo: includePhoto,
        }),
        signal: this.requestAbort.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!isDecodeResponse(body)) throw new Error("O endpoint de decode retornou uma resposta incompatível.");
      if (!response.ok || !body.success) throw new Error(responseMessage(body, "Não foi possível decodificar o documento."));
      this.reportMetric("decoded");
      this.emit("consulta:decoded", {
        document_type: body.data.document.type,
        field_keys: Object.keys(body.data.fields),
        request_id: body.request_id,
      });
      return body.data;
    } finally {
      this.requestAbort = null;
    }
  }

  private confirmFields(fields: Record<string, string>, document: AutofillDecodedDocument): void {
    if (!this.session || !isDecodedDocument(document)) {
      this.emitError("A confirmação de campos é inválida.");
      return;
    }
    const safeFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === "string") safeFields[key] = value;
    }
    const detail = this.fillFields(safeFields, document);
    this.reportMetric("confirmed");
    this.emit("consulta:confirmed", { document, field_keys: Object.keys(safeFields) });
    this.reportMetric("filled");
    this.emit("consulta:filled", detail);
    this.close();
  }

  private reportEmbedMetric(event: AutofillEmbedMetricEvent): void {
    if (!EMBED_METRIC_EVENTS.has(event)) return;
    this.reportMetric(event);
  }

  private fillFields(fields: Record<string, string>, document: FilledDetail["document"]): FilledDetail {
    const form = this.targetForm();
    const filled: string[] = [];
    const preserved: string[] = [];
    const controls = form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input[data-consulta-field], textarea[data-consulta-field], select[data-consulta-field]",
    );
    for (const control of controls) {
      const key = control.dataset.consultaField;
      if (!key || !(key in fields)) continue;
      if (control.value.trim()) {
        preserved.push(key);
        continue;
      }
      const setValue = valueSetter(control);
      if (setValue) setValue(fields[key]);
      else control.value = fields[key];
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      filled.push(key);
    }
    return { fields, filled, preserved, document };
  }

  private targetForm(): HTMLElement {
    const selector = this.getAttribute("target-form");
    let target: HTMLElement | null;
    if (selector) {
      try {
        target = document.querySelector<HTMLElement>(selector);
      } catch {
        throw new Error("target-form precisa ser um seletor CSS válido.");
      }
    } else {
      target = this.closestFormAcrossShadowRoots();
    }
    if (!target) throw new Error("Não foi possível encontrar o formulário definido em target-form.");
    return target;
  }

  private closestFormAcrossShadowRoots(): HTMLElement | null {
    const ownForm = this.closest<HTMLElement>("form");
    if (ownForm) return ownForm;
    let root: Node = this.getRootNode();
    while (root instanceof ShadowRoot) {
      const form = root.host.closest<HTMLElement>("form");
      if (form) return form;
      root = root.host.getRootNode();
    }
    return null;
  }

  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private emitError(message: string): void {
    this.emit("consulta:error", { message });
  }

  private partnerEndpoint(path: "session" | "decode"): string {
    const value = this.getAttribute("endpoint");
    if (!value) throw new Error("Defina o atributo endpoint do Consulta Autofill.");
    const base = new URL(value, window.location.href);
    if (base.origin !== window.location.origin || base.username || base.password) {
      throw new Error("O endpoint do Consulta Autofill deve usar a mesma origem da página parceira.");
    }
    return new URL(path, `${base.toString().replace(/\/$/, "")}/`).toString();
  }

  /**
   * Optional endpoint owned by the partner. Invalid configuration fails closed
   * for analytics only: scanning and form filling remain available.
   */
  private metricsEndpoint(): string | null {
    const value = this.getAttribute("metrics-endpoint")?.trim();
    if (!value) return null;
    try {
      const endpoint = new URL(value, window.location.href);
      if (
        endpoint.origin !== window.location.origin
        || endpoint.username
        || endpoint.password
        || endpoint.search
        || endpoint.hash
      ) {
        return null;
      }
      return endpoint.toString();
    } catch {
      return null;
    }
  }

  /** Sends a fixed lifecycle label only. It is intentionally best-effort. */
  private reportMetric(event: AutofillMetricEvent): void {
    const endpoint = this.metricsEndpoint();
    const sessionToken = this.session?.session_token;
    if (!endpoint || !sessionToken || this.reportedMetrics.has(event)) return;
    this.reportedMetrics.add(event);
    void fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: AUTOFILL_PROTOCOL_VERSION,
        session_token: sessionToken,
        event,
      }),
    }).catch(() => undefined);
  }

  private requiredProjectId(): string {
    const projectId = this.getAttribute("project-id")?.trim();
    if (!projectId || !/^pub_[A-Za-z0-9_-]{8,128}$/.test(projectId)) {
      throw new Error("Defina um project-id público válido no Consulta Autofill.");
    }
    return projectId;
  }

  private documentType(): AutofillDocumentType {
    const value = this.getAttribute("document-type") || "auto";
    if (!DOCUMENT_TYPES.has(value as AutofillDocumentType)) throw new Error("document-type precisa ser auto, cnh-e ou crlv-e.");
    return value as AutofillDocumentType;
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.modal) {
      event.preventDefault();
      this.close();
    }
  };

  /** Keeps the direct dialog modal even when the trigger lives inside nested Shadow DOM. */
  private readonly handleFocusIn = (event: FocusEvent): void => {
    const modal = this.modal;
    if (!modal || event.composedPath().includes(modal)) return;
    if (this.scanner) this.scanner.focus();
    else modal.querySelector<HTMLElement>(".dialog")?.focus();
  };
}

export function defineConsultaAutofill(): void {
  if (typeof window === "undefined" || customElements.get(ELEMENT_NAME)) return;
  customElements.define(ELEMENT_NAME, ConsultaAutofillElement);
}
