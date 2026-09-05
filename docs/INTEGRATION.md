# Integração do Consulta Autofill

O Consulta Autofill preenche formulários a partir de CNH-e e CRLV-e sem colocar a API key no navegador. O componente abre um único card direto para câmera, imagem, PDF e revisão; o seu servidor cria a sessão e encaminha o QR para a API Consulta.

> A beta [`v0.1.5`](https://github.com/consulta-dev-br/consulta-autofill/releases/tag/v0.1.5) está disponível pelo CDN oficial e pela GitHub Release. Os pacotes npm ainda aguardam Trusted Publishing; em produção, use a URL exata do CDN e o `integrity` do manifest, nunca uma URL de branch Git.

## 1. Configure o servidor do parceiro

Defina estes valores apenas no ambiente do servidor:

```text
CONSULTA_API_BASE_URL=https://consulta.dev.br
CONSULTA_API_KEY=...
CONSULTA_PROJECT_ID=pub_...
CONSULTA_PARTNER_ORIGIN=https://cadastro.exemplo.com.br
```

`CONSULTA_PARTNER_ORIGIN` deve ser a origem HTTPS exata cadastrada no projeto Autofill. Não receba esse valor no corpo do browser e não aceite wildcard.

As três rotas são exclusivas do browser: exija o header `Origin` exatamente
igual a `CONSULTA_PARTNER_ORIGIN` e rejeite sua ausência. O componente sempre
o envia nas chamadas `fetch` JSON; uma rota sem essa verificação pode virar
ponte involuntária para chamadas fora do seu site.

Seu servidor expõe dois endpoints same-origin obrigatórios e, se quiser o
funil completo no painel Consulta, uma ponte opcional de métricas:

```text
POST /api/consulta-autofill/session
POST /api/consulta-autofill/decode
POST /api/consulta-autofill/metrics  # opcional, recomendado
```

Cada exemplo em [`examples/backend`](../examples/backend) implementa essa ponte para uma stack específica.

Antes de ativar qualquer rota, conecte-a à sessão server-side e ao escopo/RBAC
de cadastro do seu produto. Os exemplos de Next.js, Express, FastAPI, Go,
Spring Boot e ASP.NET Core saem deliberadamente em modo fail-closed e retornam
`401` até essa política ser fornecida; Laravel aplica `auth` nas rotas de
produção. Não use `project-id`, QR, payload, header inventado pelo browser ou
token compartilhado como prova de identidade.

## 2. Adicione o componente ao formulário

Carregue uma versão exata pelo CDN oficial. Quando os pacotes npm estiverem disponíveis, a mesma versão poderá ser instalada por npm. Para desenvolvimento, importe o build local do monorepo. Em produção via CDN, use o arquivo e o `integrity` registrados no `release-manifest.json` da mesma release; não use aliases mutáveis nem uma URL de branch.

```html
<script
  type="module"
  src="https://cdn.consulta.dev.br/autofill/v0.1.5/consulta-autofill.min.js"
  integrity="sha384-y2KpAPQDGRloezGNVmSkIpD+2y3vygj2ivg1O6NojKDoYLdODrNecJp+qEY5xy7O"
  crossorigin="anonymous"></script>
```

### Campo com câmera embutida (recomendado)

`<consulta-autofill-field>` deixa o input nativo no seu formulário e coloca um botão de câmera acessível dentro dele. É o modo mais curto para páginas HTML, sem montar modal, SVG ou JavaScript do parceiro.

```html
<form id="cadastro">
  <label for="nome">Nome completo</label>
  <consulta-autofill-field
    project-id="pub_..."
    endpoint="/api/consulta-autofill"
    metrics-endpoint="/api/consulta-autofill/metrics"
    document-type="cnh-e"
    label="Abrir Scanner de Câmera para preencher nome">
    <input id="nome" name="name" data-consulta-field="full_name" autocomplete="name" />
  </consulta-autofill-field>
</form>
```

Não adicione atributo, query string ou payload de `branding` a esse snippet. A
marca vem exclusivamente da configuração segura do projeto no servidor:

- Free e Starter mostram `Consulta Autofill` e `Powered by consulta.dev.br`.
- Pro e Enterprise podem definir nome e cor de destaque por projeto.

O runtime direto recebe somente a configuração de exibição no bootstrap autenticado.
Além da marca, o projeto pode escolher a apresentação compacta (grade de
ícones e rótulos curtos) ou detalhada. Nem o componente, nem o endpoint do
parceiro aceitam uma escolha de marca ou layout do browser. Isso mantém a
chave, o plano e a regra comercial fora da página do cliente.

O controle deve ser filho direto do componente. Ele continua sendo um `input`, `textarea` ou `select` normal no DOM do parceiro: validação nativa, `FormData`, máscaras e bindings de framework permanecem funcionando. Após a revisão, o Autofill ainda pode preencher os demais campos mapeados do mesmo formulário.

### Botão separado

```html
<form id="cadastro">
  <label>
    Nome completo
    <input name="name" data-consulta-field="full_name" />
  </label>

  <label>
    CPF
    <input name="cpf" data-consulta-field="cpf" />
  </label>

  <consulta-autofill
    project-id="pub_..."
    endpoint="/api/consulta-autofill"
    metrics-endpoint="/api/consulta-autofill/metrics"
    target-form="#cadastro"
    document-type="auto"
    label="Preencher com documento">
  </consulta-autofill>
</form>
```

O `project-id` é público e serve para consistência visual/protocolo. A associação real entre API key e projeto é feita pelo seu servidor, com `CONSULTA_PROJECT_ID`; nunca confie no atributo enviado pelo navegador para escolher uma credencial, plano ou marca.

Campos com `data-consulta-field` são preenchidos somente se estiverem vazios. A pessoa revisa os dados antes de confirmar e pode editar os valores no card.

## 3. Eventos e frameworks controlados

O componente emite eventos no próprio elemento:

| Evento | Uso |
|---|---|
| `consulta:ready` | O componente foi registrado. |
| `consulta:opened` | Uma sessão curta foi criada. |
| `consulta:decoded` | A API retornou dados; o detalhe não contém os valores dos campos. |
| `consulta:confirmed` | A pessoa confirmou a revisão. |
| `consulta:filled` | Contém `fields`, `filled`, `preserved` e `document`; use para atualizar estado controlado. |
| `consulta:error` | Erro seguro para a interface; não envie o detalhe para analytics se puder conter contexto do cadastro. |

Em React, Vue e Angular controlados, consuma `consulta:filled` em vez de depender apenas de `input.value`:

```js
document.querySelector("consulta-autofill")?.addEventListener("consulta:filled", (event) => {
  const { fields } = event.detail;
  // Atualize o estado do framework somente com os campos que a pessoa confirmou.
  setRegistration((previous) => ({ ...previous, ...fields }));
});
```

## 4. Contrato da ponte do parceiro

O browser fala somente com os endpoints do parceiro. O componente envia:

```jsonc
// POST /session
{ "protocol_version": 1, "document_type": "auto" }

// POST /decode
{
  "protocol_version": 1,
  "session_token": "...",
  "payload_base64": "...",
  "include_photo": false
}

// POST /metrics (opcional)
{
  "protocol_version": 1,
  "session_token": "...",
  "event": "filled"
}
```

`event` é um enum fechado: `opened`, `camera_requested`,
`camera_granted`, `camera_denied`, `qr_found`, `decoded`, `confirmed`,
`filled`, `closed` ou `error`. A requisição **nunca** inclui nome de campo,
valor, tipo de documento, QR, foto, arquivo, mensagem de erro, IP ou
identificador do usuário final. O componente só a emite quando
`metrics-endpoint` está configurado; a falha dessa chamada não interrompe o
scanner nem o preenchimento.

O servidor do parceiro acrescenta seus próprios headers ao chamar a Consulta:

```http
X-API-Key: <CONSULTA_API_KEY>
X-Consulta-Product: autofill
X-Consulta-Project-ID: <CONSULTA_PROJECT_ID>
Content-Type: application/json
```

Para criar uma sessão, ele também envia a origem fixa do ambiente:

```json
{
  "protocol_version": 1,
  "document_type": "auto",
  "partner_origin": "https://cadastro.exemplo.com.br"
}
```

Repasse o envelope de sucesso/erro preservando o status HTTP. Não logue `payload_base64`, `session_token`, foto, arquivo, campos ou corpo de resposta.

Para a ponte `/metrics`, valide exatamente os três campos acima e encaminhe
para `POST /api/v1/autofill/metrics` usando os mesmos headers de servidor.
Aceite respostas repetidas como sucesso: os eventos são idempotentes por
sessão e tipo. Não acrescente dados do browser à métrica.

## 5. Foto e privacidade

A foto é desligada por padrão no projeto e na interface. Mesmo para um projeto com foto habilitada, a pessoa precisa marcar a caixa de confirmação antes do decode. O parceiro não deve alterar `include_photo` para `true` no servidor.

Toda resposta de sucesso do decode deve incluir `photo`: use `null` quando a
foto não foi solicitada ou não foi autorizada. Quando houver foto, envie
somente JPEG ou PNG em base64 conforme o schema v1; o runtime rejeita campos,
valores e imagens que ultrapassem os limites publicados.

O funil de métricas é deliberadamente separado da sua analytics geral. Se
usar `consulta:filled` no seu próprio produto, não encaminhe `fields`,
`filled`, `preserved`, documento ou qualquer detalhe do evento ao Consulta.
O `metrics-endpoint` já cobre a telemetria mínima sem PII e sem expor a chave.

O Autofill não dispara o webhook `document.decoded`; se o parceiro precisar de um evento de negócio, faça isso após salvar o cadastro sob as próprias regras de autorização e retenção.

## 6. Headers de produção

O scanner roda no mesmo contexto do seu formulário, sem `iframe`. Permita o
script e os Workers imutáveis do CDN, a chamada de bootstrap à Consulta e a
câmera para a própria origem do seu site:

```http
Content-Security-Policy: script-src 'self' https://cdn.consulta.dev.br; connect-src 'self' https://consulta.dev.br https://cdn.consulta.dev.br; worker-src 'self' https://cdn.consulta.dev.br; img-src 'self' blob: data:; media-src 'self' blob:
Permissions-Policy: camera=(self)
```

O componente não aceita uma URL de runtime, marca, cor ou layout como atributo
do browser. O servidor Consulta devolve o runtime versionado e a configuração
após conferir a origem vinculada à sessão. A partir da versão direta, não há
`postMessage` nem permissões delegadas a uma moldura filha.

## 7. Erros e recuperação

Erros têm formato estável:

```json
{
  "success": false,
  "error": {
    "code": "SESSION_EXPIRED",
    "message": "A sessão do Autofill expirou.",
    "retryable": true
  },
  "request_id": "req_..."
}
```

- Crie uma sessão nova em `SESSION_EXPIRED` e `SESSION_REPLAYED`.
- Mostre nova tentativa para `QR_NOT_FOUND`, `CAMERA_DENIED` e `CAMERA_UNAVAILABLE`.
- Respeite `429`/`RATE_LIMITED`; não faça retry automático em loop.
- Trate `UPSTREAM_UNAVAILABLE` como erro temporário e guarde apenas `request_id` para suporte.
- `AUTOFILL_BETA_REQUIRED` não é recuperável pelo navegador: o titular da conta deve ser aprovado para o beta antes de criar projetos ou sessões.

O schema distribuído fica em [`packages/autofill/contracts/v1/autofill.schema.json`](../packages/autofill/contracts/v1/autofill.schema.json).
