"""Validate real responses against the Torrent Stream Protocol contract.

The schema comes from `spec/tsp-openapi.yaml`, a checked-in copy of the
upstream `openapi.yaml`; CI re-downloads the original and fails on drift, so
this cannot quietly test against a stale contract.
"""

from __future__ import annotations

from pathlib import Path

import jsonschema
import pytest
import yaml
from fastapi.testclient import TestClient

from utsi.app import create_app

SPEC = Path(__file__).resolve().parents[1] / "spec" / "tsp-openapi.yaml"
KEY = {"X-API-Key": "test-key"}


@pytest.fixture(scope="session")
def tsp() -> dict:
    return yaml.safe_load(SPEC.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def search_result_schema(tsp: dict) -> dict:
    # Inline the component schemas so jsonschema resolves `$ref` without a
    # registry, and let TSP's "unknown extra fields are ignored" stand.
    return {**tsp["components"]["schemas"]["SearchResult"], "components": tsp["components"]}


@pytest.fixture
def client(settings, fixture_registry):
    fixture_registry.save(settings.registry_path)
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def _validate(schema: dict, payload: dict) -> None:
    # `components` rides along on the root so the document's own
    # `#/components/schemas/Torrent` refs resolve locally.
    jsonschema.validate(payload, schema)


@pytest.mark.parametrize(
    "params",
    [
        {"q": "anything"},
        {"q": "anything", "limit": 1},
        {"q": "anything", "sort": "size"},
        {"q": "anything", "sort": "recent"},
        {"q": "anything", "cat": "video"},
        {"q": "anything", "min_seeders": 100},
        {"q": ""},
        {"q": "anything", "offset": 9999},
    ],
)
def test_responses_validate_against_the_tsp_schema(client, search_result_schema, params):
    response = client.get("/api/v1/search", params=params, headers=KEY)
    assert response.status_code == 200
    _validate(search_result_schema, response.json())


def test_the_required_field_is_enforced_by_the_schema(search_result_schema):
    # Guards the guard: a row without a magnet must fail validation, otherwise
    # the tests above would prove nothing.
    with pytest.raises(jsonschema.ValidationError):
        _validate(
            search_result_schema,
            {
                "query": "x", "count": 1, "limit": 1, "offset": 0, "took_ms": 1,
                "torrents": [{"name": "no magnet"}],
            },
        )


def test_every_field_we_emit_exists_in_the_contract(client, tsp):
    """Extensions are legal, but they should be deliberate ones."""
    documented = set(tsp["components"]["schemas"]["Torrent"]["properties"])
    extensions = {"description_url", "sources"}

    body = client.get("/api/v1/search", params={"q": "anything", "limit": 200}, headers=KEY).json()
    assert body["torrents"]
    emitted = {key for row in body["torrents"] for key in row}
    assert emitted <= documented | extensions

    envelope = set(tsp["components"]["schemas"]["SearchResult"]["properties"])
    assert set(body) <= envelope | {"engines", "partial"}
