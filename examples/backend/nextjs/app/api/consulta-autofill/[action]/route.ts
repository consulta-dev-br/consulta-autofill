export const runtime = "nodejs";

const MAX_BODY_BYTES = 1_000_000;
const MAX_METRIC_BODY_BYTES = 4_096;
const RATE_LIMITS = { session: 20, decode: 60, metrics: 180 } as const;

type Action = keyof typeof RATE_LIMITS;
type Settings = ReturnType<typeof config>;
type PartnerAccessVerifier = (request: Request) => boolean | Promise<boolean>;
type PartnerRateKeyResolver = (request: Request) => string | Promise<string>;
type LocalRateLimiter = {
  allow(scope: Action, key: string, limit: number): boolean;
};
type Forwarder = (settings: Settings, path: string, body: unknown) => Promise<{ status: number; body: unknown }>;

/**
 * The bridge intentionally starts closed. Replace this function with the
 * existing server-side session/RBAC check of the partner application before
 * exporting the handler to users. Never authorize from browser-controlled
 * fields, a project id, or a shared client token.
 */
export async function authorizePartnerAccess(request: Request): Promise<boolean> {
  void request;
  return false;
}

/** Small local guard for one process. Use a shared limiter in horizontal production. */
export function createLocalRateLimiter(now = () => Date.now()): LocalRateLimiter {
  const windows = new Map<string, number[]>();
  return {
    allow(scope, key, limit) {
      const identifier = `${scope}:${key}`;
      const current = now();
      const cutoff = current - 60_000;
      const values = (windows.get(identifier) || []).filter((value) => value > cutoff);
      if (values.length >= limit) {
        windows.set(identifier, values);
        return false;
      }
      values.push(current);
      windows.set(identifier, values);
      return true;
    },
  };
}

/**
 * Safe default for the deliberately fail-closed example. A production adapter
 * should return an opaque identifier derived from its established server-side
 * principal; it must never use a browser header, QR, token or form field.
 */
export function defaultPartnerRateKey(request: Request): string {
  void request;
  return "authenticated";
}

function normalizedRateKey(value: string): string {
  return /^[A-Za-z0-9:_-]{1,128}$/.test(value) ? value : "authenticated";
}

function isAction(value: string): value is Action {
  return value === "session" || value === "decode" || value === "metrics";
}

function config() {
  const apiBaseUrl = (process.env.CONSULTA_API_BASE_URL || "https://consulta.dev.br").replace(/\/$/, "");
  const apiKey = process.env.CONSULTA_API_KEY;
  const projectId = process.env.CONSULTA_PROJECT_ID;
  const partnerOrigin = process.env.CONSULTA_PARTNER_ORIGIN;
  if (!apiKey || !projectId || !partnerOrigin) throw new Error("Consulta Autofill server configuration is missing.");
  return { apiBaseUrl, apiKey, projectId, partnerOrigin };
}

function error(code: string, message: string, status = 400) {
  return Response.json(
    { success: false, error: { code, message, retryable: status >= 500 }, request_id: "partner_local" },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function validSessionBody(value: unknown): value is { protocol_version: 1; document_type: "auto" | "cnh-e" | "crlv-e" | "cin" | "other" } {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return body.protocol_version === 1 && ["auto", "cnh-e", "crlv-e", "cin", "other"].includes(String(body.document_type)) && Object.keys(body).length === 2;
}

function validDecodeBody(value: unknown): value is { protocol_version: 1; session_token: string; payload_base64: string; include_photo: boolean } {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return body.protocol_version === 1 && typeof body.session_token === "string" && body.session_token.length >= 32 && body.session_token.length <= 4096 &&
    typeof body.payload_base64 === "string" && body.payload_base64.length >= 4 && body.payload_base64.length <= MAX_BODY_BYTES && /^[A-Za-z0-9+/]+={0,2}$/.test(body.payload_base64) &&
    typeof body.include_photo === "boolean" && Object.keys(body).length === 4;
}

function validMetricBody(value: unknown): value is { protocol_version: 1; session_token: string; event: string } {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return body.protocol_version === 1 && typeof body.session_token === "string" && body.session_token.length >= 32 && body.session_token.length <= 4096 &&
    typeof body.event === "string" && ["opened", "camera_requested", "camera_granted", "camera_denied", "qr_found", "decoded", "confirmed", "filled", "closed", "error"].includes(body.event) &&
    Object.keys(body).length === 3;
}

async function requestJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const length = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(length) || length > maxBytes) throw new Error("PAYLOAD_TOO_LARGE");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("PAYLOAD_TOO_LARGE");
  return JSON.parse(text) as unknown;
}

