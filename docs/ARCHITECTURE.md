# Arquitetura pública

## Limite público/privado

Este monorepo distribui a experiência que roda no navegador. Ele não decodifica VIO, não armazena documentos e não contém uma API key de produção.

```text
Cliente web → Web Component → card direto no Shadow DOM → backend do parceiro → API privada da Consulta
```

O runtime direto extrai bytes do QR localmente. O backend do parceiro cria uma sessão de curta duração e encaminha o payload para a API privada com sua credencial. O retorno é revisado no mesmo card antes de preencher o formulário.

## Origem e bootstrap

O scanner direto só torna câmera, arquivo e PDF disponíveis depois que:

1. sua origem pai estiver autorizada para o `project-id`;
2. a sessão efêmera estiver válida;
3. o bootstrap validar que o `Origin` da chamada é a origem vinculada à sessão;
4. o servidor devolver o runtime versionado e a configuração de marca/layout.

O Web Component não recebe URL de runtime, marca, cor ou apresentação como
atributo. A chave continua somente no backend do parceiro. O shell com iframe
permanece publicado apenas para compatibilidade com integrações anteriores à
modal direta.

A marca e a densidade exibidas pelo scanner também não são atributos do
componente nem escolhas enviadas pela página parceira. O bootstrap autenticado
resolve a marca conforme o plano e a apresentação `compact` ou `standard` do
projeto; uma configuração ausente, inválida ou não permitida retorna à
experiência compacta `Consulta Autofill` com o crédito visível.

## Domínios

- `cdn.consulta.dev.br` entrega assets com versão e hash imutáveis.
- `embed.consulta.dev.br` mantém o shell legado de compatibilidade.
- O runtime direto é um módulo ESM versionado no CDN e é montado no Shadow DOM
  do componente, sem uma navegação de iframe.
- O parceiro expõe endpoints same-origin de sessão e decode e pode expor uma
  ponte opt-in de métricas. Ela aceita somente um token opaco de sessão e um
  evento de lifecycle fixo; não aceita campos, valores, QR, imagem, foto ou
  identidade do usuário final.

O [contrato de deploy do embed](EMBED_DEPLOYMENT.md) define como calcular a CSP dinâmica sem confiar em parâmetros controlados pelo navegador.

## QR Engine

O contrato público do engine é `prepare()`, `scan()` e `dispose()`. O baseline é `zxing-wasm`; a versão QR-only baseada em ZXing-C++ só será promovida quando cumprir os gates de tamanho, desempenho, igualdade de bytes e memória definidos no plano privado.

A leitura direta acontece em um Worker de módulo do runtime versionado. O QR
Worker/ZXing é importado somente quando a pessoa escolhe câmera ou imagem; ao
pedir a câmera, seu preparo acontece em paralelo ao prompt de permissão, antes
de qualquer pixel ser capturado. PDF.js só é importado após a seleção de um
PDF. A thread principal prepara pixels RGBA e transfere seu `ArrayBuffer` para
o Worker; o buffer é apagado no Worker depois da leitura. O retorno contém
somente os bytes do QR necessários ao fluxo já existente e é transferido de
volta sem imagem, arquivo, foto ou telemetria. Se o Worker não puder concluir
o handshake de configuração antes de receber pixels, há fallback de
compatibilidade para o leitor principal; um erro durante uma leitura já
transferida não migra silenciosamente o documento entre engines.

Na CI, o E2E também usa os perfis emulados Pixel 7 e iPhone 14 para detectar
regressões de layout, bootstrap e Worker em viewport/touch móvel. Essa é
somente emulação de navegador: a validação de Android e iOS em dispositivos e
versões físicas suportadas permanece obrigatória antes da promoção.
