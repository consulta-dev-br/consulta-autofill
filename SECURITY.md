# Política de segurança

## Reportar uma vulnerabilidade

Não publique vulnerabilidades, payloads de documento ou provas de conceito contendo dados reais em issues públicas. Use o botão **Report a vulnerability** da aba Security deste repositório para abrir um relatório privado no GitHub. Se esse canal não estiver disponível, envie uma descrição mínima, passos reprodutíveis com dados sintéticos e impacto para o canal de segurança indicado no site `consulta.dev.br`.

Inclua, quando possível:

- versão do pacote ou hash do artefato;
- ambiente e navegador afetados;
- descrição do impacto;
- reprodução sem dados pessoais;
- possível correção ou mitigação.

Confirmaremos o recebimento e coordenaremos a divulgação após uma correção estar disponível.

## Escopo

São especialmente relevantes: validação de origem e bootstrap, exposição de API keys, bypass de sessão, XSS, acesso indevido à câmera, vazamento de dados pessoais e cadeia de publicação. O `postMessage` do shell legado também permanece no escopo enquanto houver clientes nessa versão.

O repositório público não recebe documentos reais. Remova imediatamente qualquer dado pessoal ou segredo enviado por engano e avise os mantenedores.
