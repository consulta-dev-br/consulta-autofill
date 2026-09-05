import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("opens one direct card in a native field without an iframe or nested chrome", async ({ page }, testInfo) => {
  const origin = "http://127.0.0.1:4173";
  const projectId = "pub_12345678";
  const sessionId = "afs_12345678";
  const triggerLabel = "Abrir Scanner de Câmera para preencher nome";
  const moduleUrl = `/@fs/${resolve(import.meta.dirname, "..", "packages", "autofill", "src", "index.ts")}`;

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
          direct_scanner_url: `${origin}/src/direct-entry.ts`,
          allowed_document_types: ["cnh-e", "cin", "other"],
          photo_enabled: true,
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
          allowed_document_types: ["cnh-e", "cin", "other"],
          photo_enabled: true,
          branding: {
            mode: "consulta",
            name: "Consulta Autofill",
            accent_color: "#155EEF",
            show_powered_by: true,
          },
          presentation: { layout: "compact" },
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
  const decodeBodies: unknown[] = [];
  await page.route("**/api/consulta-autofill/decode", async (route) => {
    decodeBodies.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        request_id: "req_decode_12345678",
        data: {
          document: { type: "cin", label: "Carteira de Identidade Nacional" },
          fields: {
            full_name: "Pessoa Sintética",
            cpf: "000.000.000-00",
            datanascimento: "01/02/1990",
            dataemissao: "01/01/2025",
            sexo: "Não informado",
            nacionalidade: "Brasileira",
            naturalidade: "Cidade sintética",
            validade: "01/01/2035",
            certidao: "Registro sintético",
            filiacao_1: "Pessoa responsável um",
            filiacao_2: "Pessoa responsável dois",
            hash: "hash-sintetico",
            local: "Local sintético",
            nome_social: "",
            orgao_expedidor: "Órgão sintético",
          },
          photo: {
            mime_type: "image/png",
            base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLq0QAAAABJRU5ErkJggg==",
          },
        },
      }),
    });
  });

  await page.goto(`${origin}/`);
  await page.evaluate(() => {
    window.addEventListener("consulta:confirmed", (event) => {
      (window as Window & { __consultaConfirmedFieldKeys?: string[] }).__consultaConfirmedFieldKeys = (
        event as CustomEvent<{ field_keys: string[] }>
      ).detail.field_keys;
    });
  });
  await page.evaluate(async ({ componentUrl, label, evaluatedProjectId }) => {
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
    field.setAttribute("document-type", "auto");
    field.setAttribute("label", label);
    const input = document.createElement("input");
    input.id = "nome";
    input.name = "name";
    input.dataset.consultaField = "full_name";
    field.append(input);
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

  await trigger.click();
  await expect(page.getByRole("heading", { name: "Como prefere ler o documento?" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Usar câmera/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Enviar imagem/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Enviar PDF/ })).toBeVisible();
  await expect(page.getByText("Powered by consulta.dev.br", { exact: true })).toBeVisible();
  await expect(page.locator('iframe[title="Scanner Consulta Autofill"]')).toHaveCount(0);

  const modal = await page.evaluate(() => {
    const field = document.querySelector<HTMLElement>("consulta-autofill-field");
    const autofill = field?.shadowRoot?.querySelector<HTMLElement>("consulta-autofill");
    const dialog = autofill?.shadowRoot?.querySelector<HTMLElement>(".dialog");
    return {
      cards: dialog?.querySelectorAll(".card").length,
      iframes: dialog?.querySelectorAll("iframe").length,
      headers: dialog?.querySelectorAll("header").length,
      closeButtons: dialog?.querySelectorAll('button[aria-label^="Fechar"]').length,
      loadingCards: dialog?.querySelectorAll(".loading").length,
      poweredInsideCard: Boolean(dialog?.querySelector(".card .powered")),
      verticalScroller: getComputedStyle(dialog?.querySelector<HTMLElement>(".card") ?? document.body).overflowY,
    };
  });
  expect(modal).toEqual({
    cards: 1,
    iframes: 0,
    headers: 0,
    closeButtons: 1,
    loadingCards: 0,
    poweredInsideCard: true,
    verticalScroller: "auto",
  });

  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#outside-focus-target")?.focus());
  await expect.poll(async () => page.evaluate(() => {
    const field = document.querySelector<HTMLElement>("consulta-autofill-field");
    const autofill = field?.shadowRoot?.querySelector<HTMLElement>("consulta-autofill");
    return autofill?.shadowRoot?.activeElement?.tagName;
  })).toBe("BUTTON");

  await page.evaluate(async () => {
    type ScannerHarness = {
      imageDataFromFile(file: Blob): Promise<ImageData>;
      scanImage(image: ImageData): Promise<Uint8Array | null>;
      scanFile(file: File): Promise<void>;
    };
    const field = document.querySelector<HTMLElement>("consulta-autofill-field");
    const autofill = field?.shadowRoot?.querySelector<HTMLElement>("consulta-autofill");
    const scanner = (autofill as unknown as { scanner: ScannerHarness }).scanner;
    scanner.imageDataFromFile = async () => new ImageData(1, 1);
    scanner.scanImage = async () => Uint8Array.of(1, 2, 3, 4);
    await scanner.scanFile(new File(["synthetic"], "documento.png", { type: "image/png" }));
  });
  await expect(page.getByRole("heading", { name: "Confira antes de preencher" })).toBeVisible();
  await expect(page.getByLabel("Data de nascimento")).toHaveValue("01/02/1990");
  await expect(page.getByLabel("Data de emissão")).toHaveValue("01/01/2025");
  await expect(page.getByText("Ver 9 campos adicionais", { exact: true })).toBeVisible();
  await page.getByText("Ver 9 campos adicionais", { exact: true }).click();
  await expect(page.getByLabel("Certidão")).toHaveValue("Registro sintético");
  await expect(page.getByLabel("Órgão expedidor")).toHaveValue("Órgão sintético");
  await expect(page.getByAltText("Foto retornada pelo documento")).toBeVisible();
  await expect(page.getByRole("heading", { name: "QR Code encontrado" })).toHaveCount(0);
  expect(decodeBodies).toHaveLength(1);
  expect(decodeBodies[0]).toMatchObject({ include_photo: true });

  const desktopLayout = await page.evaluate(() => {
    const field = document.querySelector<HTMLElement>("consulta-autofill-field");
    const autofill = field?.shadowRoot?.querySelector<HTMLElement>("consulta-autofill");
    const dialog = autofill?.shadowRoot?.querySelector<HTMLElement>(".dialog");
    const review = dialog?.querySelector<HTMLElement>(".review-content");
    const fields = dialog?.querySelector<HTMLElement>(".review-fields");
    return {
      hasPhoto: review?.classList.contains("has-photo"),
      reviewColumns: getComputedStyle(review ?? document.body).gridTemplateColumns.split(" ").filter(Boolean).length,
      fieldColumns: getComputedStyle(fields ?? document.body).gridTemplateColumns.split(" ").filter(Boolean).length,
    };
  });
  const initialColumns = testInfo.project.name.startsWith("mobile-") ? 1 : 2;
  expect(desktopLayout).toEqual({ hasPhoto: true, reviewColumns: initialColumns, fieldColumns: initialColumns });

  if (!testInfo.project.name.startsWith("mobile-")) {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => page.evaluate(() => {
      const field = document.querySelector<HTMLElement>("consulta-autofill-field");
      const autofill = field?.shadowRoot?.querySelector<HTMLElement>("consulta-autofill");
      const dialog = autofill?.shadowRoot?.querySelector<HTMLElement>(".dialog");
      const review = dialog?.querySelector<HTMLElement>(".review-content");
      const fields = dialog?.querySelector<HTMLElement>(".review-fields");
      return {
        reviewColumns: getComputedStyle(review ?? document.body).gridTemplateColumns.split(" ").filter(Boolean).length,
        fieldColumns: getComputedStyle(fields ?? document.body).gridTemplateColumns.split(" ").filter(Boolean).length,
      };
    })).toEqual({ reviewColumns: 1, fieldColumns: 1 });
  }

  await page.getByRole("button", { name: "Preencher formulário", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Confira antes de preencher" })).toHaveCount(0);
  const confirmedFieldKeys = await page.evaluate(() => (
    window as Window & { __consultaConfirmedFieldKeys?: string[] }
  ).__consultaConfirmedFieldKeys ?? []);
  expect(confirmedFieldKeys).toHaveLength(15);
  expect(confirmedFieldKeys).toEqual(expect.arrayContaining(["full_name", "certidao", "filiacao_1", "orgao_expedidor"]));
  await expect.poll(() => metricBodies.map((body) => (body as { event?: string }).event).sort()).toEqual([
    "closed", "confirmed", "decoded", "filled", "opened", "qr_found",
  ]);
  const serializedMetrics = JSON.stringify(metricBodies);
  expect(serializedMetrics).not.toContain("full_name");
  expect(serializedMetrics).not.toContain("project_id");

  if (testInfo.project.name.startsWith("mobile-")) {
    await expect.poll(() => page.locator("form").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
});
