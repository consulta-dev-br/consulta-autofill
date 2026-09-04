import { expect, test } from "@playwright/test";

test("loads the production embed and Worker below an immutable version path", async ({ page }) => {
  const origin = "http://127.0.0.1:4174";
  const shellUrl = `${origin}/embed/v0.0.0/index.html`;
  const projectId = "pub_12345678";
  const sessionId = "afs_12345678";
  const nonce = "b".repeat(32);
  const requestedPaths: string[] = [];
  const failedPaths: string[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) requestedPaths.push(url.pathname);
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) failedPaths.push(url.pathname);
  });
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
          allowed_document_types: ["cnh-e"],
          photo_enabled: false,
          presentation: { layout: "compact" },
        },
      }),
    });
  });

  await page.goto(shellUrl);
  await page.evaluate(({ evaluatedProjectId, evaluatedSessionId, evaluatedNonce, url }) => {
    window.addEventListener("message", (event) => {
      const message = event.data as Record<string, unknown>;
      if (event.origin !== window.location.origin || message.type !== "embed.ready") return;
      const channel = new MessageChannel();
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
    iframe.id = "versioned-embed";
    iframe.src = `${url}?project_id=${evaluatedProjectId}&nonce=${evaluatedNonce}&parent_origin=${encodeURIComponent(window.location.origin)}`;
    document.body.replaceChildren(iframe);
  }, { evaluatedProjectId: projectId, evaluatedSessionId: sessionId, evaluatedNonce: nonce, url: shellUrl });

  const frame = page.frameLocator("#versioned-embed");
  await expect(frame.getByRole("heading", { name: "Como prefere ler o documento?" })).toBeVisible();
  await expect(frame.locator(".actions-compact")).toBeVisible();
  await page.waitForTimeout(100);
  expect(requestedPaths.some((path) => /^\/embed\/v0\.0\.0\/assets\/qr-worker-[A-Za-z0-9_-]+\.js$/.test(path))).toBe(false);
  expect(requestedPaths.some((path) => /zxing_reader-[A-Za-z0-9_-]+\.wasm$/.test(path))).toBe(false);

  await frame.getByRole("button", { name: /Usar câmera/ }).click();
  await expect.poll(() => requestedPaths.some((path) => /^\/embed\/v0\.0\.0\/assets\/qr-worker-[A-Za-z0-9_-]+\.js$/.test(path))).toBe(true);
  expect(failedPaths).toEqual([]);
});
