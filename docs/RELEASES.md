# Releases

Pacotes públicos são versionados com Changesets, em um grupo fixo: `@consulta-dev/autofill` e `@consulta-dev/qr-engine` sempre recebem a mesma versão semântica compatível. A publicação final ocorre somente em CI por Trusted Publishing/OIDC; colaboradores não devem publicar versões manualmente.

`pnpm release` aborta deliberadamente no checkout local. Use a workflow manual
**Release artifacts** depois de criar a tag aprovada; ela é o único caminho
suportado para npm, GitHub Release e CDN.

## Coleção única de artefatos

Depois de `pnpm build`, a coleção é preparada por uma única execução, sem publicar nada:

```bash
CONSULTA_RELEASE_VERSION=0.1.0 pnpm release:prepare
pnpm release:verify
```

Ela produz, em `.release-artifacts/` ou em `CONSULTA_RELEASE_OUTPUT_DIR` vazio:

- tarballs exatos de `@consulta-dev/autofill` e `@consulta-dev/qr-engine`;
- assets versionados do CDN, inclusive `autofill/v0.1.0/consulta-autofill.min.js` e o shell do embed;
- `release-manifest.json` com SHA-256, tipo MIME, SRI e o commit/tag de origem dos assets;
- `SHA256SUMS` e um SBOM CycloneDX 1.5;
- prova de que os bytes JavaScript copiados ao CDN são os mesmos arquivos dentro dos tarballs npm.

A CI comum executa `pnpm release:dry-run`: ela prepara e verifica uma coleção
efêmera, incluindo o publicador de CDN em modo seco, sem rede, bucket ou
credenciais reais.

Em seguida, a CI executa `pnpm release:consumer-dry-run`. Esse gate instala os
dois tarballs em um projeto npm isolado e importa os exports públicos, para
provar que o que será publicado pode ser consumido fora do monorepo. Ele pode
usar o cache ou buscar apenas dependências públicas já declaradas; não recebe
segredos de publicação e não publica nada.

`CONSULTA_RELEASE_VERSION` identifica a coleção, os paths de CDN e a tag `v<versão>`. Como os dois pacotes são um SDK compatível de versão fixa, essa versão precisa ser exatamente a mesma nos dois `package.json`; o manifest e os tarballs são conferidos contra ela. A versão de desenvolvimento `0.0.0` só serve para ensaios sem tag e é recusada em uma publicação marcada.

## Preparar a versão antes da tag

Antes de disparar a workflow, aplique os Changesets pendentes e faça a tag com a mesma versão escrita nos dois pacotes. Por exemplo, para a primeira versão calculada como `0.1.0`:

```bash
pnpm version-packages
git add .changeset packages/autofill packages/qr-engine
git commit -m "chore(release): version packages"
git tag v0.1.0
git push origin main --follow-tags
```

Confira o diff gerado antes do commit. A workflow recusa uma tag cuja versão não corresponda aos dois pacotes, portanto ela não consegue publicar acidentalmente dois tarballs `0.0.0` nem repetir uma versão de apenas um componente.

O QR-only experimental não entra na coleção: ele continua opt-in até o corpus privado e a matriz externa de navegadores aprovarem sua promoção.

## Publicação aprovada

A workflow manual **Release artifacts** exige que a tag `v<versão>` já exista. Ela reconstrói, testa, prepara e verifica a coleção antes de qualquer publicação. Por padrão, ela apenas retém o artefato do GitHub Actions por 14 dias.

Antes do build, a workflow executa `pnpm licenses:verify`. O gate compara a
licença Apache-2.0 do código próprio, as versões/licenças das dependências que
entram no produto ou na ferramenta de distribuição e os registros em
`third-party/`, inclusive hash do baseline e receita QR-only.

Os três jobs que efetivamente publicam (`npm`, GitHub Release e CDN) usam o ambiente GitHub `release`: ele só pode ser acionado a partir da `main` protegida e exige uma aprovação explícita antes de receber permissões de publicação. Antes de preparar qualquer artefato, a workflow confere que `v<versão>` existe, corresponde exatamente ao checkout e aponta para um commit alcançável pela `main`. A coleção grava essa tag e esse commit no manifest; antes da publicação, um checkout seguro da `main` verifica novamente que a tag remota ainda aponta para o mesmo commit. Na configuração atual de mantenedor único, a autoaprovação permanece permitida para não bloquear uma release legítima; ao adicionar outro mantenedor, habilite a proibição de autoaprovação e use revisão independente.

