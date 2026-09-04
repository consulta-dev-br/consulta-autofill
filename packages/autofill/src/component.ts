import {
  AUTOFILL_EMBED_METRIC_EVENTS,
  AUTOFILL_PROTOCOL_VERSION,
  isAutofillDecodeData,
  isAutofillEmbedReadyMessage,
  isAutofillFrameMessage,
} from "./protocol.js";
import type {
  AutofillDecodeData,
  AutofillDecodeResponse,
  AutofillDecodedDocument,
  AutofillDocumentType,
  AutofillEmbedMetricEvent,
  AutofillFrameMessage,
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
  .dialog { position: relative; display: grid; width: min(100%, 34rem); height: min(100%, 44rem); overflow: hidden; border-radius: 1rem; background: white; box-shadow: 0 24px 48px rgb(16 24 40 / .28); }
  .loading { display: grid; place-items: center; padding: 2rem; color: #475467; text-align: center; }
  iframe { width: 100%; height: 100%; border: 0; background: white; }
`;

type FilledDetail = {
  fields: Record<string, string>;
  filled: string[];
  preserved: string[];
  document: AutofillDecodeData["document"];
};

function randomNonce(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll("-", "");
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("O navegador não disponibiliza aleatoriedade criptográfica para abrir o Autofill.");
  }
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEmbedMetricMessage(
  message: AutofillFrameMessage,
): message is AutofillFrameMessage<{ event: AutofillEmbedMetricEvent }> & { payload: { event: AutofillEmbedMetricEvent } } {
  const payload = message.payload;
  return (
    isRecord(payload) &&
    Object.keys(payload).length === 1 &&
    typeof payload.event === "string" &&
    EMBED_METRIC_EVENTS.has(payload.event as AutofillEmbedMetricEvent)
  );
}

function isSessionResponse(value: unknown): value is AutofillSessionResponse {
  if (!isRecord(value) || typeof value.success !== "boolean") return false;
  if (!value.success) return isRecord(value.error) && typeof value.request_id === "string";
  if (!isRecord(value.data)) return false;
  const data = value.data;
  return (
    typeof data.session_id === "string" &&
    typeof data.session_token === "string" &&
    typeof data.project_id === "string" &&
    typeof data.expires_at === "string" &&
    typeof data.embed_url === "string" &&
    typeof data.bootstrap_url === "string" &&
    Array.isArray(data.allowed_document_types) &&
    typeof data.photo_enabled === "boolean" &&
    typeof value.request_id === "string"
  );
}

function isDecodeResponse(value: unknown): value is AutofillDecodeResponse {
  if (!isRecord(value) || typeof value.success !== "boolean") return false;
  if (!value.success) return isRecord(value.error) && typeof value.request_id === "string";
  return isAutofillDecodeData(value.data) && typeof value.request_id === "string";
}

function isDecodedDocument(value: unknown): value is AutofillDecodedDocument {
  return (
    isRecord(value) &&
    (value.type === "cnh-e" || value.type === "crlv-e") &&
    typeof value.label === "string" &&
    value.label.length > 0
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

export class ConsultaAutofillElement extends HTMLElementBase {
  private readonly shadow = this.attachShadow({ mode: "open" });
  private modal: HTMLElement | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private messagePort: MessagePort | null = null;
  private session: AutofillSession | null = null;
  private handshakeNonce: string | null = null;
  private embedOrigin: string | null = null;
  private requestAbort: AbortController | null = null;
  private trigger: HTMLButtonElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private readonly reportedMetrics = new Set<AutofillMetricEvent>();
  private metricsOpened = false;

  connectedCallback(): void {
    this.render();
    window.addEventListener("message", this.handleWindowMessage);
    window.addEventListener("keydown", this.handleKeydown);
    window.addEventListener("focusin", this.handleFocusIn, true);
    this.emit("consulta:ready", { protocol_version: AUTOFILL_PROTOCOL_VERSION });
  }

  disconnectedCallback(): void {
    this.destroy();
  }

  /** Opens the hosted, origin-validated Autofill dialog. */
  async open(): Promise<void> {
    if (this.modal || this.requestAbort) return;
    this.requestAbort = new AbortController();
    this.showLoading();
    this.setTriggerBusy(true);

    try {
      const session = await this.createPartnerSession(this.requestAbort.signal);
      this.session = session;
      this.reportedMetrics.clear();
      this.metricsOpened = false;
      this.handshakeNonce = randomNonce();
      this.openEmbed(session);
      this.metricsOpened = true;
      this.emit("consulta:opened", { project_id: session.project_id, session_id: session.session_id });
      this.reportMetric("opened");
    } catch (error) {
      this.close();
      this.emitError(error instanceof Error ? error.message : "Não foi possível abrir o Consulta Autofill.");
    } finally {
      this.requestAbort = null;
      this.setTriggerBusy(false);
    }
  }

  /** Closes the dialog and drops all in-memory session references. */
  close(): void {
    if (this.metricsOpened) this.reportMetric("closed");
    this.metricsOpened = false;
    this.requestAbort?.abort();
    this.requestAbort = null;
    this.messagePort?.close();
    this.messagePort = null;
    this.iframe?.remove();
    this.iframe = null;
    this.modal?.remove();
    this.modal = null;
    this.session = null;
    this.handshakeNonce = null;
    this.embedOrigin = null;
    this.setTriggerBusy(false);
    this.previousFocus?.focus?.();
    this.previousFocus = null;
  }

  /** Removes listeners and iframe resources. The element itself remains in the DOM. */
  destroy(): void {
    this.close();
    window.removeEventListener("message", this.handleWindowMessage);
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
    // WebKit can report <body> while dispatching a click from a nested shadow
    // root. Returning to the trigger is preferable to leaving focus nowhere.
    this.previousFocus = active && active !== document.body ? active : this.trigger;
    const overlay = this.createDialog();
    const content = document.createElement("div");
    content.className = "loading";
    content.textContent = "Preparando o scanner seguro…";
    const dialog = overlay.querySelector<HTMLElement>(".dialog");
    dialog?.append(content);
    dialog?.focus();
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
    overlay.append(dialog);
    this.shadow.append(overlay);
    this.modal = overlay;
    return overlay;
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

  private openEmbed(session: AutofillSession): void {
    if (!this.modal || !this.handshakeNonce) throw new Error("O diálogo Autofill não foi inicializado.");
    const embedUrl = new URL(session.embed_url);
    if (embedUrl.protocol !== "https:" && !this.isLocalDevelopmentHost(embedUrl.hostname)) {
      throw new Error("O embed Autofill precisa ser servido por HTTPS.");
    }
    this.embedOrigin = embedUrl.origin;
    embedUrl.searchParams.set("project_id", session.project_id);
    embedUrl.searchParams.set("nonce", this.handshakeNonce);
    embedUrl.searchParams.set("parent_origin", window.location.origin);

    const frame = document.createElement("iframe");
    frame.title = "Scanner Consulta Autofill";
    frame.src = embedUrl.toString();
    frame.allow = "camera";
    frame.sandbox.add("allow-scripts", "allow-same-origin");
    frame.referrerPolicy = "no-referrer";
    frame.addEventListener("load", () => frame.focus(), { once: true });
    const dialog = this.modal.querySelector(".dialog");
    const loading = dialog?.querySelector(".loading");
    loading?.remove();
    dialog?.append(frame);
    this.iframe = frame;
  }

  private readonly handleWindowMessage = (event: MessageEvent<unknown>): void => {
    if (!this.iframe || !this.session || !this.handshakeNonce || !this.embedOrigin || this.messagePort) return;
    if (event.origin !== this.embedOrigin || event.source !== this.iframe.contentWindow) return;
    if (!isAutofillEmbedReadyMessage(event.data)) return;
    if (event.data.project_id !== this.session.project_id || event.data.nonce !== this.handshakeNonce) return;

    const channel = new MessageChannel();
    channel.port1.onmessage = this.handlePortMessage;
    channel.port1.start();
    this.messagePort = channel.port1;
    const message: AutofillFrameMessage<{
      session_token: string;
      bootstrap_url: string;
      parent_origin: string;
    }> = {
      protocol: "consulta-autofill",
      version: AUTOFILL_PROTOCOL_VERSION,
      type: "parent.session",
      project_id: this.session.project_id,
      session_id: this.session.session_id,
      nonce: this.handshakeNonce,
      payload: {
        session_token: this.session.session_token,
        bootstrap_url: this.session.bootstrap_url,
        parent_origin: window.location.origin,
      },
    };
    this.iframe.contentWindow?.postMessage(message, this.embedOrigin, [channel.port2]);
  };

  private readonly handlePortMessage = (event: MessageEvent<unknown>): void => {
    try {
      if (!this.session || !this.handshakeNonce || !this.messagePort || !isAutofillFrameMessage(event.data)) return;
      const message = event.data;
      if (
        message.project_id !== this.session.project_id ||
        message.session_id !== this.session.session_id ||
        message.nonce !== this.handshakeNonce
      ) {
        return;
      }

      if (message.type === "embed.payload") {
        void this.decodePayload(message);
        return;
      }
      if (message.type === "embed.metric") {
        if (isEmbedMetricMessage(message)) this.reportMetric(message.payload.event);
        return;
      }
      if (message.type === "embed.confirm") {
        this.confirmFields(message);
        return;
      }
      if (message.type === "embed.cancel") this.close();
    } catch (error) {
      this.postError(error instanceof Error ? error.message : "Não foi possível processar a mensagem do Autofill.");
    }
  };

  private async decodePayload(message: AutofillFrameMessage): Promise<void> {
    if (!this.session || !this.messagePort) return;
    const payload = message.payload;
    if (!isRecord(payload) || typeof payload.payload_base64 !== "string" || typeof payload.include_photo !== "boolean") {
      this.postError("O embed enviou um payload de leitura inválido.");
      return;
    }

    this.requestAbort = new AbortController();
    try {
      const response = await fetch(this.partnerEndpoint("decode"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: AUTOFILL_PROTOCOL_VERSION,
          session_token: this.session.session_token,
          payload_base64: payload.payload_base64,
          include_photo: payload.include_photo,
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
      this.post("parent.result", body.data);
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") this.postError(error instanceof Error ? error.message : "Falha no decode.");
    } finally {
      this.requestAbort = null;
    }
  }

  private confirmFields(message: AutofillFrameMessage): void {
    if (!isRecord(message.payload) || !isRecord(message.payload.fields) || !this.session) {
      this.postError("A confirmação de campos é inválida.");
      return;
    }
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(message.payload.fields)) {
      if (typeof value === "string") fields[key] = value;
    }
    const result: AutofillDecodedDocument = isDecodedDocument(message.payload.document)
      ? message.payload.document
      : { type: "cnh-e", label: "Documento" };
    const detail = this.fillFields(fields, result);
    this.reportMetric("confirmed");
    this.emit("consulta:confirmed", { document: result, field_keys: Object.keys(fields) });
    this.reportMetric("filled");
    this.emit("consulta:filled", detail);
    this.close();
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

  private post(type: AutofillFrameMessage["type"], payload?: unknown): void {
    if (!this.session || !this.handshakeNonce || !this.messagePort) return;
    this.messagePort.postMessage({
      protocol: "consulta-autofill",
      version: AUTOFILL_PROTOCOL_VERSION,
      type,
      project_id: this.session.project_id,
      session_id: this.session.session_id,
      nonce: this.handshakeNonce,
      payload,
    } satisfies AutofillFrameMessage);
  }

  private postError(message: string): void {
    this.reportMetric("error");
    this.emitError(message);
    this.post("parent.error", { message });
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
        endpoint.origin !== window.location.origin ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
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

  private isLocalDevelopmentHost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.modal) {
      event.preventDefault();
      this.close();
    }
  };

  /** Keeps a modal dialog modal even when the trigger lives inside nested Shadow DOM. */
  private readonly handleFocusIn = (event: FocusEvent): void => {
    const modal = this.modal;
    if (!modal || event.composedPath().includes(modal)) return;
    if (this.iframe) this.iframe.focus();
    else modal.querySelector<HTMLElement>(".dialog")?.focus();
  };
}

export function defineConsultaAutofill(): void {
  if (typeof window === "undefined" || customElements.get(ELEMENT_NAME)) return;
  customElements.define(ELEMENT_NAME, ConsultaAutofillElement);
}
