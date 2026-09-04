# Consulta Autofill

**Preencha cadastros com documentos oficiais em segundos.**

Consulta Autofill é o componente público do ecossistema `consulta.dev.br`. Ele oferece uma experiência de câmera, arquivo, PDF, revisão e preenchimento de formulários para documentos com QR Code, sem expor a chave da API do parceiro no navegador.

> Este repositório não contém o decodificador VIO, documentos, payloads reais, chaves ou dados pessoais. A infraestrutura privada de decodificação continua no serviço Consulta.

## Como a integração funciona

```text
Formulário do parceiro
  → @consulta-dev/autofill
  → iframe oficial da Consulta
  → endpoint do parceiro
  → API privada da Consulta
  → revisão e preenchimento confirmado
```

O navegador processa a imagem e extrai o QR localmente. A chamada autenticada para a API passa exclusivamente pelo backend do parceiro.

Opcionalmente, o parceiro pode encaminhar um funil de etapas fixas (abertura,
permissão de câmera, QR, decode, confirmação e preenchimento) ao painel
Consulta. Essa ponte também passa pelo seu backend e não inclui documento,
campo, valor, imagem, QR, IP ou identidade do usuário final.

Free e Starter mantêm a marca `Consulta Autofill` e `Powered by consulta.dev.br` no iframe. Pro e Enterprise podem configurar nome e cor por projeto; essa configuração é resolvida pelo bootstrap autenticado, nunca por atributo ou payload vindo do browser.

## Pacotes

| Pacote | Finalidade | Estado |
|---|---|---|
| `@consulta-dev/autofill` | Web Component e contrato público | Beta `v0.1.0` publicada |
| `@consulta-dev/qr-engine` | Interface de leitura de QR no navegador | Beta `v0.1.0` publicada |
| `apps/embed` | Aplicação hospedada no iframe | Beta `v0.1.0` publicada |

## Desenvolvimento

Requer Node.js 24 e pnpm 11.

```bash
corepack enable
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Para testes end-to-end, instale o navegador uma vez:

```bash
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e
```

## Segurança e privacidade

- A API key nunca pertence ao cliente web.
- Um projeto só pode ser usado nas origens HTTPS exatas autorizadas.
- A comunicação iframe/página valida origem, janela, versão e nonce.
- Nenhum payload, imagem, foto ou campo decodificado deve ser enviado para analytics ou logs públicos.
- O componente não substitui campos existentes sem confirmação explícita.

Leia [a arquitetura](docs/ARCHITECTURE.md) e a [política de segurança](SECURITY.md) antes de integrar ou contribuir.

O guia com o componente, a ponte same-origin, CSP/Permissions Policy e exemplos de servidor está em [docs/INTEGRATION.md](docs/INTEGRATION.md).

Para a integração HTML mais curta, use `<consulta-autofill-field>`: ele posiciona o botão de câmera acessível dentro de um `input` nativo e abre o fluxo hospedado após o toque.

Os exemplos de ponte segura para Next.js, Express, Laravel, FastAPI, Go, Spring Boot e ASP.NET Core ficam em [examples/backend](examples/backend).

Para retomar o trabalho com os limites público/privado, verificações e pré-requisitos de produção documentados, consulte o [runbook de implementação](docs/IMPLEMENTATION_RUNBOOK.md).

O schema de referência do contrato v1 está em [packages/autofill/contracts/v1/autofill.schema.json](packages/autofill/contracts/v1/autofill.schema.json). Ele é distribuído junto com `@consulta-dev/autofill`.

## Status

A beta [`v0.1.0`](https://github.com/consulta-dev-br/consulta-autofill/releases/tag/v0.1.0) está publicada no CDN e na GitHub Release. Os pacotes npm ainda aguardam a configuração de Trusted Publishing; até lá, integre uma versão exata pelo CDN. A API e o produto continuam em beta e não devem ser assumidos como estáveis.

## Licença

Código próprio licenciado sob [Apache-2.0](LICENSE). Dependências e artefatos de terceiros têm seus avisos em [third-party](third-party/README.md).
