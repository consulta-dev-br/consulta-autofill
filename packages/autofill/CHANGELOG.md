# @consulta-dev/autofill

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
