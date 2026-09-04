import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

type ContractSchema = {
  $id: string;
};

const schema = JSON.parse(
  readFileSync(new URL("../packages/autofill/contracts/v1/autofill.schema.json", import.meta.url), "utf8"),
) as ContractSchema;

function validator(definition: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  const result = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  if (!result) throw new Error(`Missing schema definition: ${definition}`);
  return result;
}

describe("Autofill v1 JSON Schema", () => {
  it("accepts a partner session request and response", () => {
    const validateRequest = validator("sessionCreateRequest");
    const validateResponse = validator("sessionSuccessResponse");

    expect(validateRequest({ protocol_version: 1, document_type: "auto" })).toBe(true);
    expect(
      validateResponse({
        success: true,
        request_id: "req_12345678",
        data: {
          session_id: "afs_12345678",
          session_token: "a".repeat(32),
          project_id: "pub_12345678",
          expires_at: "2026-09-03T12:00:00.000Z",
          embed_url: "https://embed.consulta.dev.br/v1",
          bootstrap_url: "https://consulta.dev.br/api/v1/autofill/embed/bootstrap",
          allowed_document_types: ["cnh-e", "crlv-e"],
          photo_enabled: false,
        },
      }),
    ).toBe(true);
  });

  it("accepts a decoded response without a photo by default", () => {
    const validate = validator("decodeSuccessResponse");

    expect(
      validate({
        success: true,
        request_id: "req_12345678",
        data: {
          document: { type: "cnh-e", label: "CNH-e" },
          fields: { full_name: "Pessoa de Teste", cpf: "00000000000" },
          photo: null,
        },
      }),
    ).toBe(true);
  });

  it("accepts only fixed, PII-free lifecycle metric events", () => {
    const validateRequest = validator("metricRequest");
    const validateResponse = validator("metricSuccessResponse");

    expect(validateRequest({
      protocol_version: 1,
      session_token: "a".repeat(32),
      event: "filled",
    })).toBe(true);
    expect(validateResponse({
      success: true,
      data: { accepted: true },
      request_id: "req_12345678",
    })).toBe(true);
    expect(validateRequest({
      protocol_version: 1,
      session_token: "a".repeat(32),
      event: "filled",
      fields: { cpf: "00000000000" },
    })).toBe(false);
    expect(validateRequest({
      protocol_version: 1,
      session_token: "a".repeat(32),
      event: "unknown",
    })).toBe(false);
  });

  it("keeps iframe branding server-owned and plan-safe", () => {
    const validate = validator("embedBootstrapSuccessResponse");
    const response = {
      success: true,
      request_id: "req_12345678",
      data: {
        protocol_version: 1,
        project_id: "pub_12345678",
        session_id: "afs_12345678",
        expires_at: "2026-09-03T12:00:00.000Z",
        allowed_document_types: ["cnh-e", "crlv-e"],
        photo_enabled: false,
        branding: {
          mode: "partner",
          name: "Cadastros Acme",
          accent_color: "#7C3AED",
          show_powered_by: false,
        },
        presentation: { layout: "compact" },
      },
    };

    expect(validate(response)).toBe(true);
    expect(validate({
      ...response,
      data: {
        ...response.data,
        branding: { ...response.data.branding, show_powered_by: true },
      },
    })).toBe(false);
    expect(validate({
      ...response,
      data: { ...response.data, presentation: { layout: "icons-only" } },
    })).toBe(false);
  });

  it("rejects browser-controlled project identifiers and unsupported fields", () => {
    const validateSessionRequest = validator("sessionCreateRequest");
    const validateDecodeRequest = validator("decodeRequest");

    expect(
      validateSessionRequest({
        protocol_version: 1,
        document_type: "auto",
        project_id: "pub_12345678",
      }),
    ).toBe(false);
    expect(
      validateDecodeRequest({
        protocol_version: 1,
        session_token: "a".repeat(32),
        payload_base64: "not base64!",
        include_photo: false,
      }),
    ).toBe(false);
  });

  it("keeps error responses safe and versioned", () => {
    const validate = validator("errorResponse");

    expect(
      validate({
        success: false,
        request_id: "req_12345678",
        error: { code: "AUTOFILL_BETA_REQUIRED", message: "O beta exige aprovação.", retryable: false },
      }),
    ).toBe(true);
    expect(
      validate({
        success: false,
        request_id: "req_12345678",
        error: { code: "UNKNOWN", message: "Erro", retryable: false },
      }),
    ).toBe(false);
  });
});
