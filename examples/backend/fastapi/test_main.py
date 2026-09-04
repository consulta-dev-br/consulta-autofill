from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

import httpx

# main.py validates deployment settings at import time. These are intentionally
# synthetic values, never a real Consulta credential or project.
os.environ.update(
    {
        "CONSULTA_API_BASE_URL": "https://consulta.example",
        "CONSULTA_API_KEY": "test_server_key",
        "CONSULTA_PROJECT_ID": "pub_test_project",
        "CONSULTA_PARTNER_ORIGIN": "https://partner.example",
    }
)

import main


class CapturingAsyncClient:
    captured: dict[str, object] = {}

    def __init__(self, **kwargs: object) -> None:
        self.constructor_options = kwargs

    async def __aenter__(self) -> "CapturingAsyncClient":
        return self

    async def __aexit__(self, _type: object, _value: object, _traceback: object) -> bool:
        return False

    async def post(self, url: str, **kwargs: object) -> "SyntheticResponse":
        CapturingAsyncClient.captured = {"url": url, **kwargs}
        return SyntheticResponse()


class SyntheticResponse:
    status_code = 201

    def json(self) -> dict[str, object]:
        return {"success": True, "request_id": "req_synthetic", "data": {}}


class PartnerBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, path: str, body: dict[str, object], origin: str | None = "https://partner.example") -> httpx.Response:
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://partner.test") as client:
            headers = {"Origin": origin} if origin else {}
            return await client.post(path, json=body, headers=headers)

    async def test_session_forwards_only_server_owned_origin(self) -> None:
        calls: list[tuple[str, dict[str, object]]] = []

        async def upstream(path: str, payload: dict[str, object]) -> main.JSONResponse:
            calls.append((path, payload))
            return main.JSONResponse(
                {"success": True, "request_id": "req_synthetic", "data": {}},
                status_code=201,
                headers={"Cache-Control": "no-store"},
            )

        async def allow_access(_request: main.Request) -> bool:
            return True

        with patch.object(main, "forward", new=upstream), patch.object(main, "require_partner_access", new=allow_access):
            response = await self.request(
                "/api/consulta-autofill/session",
                {"protocol_version": 1, "document_type": "cnh-e"},
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(
            calls,
            [
                (
                    "/api/v1/autofill/sessions",
                    {
                        "protocol_version": 1,
                        "document_type": "cnh-e",
                        "partner_origin": "https://partner.example",
                    },
                )
            ],
        )

    async def test_rejects_cross_origin_and_metric_pii_before_upstream(self) -> None:
        async def upstream(_path: str, _payload: dict[str, object]) -> main.JSONResponse:
            raise AssertionError("o upstream não deve ser chamado")

        async def allow_access(_request: main.Request) -> bool:
            return True

        with patch.object(main, "forward", new=upstream), patch.object(main, "require_partner_access", new=allow_access):
            wrong_origin = await self.request(
                "/api/consulta-autofill/session",
                {"protocol_version": 1, "document_type": "auto"},
                "https://attacker.example",
            )
            missing_origin = await self.request(
                "/api/consulta-autofill/session",
                {"protocol_version": 1, "document_type": "auto"},
                None,
            )
            extra_metric = await self.request(
                "/api/consulta-autofill/metrics",
                {
                    "protocol_version": 1,
                    "session_token": "a" * 32,
                    "event": "filled",
                    "fields": {"cpf": "00000000000"},
                },
            )

        self.assertEqual(wrong_origin.status_code, 403)
        self.assertEqual(wrong_origin.json()["error"]["code"], "INVALID_ORIGIN")
        self.assertEqual(missing_origin.status_code, 403)
        self.assertEqual(missing_origin.json()["error"]["code"], "INVALID_ORIGIN")
        self.assertEqual(extra_metric.status_code, 400)
        self.assertEqual(extra_metric.json()["error"]["code"], "INVALID_REQUEST")

    async def test_rejects_anonymous_requests_before_upstream(self) -> None:
        async def upstream(_path: str, _payload: dict[str, object]) -> main.JSONResponse:
            raise AssertionError("o upstream não deve ser chamado")

        with patch.object(main, "forward", new=upstream):
            response = await self.request(
                "/api/consulta-autofill/session",
                {"protocol_version": 1, "document_type": "auto"},
            )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHENTICATED")

    async def test_forward_sets_pinned_headers(self) -> None:
        CapturingAsyncClient.captured = {}
        with patch.object(main.httpx, "AsyncClient", CapturingAsyncClient):
            response = await main.forward(
                "/api/v1/autofill/sessions",
                {"protocol_version": 1, "document_type": "auto", "partner_origin": "https://partner.example"},
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(CapturingAsyncClient.captured["url"], "https://consulta.example/api/v1/autofill/sessions")
        self.assertEqual(
            CapturingAsyncClient.captured["headers"],
            {
                "Content-Type": "application/json",
                "X-API-Key": "test_server_key",
                "X-Consulta-Product": "autofill",
                "X-Consulta-Project-ID": "pub_test_project",
            },
        )
        self.assertEqual(CapturingAsyncClient.captured["json"], {"protocol_version": 1, "document_type": "auto", "partner_origin": "https://partner.example"})
        self.assertTrue(json.loads(response.body)["success"])
