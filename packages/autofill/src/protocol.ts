/** Version shared by the Web Component, hosted embed and partner endpoint. */
export const AUTOFILL_PROTOCOL_VERSION = 1 as const;

export const AUTOFILL_DOCUMENT_TYPES = ["auto", "cnh-e", "crlv-e"] as const;
export const AUTOFILL_DECODED_DOCUMENT_TYPES = ["cnh-e", "crlv-e"] as const;
export const AUTOFILL_BRANDING_MODES = ["consulta", "partner"] as const;
/** Maximum number of editable values a decoded document may expose in v1. */
export const AUTOFILL_MAX_DECODED_FIELDS = 64;
/** Maximum UTF-16 code units per decoded field value in v1. */
export const AUTOFILL_MAX_FIELD_VALUE_CHARS = 4_096;
/** The optional review photo is bounded before it is decoded in the iframe. */
export const AUTOFILL_MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const AUTOFILL_MAX_PHOTO_BASE64_CHARS = 4 * Math.ceil(AUTOFILL_MAX_PHOTO_BYTES / 3);
/**
 * Fixed, privacy-safe lifecycle events. Values, field names, document data,
 * camera frames and browser identifiers are intentionally excluded.
 */
export const AUTOFILL_METRIC_EVENTS = [
  "opened",
  "camera_requested",
  "camera_granted",
  "camera_denied",
  "qr_found",
  "decoded",
  "confirmed",
  "filled",
  "closed",
  "error",
] as const;
/** Events that can only originate in the hosted iframe over its validated MessagePort. */
export const AUTOFILL_EMBED_METRIC_EVENTS = [
  "camera_requested",
  "camera_granted",
  "camera_denied",
  "qr_found",
  "error",
] as const;
export type AutofillDocumentType = (typeof AUTOFILL_DOCUMENT_TYPES)[number];
export type AutofillDecodedDocumentType = (typeof AUTOFILL_DECODED_DOCUMENT_TYPES)[number];
export type AutofillBrandingMode = (typeof AUTOFILL_BRANDING_MODES)[number];
export type AutofillMetricEvent = (typeof AUTOFILL_METRIC_EVENTS)[number];
export type AutofillEmbedMetricEvent = (typeof AUTOFILL_EMBED_METRIC_EVENTS)[number];

export const AUTOFILL_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "INVALID_API_KEY",
  "INVALID_PRODUCT",
  "INVALID_ORIGIN",
  "INVALID_SESSION",
  "SESSION_EXPIRED",
  "SESSION_REPLAYED",
  "SESSION_ATTEMPTS_EXCEEDED",
  "PROJECT_NOT_FOUND",
  "PROJECT_DISABLED",
  "AUTOFILL_BETA_REQUIRED",
  "DOCUMENT_NOT_ALLOWED",
  "PHOTO_NOT_ALLOWED",
  "CAMERA_DENIED",
  "CAMERA_UNAVAILABLE",
  "FILE_UNSUPPORTED",
  "QR_NOT_FOUND",
  "DECODE_FAILED",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;
export type AutofillErrorCode = (typeof AUTOFILL_ERROR_CODES)[number];

export interface AutofillError {
  code: AutofillErrorCode;
  message: string;
  retryable: boolean;
}

export interface AutofillErrorResponse {
  success: false;
  error: AutofillError;
  request_id: string;
}

/** Request emitted by the component to the partner's same-origin session endpoint. */
export interface AutofillSessionCreateRequest {
  protocol_version: typeof AUTOFILL_PROTOCOL_VERSION;
  document_type: AutofillDocumentType;
}

export interface AutofillSession {
  session_id: string;
  /** Opaque, short-lived credential. Never put it in a URL or log it. */
  session_token: string;
  project_id: string;
  expires_at: string;
  embed_url: string;
  /** Consulta endpoint that only the hosted iframe may call for bootstrap. */
  bootstrap_url: string;
  allowed_document_types: AutofillDecodedDocumentType[];
  /** True only when the project policy permits image delivery and the user confirms it. */
  photo_enabled: boolean;
}

export interface AutofillSessionSuccessResponse {
  success: true;
  data: AutofillSession;
  request_id: string;
}

export type AutofillSessionResponse = AutofillSessionSuccessResponse | AutofillErrorResponse;

/**
 * Best-effort event sent to the partner's optional same-origin metrics bridge.
 * The partner server adds credentials and the project binding before it reaches
 * Consulta. Do not add fields, document type, image, QR, error text or IDs.
 */
export interface AutofillMetricRequest {
  protocol_version: typeof AUTOFILL_PROTOCOL_VERSION;
  session_token: string;
  event: AutofillMetricEvent;
}

export interface AutofillMetricSuccessResponse {
  success: true;
  data: { accepted: true };
  request_id: string;
}

export type AutofillMetricResponse = AutofillMetricSuccessResponse | AutofillErrorResponse;

/** Display-only branding returned by the authenticated iframe bootstrap. */
export interface AutofillEmbedBranding {
  mode: AutofillBrandingMode;
  name: string;
  accent_color: string;
  show_powered_by: boolean;
}

/** Server-owned density preference for the hosted scanner's source selector. */
export type AutofillEmbedPresentationLayout = "compact" | "standard";

