import { expect, test } from "@playwright/test";

test("accepts only the origin-bound session handshake and presents private capture choices", async ({ page }, testInfo) => {
  const projectId = "pub_12345678";
  const sessionId = "afs_12345678";
  const nonce = "a".repeat(32);
  const origin = "http://127.0.0.1:4173";

  await page.route("**/api/v1/autofill/embed/bootstrap", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        request_id: "req_12345678",
        data: {
          protocol_version: 1,
          project_id: projectId,
          session_id: sessionId,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          allowed_document_types: ["cnh-e", "crlv-e", "cin", "other"],
          photo_enabled: true,
          branding: {
            mode: "consulta",
            name: "Consulta Autofill",
            accent_color: "#155EEF",
            show_powered_by: true,
          },
        },
      }),
    });
  });

  await page.goto(`${origin}/`);
  await page.evaluate(({ projectId: evaluatedProjectId, sessionId: evaluatedSessionId, nonce: evaluatedNonce }) => {
    window.addEventListener("message", (event) => {
      const message = event.data as Record<string, unknown>;
      if (
        event.origin !== window.location.origin ||
        message.type !== "embed.ready" ||
        message.project_id !== evaluatedProjectId ||
        message.nonce !== evaluatedNonce
      ) {
        return;
      }
      const channel = new MessageChannel();
      const windowState = window as Window & {
        __autofillPort?: MessagePort;
        __autofillMessage?: Record<string, unknown>;
      };
      windowState.__autofillPort = channel.port1;
      channel.port1.onmessage = (portEvent) => {
        windowState.__autofillMessage = portEvent.data as Record<string, unknown>;
      };
      channel.port1.start();
      const target = event.source as Window | null;
      target?.postMessage(
        {
          protocol: "consulta-autofill",
          version: 1,
          type: "parent.session",
          project_id: evaluatedProjectId,
          session_id: evaluatedSessionId,
          nonce: evaluatedNonce,
          payload: {
            session_token: "s".repeat(32),
            bootstrap_url: `${window.location.origin}/api/v1/autofill/embed/bootstrap`,
            parent_origin: window.location.origin,
          },
        },
        window.location.origin,
        [channel.port2],
      );
    });
    const iframe = document.createElement("iframe");
    iframe.id = "embed";
    iframe.src = `/?project_id=${evaluatedProjectId}&nonce=${evaluatedNonce}&parent_origin=${encodeURIComponent(window.location.origin)}`;
    document.body.replaceChildren(iframe);
  }, { projectId, sessionId, nonce });

  const frame = page.frameLocator("#embed");
  await expect(frame.getByRole("heading", { name: "Como prefere ler o documento?" })).toBeVisible();
  await expect(frame.getByText("Consulta Autofill", { exact: true })).toBeVisible();
  await expect(frame.getByText("Powered by consulta.dev.br", { exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Usar câmera" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Enviar imagem" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Enviar PDF" })).toBeVisible();

  await page.evaluate(({ projectId: evaluatedProjectId, sessionId: evaluatedSessionId, nonce: evaluatedNonce }) => {
    const windowState = window as Window & { __autofillPort?: MessagePort };
    windowState.__autofillPort?.postMessage({
      protocol: "consulta-autofill",
      version: 1,
      type: "parent.result",
      project_id: evaluatedProjectId,
      session_id: evaluatedSessionId,
      nonce: evaluatedNonce,
      payload: {
        document: { type: "cnh-e", label: "CNH-e" },
        fields: { full_name: "Pessoa Sintética", cpf: "00000000000" },
        photo: {
          mime_type: "image/png",
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLkWQAAAABJRU5ErkJggg==",
        },
      },
    });
  }, { projectId, sessionId, nonce });

  await expect(frame.getByRole("heading", { name: "Confira antes de preencher" })).toBeVisible();
  await frame.getByLabel("Nome completo").fill("Pessoa Editada");
  await frame.getByRole("button", { name: "Preencher formulário" }).click();
  await expect.poll(async () => page.evaluate(() => {
    const windowState = window as Window & { __autofillMessage?: { type?: string; payload?: { fields?: Record<string, string> } } };
    return windowState.__autofillMessage?.type;
  })).toBe("embed.confirm");
  await expect.poll(async () => page.evaluate(() => {
    const windowState = window as Window & { __autofillMessage?: { payload?: { fields?: Record<string, string> } } };
    return windowState.__autofillMessage?.payload?.fields?.full_name;
  })).toBe("Pessoa Editada");

  if (testInfo.project.name.startsWith("mobile-")) {
    await expect.poll(() => frame.locator("html").evaluate((root) => root.scrollWidth <= root.clientWidth + 1)).toBe(true);
  }
});

test("renders a server-authorized partner brand without accepting browser branding", async ({ page }) => {
  const projectId = "pub_87654321";
  const sessionId = "afs_87654321";
  const nonce = "b".repeat(32);
  const origin = "http://127.0.0.1:4173";

  await page.route("**/api/v1/autofill/embed/bootstrap", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        request_id: "req_87654321",
        data: {
          protocol_version: 1,
          project_id: projectId,
          session_id: sessionId,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          allowed_document_types: ["cnh-e"],
          photo_enabled: false,
          branding: {
            mode: "partner",
            name: "Cadastros Acme",
            accent_color: "#7C3AED",
            show_powered_by: false,
          },
          presentation: { layout: "standard" },
        },
      }),
    });
  });

  await page.goto(`${origin}/`);
  await page.evaluate(({ evaluatedProjectId, evaluatedSessionId, evaluatedNonce }) => {
    window.addEventListener("message", (event) => {
      const message = event.data as Record<string, unknown>;
      if (
        event.origin !== window.location.origin ||
        message.type !== "embed.ready" ||
        message.project_id !== evaluatedProjectId ||
        message.nonce !== evaluatedNonce
      ) return;
      const channel = new MessageChannel();
      channel.port1.start();
      const target = event.source as Window | null;
      target?.postMessage(
        {
          protocol: "consulta-autofill",
          version: 1,
          type: "parent.session",
          project_id: evaluatedProjectId,
          session_id: evaluatedSessionId,
          nonce: evaluatedNonce,
          payload: {
            session_token: "s".repeat(32),
            bootstrap_url: `${window.location.origin}/api/v1/autofill/embed/bootstrap`,
            parent_origin: window.location.origin,
            branding: { mode: "consulta" },
          },
        },
        window.location.origin,
        [channel.port2],
      );
    });
    const iframe = document.createElement("iframe");
    iframe.id = "partner-brand";
    iframe.src = `/?project_id=${evaluatedProjectId}&nonce=${evaluatedNonce}&parent_origin=${encodeURIComponent(window.location.origin)}`;
    document.body.replaceChildren(iframe);
  }, { evaluatedProjectId: projectId, evaluatedSessionId: sessionId, evaluatedNonce: nonce });

  const frame = page.frameLocator("#partner-brand");
  await expect(frame.getByRole("heading", { name: "Como prefere ler o documento?" })).toBeVisible();
  await expect(frame.locator(".actions-compact")).toHaveCount(0);
  await expect(frame.getByText("Aponte a câmera para o QR Code do documento.", { exact: true })).toBeVisible();
  await expect(frame.getByText("Cadastros Acme", { exact: true })).toBeVisible();
  await expect(frame.getByText("Powered by consulta.dev.br", { exact: true })).toBeHidden();
  await expect(frame.locator(".mark")).toHaveCSS("background-color", "rgb(124, 58, 237)");
});
