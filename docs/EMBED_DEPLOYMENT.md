# Deploy do shell `embed.consulta.dev.br`

O shell do iframe é uma aplicação separada do site principal. Não o publique
atrás dos headers globais de `consulta.dev.br`: `X-Frame-Options: SAMEORIGIN` e
`frame-ancestors 'none'` impedem a integração legítima em sites parceiros.

## Resolução confiável da política

Cada navegação do shell precisa ser resolvida por um serviço do lado servidor
que recebe o `project_id` público e consulta a configuração privada do projeto.
O serviço deve produzir a lista de origens permitidas a partir desse registro.

- Nunca derive `frame-ancestors` de `parent_origin`, `Origin`, `Referer` ou
  outro valor enviado pelo navegador.
- Para projeto inexistente, inativo, sem origens válidas ou sem estado
  compartilhado disponível, responda com `frame-ancestors 'none'` e não inicie
  o scanner.
- Não use `X-Frame-Options` na resposta do shell: ele não expressa uma lista
  de parceiros e pode conflitar com a CSP.
- A resposta HTML é específica do projeto, portanto deve usar
  `Cache-Control: private, no-store`. O CDN não pode reaproveitar a CSP de um
  projeto para outro.

O `project_id` não é uma credencial. Ainda assim, a sessão e o bootstrap
continuam obrigatórios: a CSP apenas reduz a superfície de clickjacking e não
substitui a validação de origem, nonce e `MessageChannel` do protocolo.

## Headers do shell dinâmico

Para um projeto com as origens `https://cadastro.exemplo.com` e
`https://staging.exemplo.com`, a resposta de `/v1?project_id=pub_...` deve ter
o equivalente a:

```http
Cache-Control: private, no-store
Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; frame-ancestors https://cadastro.exemplo.com https://staging.exemplo.com; script-src 'self' https://cdn.consulta.dev.br; style-src 'self' https://cdn.consulta.dev.br; connect-src 'self' https://consulta.dev.br https://cdn.consulta.dev.br; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' https://cdn.consulta.dev.br; manifest-src 'self'
Permissions-Policy: camera=(self)
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

Adapte a lista de `script-src`, `style-src`, `connect-src` e `worker-src`
somente aos domínios versionados realmente usados no release. Os Workers do PDF
e do QR, o WASM e a folha de estilos precisam ser entregues por essa allowlist; nunca
habilite `unsafe-eval`, `unsafe-inline` ou `*` como atalho. O CSS do embed é
emitido como asset estático versionado e `script-src` jamais pode receber uma
exceção inline.

O parceiro também precisa permitir o iframe na página pai:

```http
Content-Security-Policy: frame-src https://embed.consulta.dev.br
Permissions-Policy: camera=(self "https://embed.consulta.dev.br")
```

O componente já fornece `sandbox="allow-scripts allow-same-origin"` e
`allow="camera"`. Não adicione `allow-popups`, `allow-forms`,
`allow-top-navigation` ou permissões de dispositivo adicionais.

## Ativos imutáveis

Os assets de uma release imutável — loader, bundle, Worker, WASM, PDF worker e
manifestos — podem usar:

```http
Cache-Control: public, max-age=31536000, immutable
X-Content-Type-Options: nosniff
```

O alias `/v1/` e qualquer HTML sem hash usam no máximo cinco minutos de cache;
o shell com CSP por projeto continua `no-store`. Publique primeiro a versão
imutável, valide sua integridade e só então mova o alias.

### Layout da release do embed

O build do embed é propositalmente relativo e precisa ser publicado sob uma
versão exata, por exemplo `https://cdn.consulta.dev.br/embed/v0.1.0/`:

```text
embed/v0.1.0/
├── index.html
├── zxing_reader.wasm
└── assets/
    ├── consulta-embed.js
    ├── consulta-embed.css
    ├── qr-worker-<hash>.js
    └── pdf.worker.min-<hash>.mjs
```

O servidor do shell deve montar o HTML por projeto com o JS e CSS de nomes
estáveis acima, e incluir seus valores `sha384-...` de SRI extraídos do
`release-manifest.json`. A configuração correspondente é:

```text
AUTOFILL_EMBED_ASSET_BASE_URL=https://cdn.consulta.dev.br/embed/v0.1.0/
AUTOFILL_EMBED_SCRIPT_INTEGRITY=sha384-...
AUTOFILL_EMBED_STYLESHEET_INTEGRITY=sha384-...
```

Não aponte essa configuração para o alias mutável `/embed/v1/`. Antes de
publicar, `pnpm embed:verify-versioned` confirma que `index.html`, o Worker e
o WASM continuam resolvendo dentro do diretório versionado. O E2E também monta
o build em `/embed/v0.0.0/` e exercita o Worker nos três navegadores.

Como o documento do shell carrega módulos de outra origem, o CDN precisa
responder os assets com `Access-Control-Allow-Origin: https://embed.consulta.dev.br`
(sem cookies), além de `X-Content-Type-Options: nosniff`. Não use `*` como
política de produção por conveniência; cada ambiente de embed deve estar
explicitamente autorizado.

## Checklist operacional

Antes de liberar um ambiente, confirme:

1. A resolução de projeto usa armazenamento compartilhado e falha fechada.
2. Cada origem retornada por `frame-ancestors` é HTTPS, exata e pertence ao
   projeto solicitado.
3. O shell não inclui `X-Frame-Options` e nenhum header global sobrescreve a
   CSP dinâmica.
4. Um parceiro autorizado carrega o iframe, chega ao bootstrap e abre a câmera
   somente após gesto explícito.
5. Uma origem não autorizada recebe `frame-ancestors 'none'` ou não consegue
   completar o bootstrap; em nenhum caso recebe câmera ou decode.
6. O HTML e o alias não ficam em cache com headers de outro projeto.
7. Os assets entregues pelo CDN correspondem ao manifesto SHA-256 da release.
8. O CSS vem do asset versionado e a CSP não contém `unsafe-inline`,
   `unsafe-eval` ou `*`.

Registre a evidência desses oito itens no release e no runbook privado. Sem o
item 1, o Autofill permanece em beta allowlisted.
