import { describe, expect, it } from "vitest";
import {
  AUTOFILL_MAX_DECODED_FIELDS,
  AUTOFILL_MAX_FIELD_VALUE_CHARS,
  isAutofillDecodeData,
} from "./protocol.js";

const validResult = {
  document: { type: "cnh-e", label: "CNH-e" },
  fields: { full_name: "Pessoa Sintética" },
  photo: null,
};

describe("decoded Autofill result", () => {
  it("accepts the bounded v1 result contract", () => {
    expect(isAutofillDecodeData(validResult)).toBe(true);
  });

  it("rejects fields outside the v1 bounds before they reach the scanner review", () => {
    const tooManyFields = Object.fromEntries(
      Array.from({ length: AUTOFILL_MAX_DECODED_FIELDS + 1 }, (_, index) => [`field_${index}`, "valor"]),
    );
    expect(isAutofillDecodeData({ ...validResult, fields: tooManyFields })).toBe(false);
    expect(isAutofillDecodeData({
      ...validResult,
      fields: { full_name: "x".repeat(AUTOFILL_MAX_FIELD_VALUE_CHARS + 1) },
    })).toBe(false);
  });

  it("accepts only bounded, standard base64 review photos", () => {
    expect(isAutofillDecodeData({
      ...validResult,
      photo: { mime_type: "image/png", base64: "QUJDRA==" },
    })).toBe(true);
    expect(isAutofillDecodeData({
      ...validResult,
      photo: { mime_type: "image/png", base64: "not base64!" },
    })).toBe(false);
    expect(isAutofillDecodeData({
      ...validResult,
      photo: { mime_type: "image/png", base64: "QUJDRA==", browser_supplied: true },
    })).toBe(false);
  });
});
