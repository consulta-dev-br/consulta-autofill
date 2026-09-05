# Runbook de retomada

Use este documento ao retomar a implementação do Consulta Autofill depois de
uma interrupção. Ele descreve apenas o produto público; não cole chaves,
documentos, payloads VIO, backups ou dados de clientes em issues, commits,
logs ou prompts.

## Limite de responsabilidade

| Área | Onde continua |
| --- | --- |
| Web Component, card direto, QR local, contratos, exemplos e releases | Este repositório público |
| Decode VIO, API keys, contas, billing, banco, webhooks e projetos | Serviço privado Consulta |
| Sessão do usuário, autorização e persistência do cadastro | Backend do parceiro |

O navegador nunca recebe a chave da Consulta. Ele usa somente o `project-id`
público, uma sessão efêmera e endpoints same-origin do parceiro.

## Retomada segura

1. Confirme o checkout e preserve trabalho alheio antes de editar:

   ```bash
   git status --short
   git log --oneline -12
   ```

2. Atualize dependências e valide a base pública:

   ```bash
   corepack enable
   pnpm install --frozen-lockfile
   pnpm sanitize:public
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm exec playwright install chromium firefox webkit
   pnpm test:e2e
   ```

3. Quando alterar uma ponte de backend, execute o teste do exemplo afetado e
   confira a workflow **Backend examples**. Os sete exemplos precisam manter
   autenticação do usuário, origem fixa no servidor, rate limit, timeout,
   validação estrita e ausência de logs de dados do documento.

4. Antes de enviar código público, execute novamente `pnpm sanitize:public`.
   A regra bloqueia segredos, arquivos de ambiente, bancos, backups, CPF
   válido, PDFs, imagens/documentos binários, arquivos compactados e data URLs
   extensas. Use somente fixtures sintéticas em texto/código; o único binário
   aceito é o WASM baseline explicitamente verificado por hash e licença.

## QR-only: estado e promoção

O QR-only é um candidato opt-in. `zxing-wasm` continua o baseline até que
todos os gates abaixo sejam aprovados:

- igualdade byte a byte e taxa de leitura no corpus sintético;
- corpus VIO privado, fora deste Git, com manifesto e caminho fornecidos pelo
  operador;
- p50/p95 e inicialização sem regressão acima do limite aprovado;
- artefato WASM menor conforme a meta;
- Chrome, Edge, Firefox e Safari reais, inclusive dispositivos móveis físicos;
- ausência de crescimento de memória após ciclos repetidos.

Nunca marque o QR-only como padrão apenas porque a CI pública passou. A
workflow **QR-only WASM candidate** prova reprodutibilidade e regressão no
corpus público; ela não substitui o corpus privado nem a matriz física.

## Release e distribuição

Antes da primeira publicação, o mantenedor precisa prover fora do Git:

- escopo npm `@consulta-dev` com Trusted Publishing/OIDC para esta workflow;
- bucket R2 exclusivo, domínio `cdn.consulta.dev.br`, CORS público somente
  para leitura e credencial S3 de menor privilégio;
- variáveis e secrets do R2 no ambiente GitHub `release`, não em arquivos ou
  variáveis locais do repositório;
- configuração do host `embed.consulta.dev.br` conforme o
  [contrato de deploy](EMBED_DEPLOYMENT.md);
- uma tag `v<semver>` apontando para um commit alcançável pela `main` protegida.

A workflow **Release artifacts** primeiro produz uma coleção única com
tarballs, assets de CDN, SRI, SHA-256 e SBOM. Os jobs que publicam npm,
GitHub Release e CDN ficam no ambiente `release` e exigem aprovação. Inicie o
dispatch pela `main`; a workflow valida a tag antes de executar builds. Não
publique manualmente, não use `r2.dev`, não altere assets ou tags publicados e
não mova aliases `/v1/` nesse fluxo.

Para testar a coleção sem rede, use o dry-run descrito em
[RELEASES.md](RELEASES.md#publicação-r2cdn).

## Informações mínimas para o próximo responsável

Registre apenas informações não sensíveis:

- hash atual de `main` e URL das últimas workflows CI, QR-only e backend;
- comandos executados e seus resultados;
- quais dos pré-requisitos externos acima ainda faltam;
- decisão de produto pendente, por exemplo a promoção ou não do QR-only;
- alterações locais não relacionadas que devem ser preservadas.

Não registre tokens, valores de variáveis, payloads, imagens, nomes de
clientes, CPF, CNH, CRLV, URLs privadas ou respostas da API.

## Critério de pronto para produção

O Autofill só está pronto para um parceiro real quando a ponte server-to-server
foi revisada na stack escolhida, o projeto privado autoriza a origem HTTPS
exata, a release exata foi publicada pelos três canais aprovados, o CDN passou
o smoke test, a CSP/Permissions Policy está configurada e a matriz de
compatibilidade exigida foi concluída. Até lá, mantenha o uso em demonstração
ou beta controlado.