/**
 * Display-only configuration delivered by the authenticated iframe bootstrap.
 * It is intentionally not accepted from the partner browser integration.
 */
export interface AutofillEmbedPresentation {
  layout: AutofillEmbedPresentationLayout;
}

/** Internal hosted-frame bootstrap contract; it never travels through the partner browser API. */
export interface AutofillEmbedBootstrap {
  protocol_version: typeof AUTOFILL_PROTOCOL_VERSION;
  project_id: string;
  session_id: string;
  expires_at: string;
  allowed_document_types: AutofillDecodedDocumentType[];
  photo_enabled: boolean;
  branding: AutofillEmbedBranding;
  /** Omitted by older servers; hosted embeds safely default to compact. */
  presentation?: AutofillEmbedPresentation;
}

/** Request sent by the component to the partner after the embed extracts QR bytes. */
export interface AutofillDecodeRequest {
  protocol_version: typeof AUTOFILL_PROTOCOL_VERSION;
  session_token: string;
  payload_base64: string;
  /** User confirmation. The API still rejects it unless the project permits photos. */
  include_photo: boolean;
}

export interface AutofillPhoto {
  mime_type: "image/jpeg" | "image/png";
  base64: string;
}

export interface AutofillDecodedDocument {
  type: AutofillDecodedDocumentType;
  label: string;
}

export interface AutofillDecodeData {
  document: AutofillDecodedDocument;
  /** Values are normalized to strings before the form mapping/review step. */
  fields: Record<string, string>;
  photo: AutofillPhoto | null;
}

export interface AutofillDecodeSuccessResponse {
  success: true;
  data: AutofillDecodeData;
  request_id: string;
}

export type AutofillDecodeResponse = AutofillDecodeSuccessResponse | AutofillErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isBase64(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length >= 4
    && value.length <= maxLength
    && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

/** Validates the bounded decoded result before it crosses into the hosted iframe UI. */
export function isAutofillDecodeData(value: unknown): value is AutofillDecodeData {
  if (!isRecord(value) || !isRecord(value.document) || !isRecord(value.fields)) return false;
  if (!hasExactKeys(value, ["document", "fields", "photo"])) return false;
  const document = value.document;
  if (!hasExactKeys(document, ["type", "label"])) return false;
  if (
    (document.type !== "cnh-e" && document.type !== "crlv-e")
    || typeof document.label !== "string"
    || document.label.length < 1
    || document.label.length > 120
  ) {
    return false;
  }
  const entries = Object.entries(value.fields);
  if (entries.length > AUTOFILL_MAX_DECODED_FIELDS) return false;
  for (const [key, field] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || typeof field !== "string" || field.length > AUTOFILL_MAX_FIELD_VALUE_CHARS) {
      return false;
    }
  }
  if (value.photo === null) return true;
  return isRecord(value.photo)
    && hasExactKeys(value.photo, ["mime_type", "base64"])
    && (value.photo.mime_type === "image/jpeg" || value.photo.mime_type === "image/png")
    && isBase64(value.photo.base64, AUTOFILL_MAX_PHOTO_BASE64_CHARS);
}

export const AUTOFILL_FRAME_MESSAGE_TYPES = [
  "parent.session",
  "embed.payload",
  "parent.result",
  "parent.error",
  "parent.close",
  "embed.cancel",
  "embed.confirm",
  "embed.metric",
] as const;
export type AutofillFrameMessageType = (typeof AUTOFILL_FRAME_MESSAGE_TYPES)[number];

/** Initial message sent over window.postMessage before a MessagePort exists. */
export interface AutofillEmbedReadyMessage {
  protocol: "consulta-autofill";
  version: typeof AUTOFILL_PROTOCOL_VERSION;
  type: "embed.ready";
  project_id: string;
  nonce: string;
}

/**
 * Every cross-origin message must also be validated against event.origin and
 * event.source by the receiver. A valid shape alone is never a trust signal.
 */
export interface AutofillFrameMessage<TPayload = unknown> {
  protocol: "consulta-autofill";
  version: typeof AUTOFILL_PROTOCOL_VERSION;
  type: AutofillFrameMessageType;
  project_id: string;
  session_id: string;
  nonce: string;
  payload?: TPayload;
}

export function isAutofillFrameMessage(value: unknown): value is AutofillFrameMessage {
  if (!value || typeof value !== "object") return false;

  const message = value as Partial<AutofillFrameMessage>;
  return (
    message.protocol === "consulta-autofill" &&
    message.version === AUTOFILL_PROTOCOL_VERSION &&
    typeof message.type === "string" &&
    AUTOFILL_FRAME_MESSAGE_TYPES.includes(message.type as AutofillFrameMessageType) &&
    typeof message.project_id === "string" &&
    typeof message.session_id === "string" &&
    typeof message.nonce === "string"
  );
}

export function isAutofillEmbedReadyMessage(value: unknown): value is AutofillEmbedReadyMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<AutofillEmbedReadyMessage>;
  return (
    message.protocol === "consulta-autofill" &&
    message.version === AUTOFILL_PROTOCOL_VERSION &&
    message.type === "embed.ready" &&
    typeof message.project_id === "string" &&
    typeof message.nonce === "string"
  );
}
