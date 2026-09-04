# Exemplo FastAPI

Requer Python 3.9 ou superior.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload
```

Para verificar os handlers e os headers encaminhados com upstream sintético:

```bash
python -m unittest
```

O exemplo oferece `/api/consulta-autofill/session`, `/decode` e a ponte
opcional `/metrics`, com limite de corpo, origem exata, timeout e limite local.
Use `metrics-endpoint="/api/consulta-autofill/metrics"` para acompanhar o funil
sem PII. `require_partner_access` nega por padrão: conecte-a à
autenticação/autorização server-side e ao escopo/RBAC do seu produto antes de
expor a rota. Não aceite `project-id`, QR, payload ou token estático do browser
como identidade. Troque também o rate limiter em memória por Redis antes de
múltiplos processos/instâncias.

Nenhum corpo sensível é escrito em logs. Leia [docs/INTEGRATION.md](../../../docs/INTEGRATION.md).
