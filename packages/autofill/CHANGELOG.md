# @consulta-dev/autofill

## 0.1.12

### Patch Changes

- Add CIN and decoder-recognized official documents to the Autofill v1 contract, scanner validation, and secure backend examples.

## 0.1.11

### Patch Changes

- Normalize compact decoded field names in the direct scanner review so standard CNH-e fields remain clear and usable for partner forms.

## 0.1.10

### Patch Changes

- Show an enabled document photo in a structured review: photo and two-column fields on desktop, compact photo and one-column fields on mobile.
- Request the photo automatically when the project explicitly enables it.

## 0.1.9

### Patch Changes

- Label the official CNH `acc` field as Autorização para Conduzir Ciclomotores (ACC) in the review screen.

## 0.1.8

### Patch Changes

- Remove the redundant manual camera-read action while the scanner continuously looks for a QR Code.

## 0.1.7

### Patch Changes

- Consultas iniciam automaticamente assim que o QR Code é encontrado, sem uma etapa intermediária de confirmação.

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
- fffb746: Add an optional same-origin metrics bridge for a PII-free Autofill lifecycle
  funnel, including camera permission, QR discovery, decode, confirmation, fill,
  close and error events.
- f189673: Define the public Consulta Autofill v1 contract with TypeScript exports and distributable JSON Schema for partner session, decode, error and iframe messages.
- 63d6e9a: Expose the `AUTOFILL_BETA_REQUIRED` error code so partners can handle beta availability safely.
- 5512c68: Add the server-owned Autofill branding contract used by the hosted iframe. The
  embed now falls back safely to Consulta branding and renders authorized
  partner branding without accepting browser-controlled configuration.
- 3f45b10: Add `consulta-autofill-field`, a native-field wrapper with an accessible camera trigger and Shadow DOM-aware form discovery for simplified CDN integrations.

### Patch Changes

- c4e85d4: Validate the full decoded-result bounds before rendering the iframe review,
  including field counts, value lengths, image type and bounded base64 photos.