async function forward(settings: Settings, path: string, body: unknown) {
  const response = await fetch(`${settings.apiBaseUrl}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": settings.apiKey,
      "X-Consulta-Product": "autofill",
      "X-Consulta-Project-ID": settings.projectId,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

export function createAutofillPostHandler({
  authorize = authorizePartnerAccess,
  rateLimiter = createLocalRateLimiter(),
  rateKey = defaultPartnerRateKey,
  forwardRequest = forward,
}: {
  authorize?: PartnerAccessVerifier;
  rateLimiter?: LocalRateLimiter;
  rateKey?: PartnerRateKeyResolver;
  forwardRequest?: Forwarder;
} = {}) {
  return async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
    let settings: Settings;
    try {
      settings = config();
    } catch {
      return error("INTERNAL_ERROR", "Configuração do Autofill indisponível.", 500);
    }
    const origin = request.headers.get("origin");
    if (origin !== settings.partnerOrigin) return error("INVALID_ORIGIN", "Origem não autorizada.", 403);

    const { action } = await context.params;
    if (!isAction(action)) return error("INVALID_REQUEST", "Ação Autofill não suportada.", 404);
    try {
      if (!await authorize(request)) return error("UNAUTHENTICATED", "Não autorizado.", 401);
    } catch {
      // Do not disclose session-provider errors to an unauthenticated browser.
      return error("UNAUTHENTICATED", "Não autorizado.", 401);
    }
    let key: string;
    try {
      key = normalizedRateKey(await rateKey(request));
    } catch {
      key = "authenticated";
    }
    if (!rateLimiter.allow(action, key, RATE_LIMITS[action])) {
      return error("RATE_LIMITED", "Muitas solicitações; tente novamente em breve.", 429);
    }

    try {
      let endpoint: string;
      let upstreamBody: unknown;
      if (action === "session") {
        const body = await requestJson(request);
        if (!validSessionBody(body)) return error("INVALID_REQUEST", "Sessão Autofill inválida.");
        endpoint = "/api/v1/autofill/sessions";
        upstreamBody = { ...body, partner_origin: settings.partnerOrigin };
      } else if (action === "decode") {
        const body = await requestJson(request);
        if (!validDecodeBody(body)) return error("INVALID_REQUEST", "Decode Autofill inválido.");
        endpoint = "/api/v1/autofill/decode";
        upstreamBody = body;
      } else {
        const body = await requestJson(request, MAX_METRIC_BODY_BYTES);
        if (!validMetricBody(body)) return error("INVALID_REQUEST", "Métrica Autofill inválida.");
        endpoint = "/api/v1/autofill/metrics";
        upstreamBody = body;
      }
      const upstream = await forwardRequest(settings, endpoint, upstreamBody);
      return Response.json(upstream.body || { success: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Serviço indisponível.", retryable: true }, request_id: "partner_local" }, {
        status: upstream.body ? upstream.status : 503,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (cause) {
      // Não logue request body, QR, token, imagem, foto ou campos.
      if (cause instanceof Error && cause.message === "PAYLOAD_TOO_LARGE") return error("INVALID_REQUEST", "Payload muito grande.", 413);
      if (cause instanceof SyntaxError) return error("INVALID_REQUEST", "JSON inválido.");
      return error("UPSTREAM_UNAVAILABLE", "Serviço temporariamente indisponível.", 503);
    }
  };
}

export const POST = createAutofillPostHandler();
