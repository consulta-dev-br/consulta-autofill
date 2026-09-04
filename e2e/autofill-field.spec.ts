import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

const origin = "http://127.0.0.1:4173";
const moduleUrl = `/@fs/${resolve(import.meta.dirname, "..", "packages", "autofill", "src", "index.ts")}`;

test("places an accessible camera trigger in a native field and fills through the hosted review", async ({ page }, testInfo) => {
  const projectId = "pub_12345678";
  const sessionId = "afs_12345678";
  const triggerLabel = "Abrir Scanner de Câmera para preencher nome";

  await page.route("**/api/consulta-autofill/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        request_id: "req_session_12345678",
        data: {
          session_id: sessionId,
          session_token: "s".repeat(32),
          project_id: projectId,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          embed_url: `${origin}/`,
          bootstrap_url: `${origin}/api/v1/autofill/embed/bootstrap`,
          allowed_document_types: ["cnh-e"],
          photo_enabled: false,
        },
      }),
    });
  });
  await page.route("**/api/v1/autofill/embed/bootstrap", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        request_id: "req_bootstrap_12345678",
        data: {
          protocol_version: 1,
          project_id: projectId,
          session_id: sessionId,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          allowed_document_types: ["cnh-e"],
          photo_enabled: false,
        },
      }),
    });
  });
  const metricBodies: unknown[] = [];
  await page.route("**/api/consulta-autofill/metrics", async (route) => {
    metricBodies.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { accepted: true }, request_id: "req_metric_12345678" }),
    });
  });

  await page.goto(`${origin}/`);
  await page.evaluate(async ({ componentUrl, label, evaluatedProjectId }) => {
    type CaptureWindow = Window & typeof globalThis & {
      __consultaAutofillFilled?: { filled?: string[]; preserved?: string[] };
      __consultaAutofillDocumentFilled?: { filled?: string[]; preserved?: string[] };
      __consultaAutofillPort?: MessagePort;
      __consultaNativeMessageChannel?: typeof MessageChannel;
    };
    const state = window as CaptureWindow;
    const NativeMessageChannel = window.MessageChannel;
    state.__consultaNativeMessageChannel = NativeMessageChannel;
    Object.defineProperty(window, "MessageChannel", {
      configurable: true,
      writable: true,
      value: function CapturingMessageChannel() {
        const channel = new NativeMessageChannel();
        state.__consultaAutofillPort = channel.port1;
        return channel;
      },
    });

    await import(componentUrl);
    const form = document.createElement("form");
    form.id = "cadastro";
    const fieldLabel = document.createElement("label");
    fieldLabel.htmlFor = "nome";
    fieldLabel.textContent = "Nome completo";
    const field = document.createElement("consulta-autofill-field");
    field.setAttribute("project-id", evaluatedProjectId);
    field.setAttribute("endpoint", "/api/consulta-autofill");
    field.setAttribute("metrics-endpoint", "/api/consulta-autofill/metrics");
    field.setAttribute("document-type", "cnh-e");
    field.setAttribute("label", label);
    const input = document.createElement("input");
    input.id = "nome";
    input.name = "name";
    input.dataset.consultaField = "full_name";
    field.append(input);
    field.addEventListener("consulta:filled", (event) => {
      state.__consultaAutofillFilled = (event as CustomEvent<{ filled?: string[]; preserved?: string[] }>).detail;
    });
    document.addEventListener("consulta:filled", (event) => {
      state.__consultaAutofillDocumentFilled = (event as CustomEvent<{ filled?: string[]; preserved?: string[] }>).detail;
    });
    form.append(fieldLabel, field);
    const outside = document.createElement("button");
    outside.id = "outside-focus-target";
    outside.type = "button";
    outside.textContent = "Fora do modal";
    document.body.replaceChildren(form, outside);
  }, { componentUrl: moduleUrl, label: triggerLabel, evaluatedProjectId: projectId });

  const trigger = page.getByRole("button", { name: triggerLabel });
  const input = page.locator("#nome");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("title", triggerLabel);
  await expect.poll(() => input.evaluate((element) => parseFloat(getComputedStyle(element).paddingInlineEnd))).toBeGreaterThan(40);
  await expect(page.locator("form").locator("input[data-consulta-field]")).toHaveCount(1);

  await trigger.click();
  const iframe = page.locator('iframe[title="Scanner Consulta Autofill"]');
  await expect(iframe).toBeVisible();
  const source = await iframe.getAttribute("src");
  expect(source).not.toBeNull();
  const nonce = new URL(source ?? origin).searchParams.get("nonce");
  expect(nonce).not.toBeNull();

  const frame = page.frameLocator('iframe[title="Scanner Consulta Autofill"]');
  await expect(frame.getByRole("heading", { name: "Como prefere ler o documento?" })).toBeVisible();
  const outerDialog = await page.evaluate(() => {
    const field = document.querySelector<HTMLElement>("consulta-autofill-field");
    const autofill = field?.shadowRoot?.querySelector<HTMLElement>("consulta-autofill");
    return {
      hasHeader: Boolean(autofill?.shadowRoot?.querySelector(".dialog-header")),
      hasOuterClose: Boolean(autofill?.shadowRoot?.querySelector('button[aria-label="Fechar scanner"]')),
    };
  });
  expect(outerDialog).toEqual({ hasHeader: false, hasOuterClose: false });
  const focusedTagName = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#outside-focus-target")?.focus();
    const field = document.querySelector<HTMLElement>("consulta-autofill-field");
    const autofill = field?.shadowRoot?.querySelector<HTMLElement>("consulta-autofill");
    return autofill?.shadowRoot?.activeElement?.tagName;
  });
  expect(focusedTagName).toBe("IFRAME");
  await expect.poll(async () => page.evaluate(() => {
    const state = window as Window & { __consultaAutofillPort?: MessagePort };
    return Boolean(state.__consultaAutofillPort);
  })).toBe(true);

  await page.evaluate(({ evaluatedProjectId, evaluatedSessionId, evaluatedNonce }) => {
    const state = window as Window & { __consultaAutofillPort?: MessagePort };
    state.__consultaAutofillPort?.postMessage({
      protocol: "consulta-autofill",
      version: 1,
      type: "parent.result",
      project_id: evaluatedProjectId,
      session_id: evaluatedSessionId,
      nonce: evaluatedNonce,
      payload: {
        document: { type: "cnh-e", label: "CNH-e" },
        fields: { full_name: "Pessoa Sintética" },
        photo: null,
      },
    });
  }, { evaluatedProjectId: projectId, evaluatedSessionId: sessionId, evaluatedNonce: nonce });

  await expect(frame.getByRole("heading", { name: "Confira antes de preencher" })).toBeVisible();
  await frame.getByRole("button", { name: "Preencher formulário" }).click();
  await expect.poll(async () => page.evaluate(() => {
    const state = window as Window & {
      __consultaAutofillDocumentFilled?: { filled?: string[] };
      __consultaAutofillFilled?: { filled?: string[] };
    };
    return { document: state.__consultaAutofillDocumentFilled?.filled, field: state.__consultaAutofillFilled?.filled };
  })).toEqual({ document: ["full_name"], field: ["full_name"] });
  await expect(input).toHaveValue("Pessoa Sintética");
  await expect(iframe).toHaveCount(0);
  const focusRestored = await page.evaluate(() => {
    const field = document.querySelector<HTMLElement>("consulta-autofill-field");
    const autofill = field?.shadowRoot?.querySelector<HTMLElement>("consulta-autofill");
    return {
      document: document.activeElement?.tagName || null,
      field: field?.shadowRoot?.activeElement?.tagName || null,
      autofill: autofill?.shadowRoot?.activeElement?.className || null,
    };
  });
  expect(focusRestored).toEqual({
    document: "CONSULTA-AUTOFILL-FIELD",
    field: "CONSULTA-AUTOFILL",
    autofill: "trigger trigger-icon",
  });
  await expect.poll(() => metricBodies.map((body) => (body as { event?: string }).event).sort()).toEqual([
    "closed",
    "confirmed",
    "filled",
    "opened",
  ]);
  const serializedMetrics = JSON.stringify(metricBodies);
  expect(serializedMetrics).not.toContain("Pessoa Sintética");
  expect(serializedMetrics).not.toContain("full_name");
  expect(serializedMetrics).not.toContain("payload_base64");
  expect(serializedMetrics).not.toContain("project_id");

  await page.evaluate(() => {
    const state = window as Window & { __consultaNativeMessageChannel?: typeof MessageChannel };
    if (state.__consultaNativeMessageChannel) window.MessageChannel = state.__consultaNativeMessageChannel;
  });

  if (testInfo.project.name.startsWith("mobile-")) {
    await expect.poll(() => page.locator("form").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
});
