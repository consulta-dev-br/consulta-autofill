# @consulta-dev/qr-engine

## 0.1.8

## 0.1.7

## 0.1.6

### Patch Changes

- Adiciona um único controle acessível para fechar o card direto do Autofill, sem restaurar cabeçalho ou iframe.

## 0.1.5

### Patch Changes

- Keep the opening placeholder inside the scanner runtime container so it is
  removed before the compact card is rendered. This prevents a second visual
  surface from remaining below the direct scanner.

## 0.1.4

### Patch Changes

- Render the Autofill scanner directly inside the Web Component Shadow DOM. The
  first screen is now one compact card with local camera, image, and PDF choices,
  without an iframe or duplicated dialog chrome. The QR reader remains lazy and
  begins loading while the browser asks for camera permission.

## 0.1.3

### Patch Changes

- Compacta o scanner hospedado, carrega QR e PDF sob demanda e prepara o leitor QR enquanto a permissão da câmera é solicitada.

## 0.1.2

### Patch Changes

- 3c27c31: Remove the redundant outer scanner header and close control so the hosted
  iframe is presented as a single dialog.

## 0.1.1

### Patch Changes

- Inclui todos os módulos JavaScript necessários ao entrypoint em cada release imutável do CDN.

## 0.1.0

### Minor Changes

- 53a4308: Add the secure hosted Autofill flow: a Shadow DOM Web Component, origin-bound iframe handshake, local camera/image/PDF capture, explicit photo consent, reviewed field confirmation, and a QR-only ZXing reader adapter with a self-hosted WASM baseline.
- f2e6b69: Add a pinned, reproducible QR-only ZXing-C++ candidate recipe, a browser adapter with baseline fallback, CI artifact verification, a public synthetic parity check against `zxing-wasm`, and a Chromium performance/memory gate. QR extraction in the hosted embed now runs in an origin-owned Worker with transferred and cleared RGBA buffers. The candidate remains opt-in until promotion gates pass.
