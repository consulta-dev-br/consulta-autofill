import "dotenv/config";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";

function loadConfig(environment = process.env) {
  const config = {
    port: Number(environment.PORT || 3000),
    apiBaseUrl: (environment.CONSULTA_API_BASE_URL || "https://consulta.dev.br").replace(/\/$/, ""),
    apiKey: environment.CONSULTA_API_KEY || "",
    projectId: environment.CONSULTA_PROJECT_ID || "",
    partnerOrigin: environment.CONSULTA_PARTNER_ORIGIN || "",
  };
  if (!config.apiKey || !config.projectId || !config.partnerOrigin) {
    throw new Error("Defina CONSULTA_API_KEY, CONSULTA_PROJECT_ID e CONSULTA_PARTNER_ORIGIN no ambiente do servidor.");
  }
  return config;
}

const sessionSchema = z.object({
  protocol_version: z.literal(1),
  document_type: z.enum(["auto", "cnh-e", "crlv-e", "cin", "other"]),
}).strict();
const decodeSchema = z.object({
  protocol_version: z.literal(1),
  session_token: z.string().min(32).max(4096),
  payload_base64: z.string().min(4).max(1_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  include_photo: z.boolean(),
}).strict();
const metricSchema = z.object({
  protocol_version: z.literal(1),
  session_token: z.string().min(32).max(4096),
  event: z.enum([
    "opened", "camera_requested", "camera_granted", "camera_denied", "qr_found",
    "decoded", "confirmed", "filled", "closed", "error",
  ]),
}).strict();

function apiError(code, message, status = 400) {
  return { status, body: { success: false, error: { code, message, retryable: status >= 500 }, request_id: "partner_local" } };
}

/**
 * The bridge is intentionally closed until the partner wires its existing
 * server-side session/RBAC middleware here. Never decide access from browser
 * fields, a public project id, or a shared client token.
 */
export async function authorizePartnerAccess(req) {
  void req;
  return false;
}

/** Creates a bridge app without binding a network port, so the same handler is testable. */
export function createApp(
  config = loadConfig(),
  fetchImplementation = globalThis.fetch,
  { authorize = authorizePartnerAccess } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb", type: "application/json" }));

  async function requirePartnerAccess(req, res, next) {
    try {
      if (await authorize(req)) return next();
    } catch {
      // An unavailable identity provider must not open the bridge.
    }
    const error = apiError("UNAUTHENTICATED", "Não autorizado.", 401);
    return res.status(error.status).json(error.body);
  }

  function requireSamePartnerOrigin(req, res, next) {
    const origin = req.get("origin");
    if (origin !== config.partnerOrigin) {
      const error = apiError("INVALID_ORIGIN", "Origem não autorizada.", 403);
      return res.status(error.status).json(error.body);
    }
    return next();
  }

  async function forward(path, body) {
    const response = await fetchImplementation(`${config.apiBaseUrl}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
        "X-Consulta-Product": "autofill",
        "X-Consulta-Project-ID": config.projectId,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  }

  function relay(path, schema, transform) {
    return async (req, res) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        const error = apiError("INVALID_REQUEST", "A requisição Autofill é inválida.");
        return res.status(error.status).json(error.body);
      }
      try {
        const result = await forward(path, transform(parsed.data));
        res.set("Cache-Control", "no-store");
        return res.status(result.status).json(result.data || apiError("UPSTREAM_UNAVAILABLE", "Serviço temporariamente indisponível.", 503).body);
      } catch (error) {
        // Não imprima req.body, token, QR ou dados de documento nos logs.
        console.error("consulta_autofill_upstream_failed", { path, reason: error instanceof Error ? error.name : "unknown" });
        const unavailable = apiError("UPSTREAM_UNAVAILABLE", "Serviço temporariamente indisponível.", 503);
        return res.status(unavailable.status).json(unavailable.body);
      }
    };
  }

  const sessionLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
  const decodeLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
  const metricsLimit = rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: "draft-8", legacyHeaders: false });

  app.post("/api/consulta-autofill/session", requireSamePartnerOrigin, requirePartnerAccess, sessionLimit,
    relay("/api/v1/autofill/sessions", sessionSchema, (body) => ({ ...body, partner_origin: config.partnerOrigin })));
  app.post("/api/consulta-autofill/decode", requireSamePartnerOrigin, requirePartnerAccess, decodeLimit,
    relay("/api/v1/autofill/decode", decodeSchema, (body) => body));
  app.post("/api/consulta-autofill/metrics", requireSamePartnerOrigin, requirePartnerAccess, metricsLimit,
    relay("/api/v1/autofill/metrics", metricSchema, (body) => body));

  app.use((error, _req, res, _next) => {
    void _next;
    if (error instanceof SyntaxError) {
      const response = apiError("INVALID_REQUEST", "JSON inválido.");
      return res.status(response.status).json(response.body);
    }
    const response = apiError("INTERNAL_ERROR", "Erro interno.", 500);
    return res.status(response.status).json(response.body);
  });

  return app;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const config = loadConfig();
  createApp(config).listen(config.port, () => console.info(`Consulta Autofill partner bridge listening on :${config.port}`));
}
