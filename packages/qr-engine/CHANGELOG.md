# @consulta-dev/qr-engine

## 0.1.0

### Minor Changes

- 53a4308: Add the secure hosted Autofill flow: a Shadow DOM Web Component, origin-bound iframe handshake, local camera/image/PDF capture, explicit photo consent, reviewed field confirmation, and a QR-only ZXing reader adapter with a self-hosted WASM baseline.
- f2e6b69: Add a pinned, reproducible QR-only ZXing-C++ candidate recipe, a browser adapter with baseline fallback, CI artifact verification, a public synthetic parity check against `zxing-wasm`, and a Chromium performance/memory gate. QR extraction in the hosted embed now runs in an origin-owned Worker with transferred and cleared RGBA buffers. The candidate remains opt-in until promotion gates pass.