- `publish_npm=true` publica exatamente os tarballs verificados com `npm publish --provenance`, usando Trusted Publishing/OIDC. Antes disso, um administrador do escopo `@consulta-dev` deve cadastrar esse repositório/workflow como publisher confiável; não use token permanente.
- `publish_github_release=true` cria a GitHub Release da tag e envia os mesmos tarballs, manifest, checksums e SBOM. Se a release ou um asset já existir, a execução falha; publique uma nova versão em vez de alterar a anterior.
- `publish_cdn=true` publica exclusivamente os itens `cdn_assets` da coleção já verificada no R2 e faz smoke test pelo domínio público. Ele não altera aliases como `/v1/` e não usa `r2.dev`.

Cada release deverá publicar o mesmo artefato testado em npm, GitHub Release e CDN, junto com SHA-256, SBOM e proveniência quando disponíveis.

As **immutable releases** do GitHub estão habilitadas neste repositório. Depois
de publicada, uma release semântica não deve ser editada, ter assets trocados ou
ser removida; corrija qualquer erro em uma nova versão.

Antes de apontar `embed.consulta.dev.br`, siga o [contrato de deploy do shell](EMBED_DEPLOYMENT.md). A política `frame-ancestors` precisa ser calculada no servidor por projeto; um host estático não pode usar uma CSP permissiva como substituto.

## Publicação R2/CDN

O job manual **Publish verified immutable CDN assets** só executa quando `publish_cdn=true` for selecionado na workflow **Release artifacts**. Ele baixa o mesmo artefato preparado para npm/GitHub Release, repete `release:verify` e usa a API S3 compatível do R2 para publicar somente caminhos de versão exata, como `embed/v0.1.0/assets/consulta-embed.js`.

Cada `PUT` usa `If-None-Match: *`, `Content-Type`, `Content-MD5`, o cache imutável e metadados de release/SHA-256. Portanto, uma chave já existente não é sobrescrita: uma nova execução só prossegue se o objeto existente tiver exatamente os bytes e metadados esperados. Em seguida, o job lê cada objeto do R2 e do domínio público, confere bytes, `Content-Type`, `Cache-Control` e CORS. Uma falha deixa a versão sem promoção; não regrave nem delete a versão — publique uma nova versão semver.

Antes da primeira execução, configure a infraestrutura fora deste repositório:

- Crie um bucket R2 exclusivo para os assets públicos e conecte o domínio `https://cdn.consulta.dev.br/` a ele. Não exponha `r2.dev`.
- Configure CORS do bucket para `GET` e `HEAD` de qualquer origem (`Access-Control-Allow-Origin: *`); o shell carrega JS, CSS e WASM versionados de outra origem.
- Crie uma credencial S3 do R2 com **Object Read & Write** restrita a esse único bucket. O job precisa de leitura para a verificação posterior; não use um token REST administrativo do Cloudflare. Prefira credenciais temporárias e de menor escopo quando houver um emissor seguro.
- Cadastre as GitHub Actions variables `CONSULTA_R2_ACCOUNT_ID`, `CONSULTA_R2_BUCKET` e `CONSULTA_CDN_PUBLIC_BASE_URL=https://cdn.consulta.dev.br/`.
- Cadastre os GitHub Actions secrets `CONSULTA_R2_ACCESS_KEY_ID`, `CONSULTA_R2_SECRET_ACCESS_KEY` e, apenas para credenciais temporárias, `CONSULTA_R2_SESSION_TOKEN`.

Para ensaiar uma coleção local sem tocar no R2, prepare os artefatos e execute o publicador com `--dry-run`. O comando ainda exige os três valores de destino para validar a configuração, mas não exige credenciais S3 nem faz rede:

```bash
CONSULTA_RELEASE_VERSION=0.1.0 pnpm release:prepare
CONSULTA_RELEASE_OUTPUT_DIR=.release-artifacts \
CONSULTA_R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
CONSULTA_R2_BUCKET=consulta-autofill-assets \
CONSULTA_CDN_PUBLIC_BASE_URL=https://cdn.example.test/ \
pnpm release:publish-cdn -- --dry-run
```

Somente depois de todos os smoke tests use a configuração de entrega para apontar um consumidor a uma versão exata. A eventual movimentação controlada de um alias `/v1/` é uma mudança de infraestrutura separada, revisada e reversível; o publicador não tem permissão para realizá-la.
