"""The HTTP surface, including the TSP rules a naive server gets wrong."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from utsi.app import MAX_LIMIT, create_app

KEY = {"X-API-Key": "test-key"}


@pytest.fixture
def client(settings, fixture_registry):
    fixture_registry.save(settings.registry_path)
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def search(client, **params):
    return client.get("/api/v1/search", params=params, headers=KEY)


# --- auth ------------------------------------------------------------------


def test_missing_key_is_401_not_an_empty_result_set(client):
    response = client.get("/api/v1/search", params={"q": "x"})
    assert response.status_code == 401
    assert response.json()["error"] == "missing_api_key"
    assert "torrents" not in response.json()


def test_wrong_key_is_403(client):
    response = client.get("/api/v1/search", params={"q": "x"}, headers={"X-API-Key": "nope"})
    assert response.status_code == 403
    assert response.json()["error"] == "invalid_api_key"


def test_anonymous_mode_is_opt_in(settings_factory, fixture_registry):
    settings = settings_factory(allow_anonymous=True)
    fixture_registry.save(settings.registry_path)
    with TestClient(create_app(settings)) as anon:
        assert anon.get("/api/v1/search", params={"q": "x"}).status_code == 200


def test_browser_client_is_served_without_a_key(client):
    # A browser cannot send a header when following a link, and pointing a phone
    # at a fresh tunnel should say more than 404.
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "<title>Torrent search</title>" in response.text


def test_the_page_carries_no_key_and_no_external_asset(client, settings):
    body = client.get("/").text
    # The key is asked for and held client-side, never baked into the page.
    assert settings.api_key not in body
    # Self-contained: nothing to fetch from a CDN, so it works over any tunnel.
    assert "src=\"http" not in body
    assert "href=\"http" not in body


def test_the_page_can_be_turned_off(settings_factory, fixture_registry):
    settings = settings_factory(ui=False)
    fixture_registry.save(settings.registry_path)
    with TestClient(create_app(settings)) as headless:
        assert headless.get("/").status_code == 404
        assert headless.get("/healthz").status_code == 200


def test_health_reports_whether_a_key_is_needed(client, settings_factory, fixture_registry):
    assert client.get("/healthz").json()["anonymous"] is False

    settings = settings_factory(allow_anonymous=True)
    fixture_registry.save(settings.registry_path)
    with TestClient(create_app(settings)) as anon:
        assert anon.get("/healthz").json()["anonymous"] is True


def test_health_needs_no_key(client):
    body = client.get("/healthz").json()
    assert body["status"] == "ok"
    assert body["engines_ready"] >= 1


# --- TSP conformance rules -------------------------------------------------


def test_every_row_has_a_magnet(client):
    body = search(client, q="anything", limit=200).json()
    assert body["torrents"]
    assert all(row["magnet"].startswith("magnet:") for row in body["torrents"])


def test_limit_is_capped_server_side_not_rejected(client):
    body = search(client, q="anything", limit=5000).json()
    assert body["limit"] == MAX_LIMIT
    assert len(body["torrents"]) <= MAX_LIMIT


@pytest.mark.parametrize(("sent", "expected"), [(0, 1), (-5, 1), (1, 1), (50, 50)])
def test_limit_is_clamped_low_as_well(client, sent, expected):
    assert search(client, q="anything", limit=sent).json()["limit"] == expected


def test_negative_offset_is_clamped(client):
    assert search(client, q="anything", offset=-10).json()["offset"] == 0


def test_empty_query_is_legal(client):
    response = client.get("/api/v1/search", headers=KEY)
    assert response.status_code == 200
    assert response.json()["query"] == ""


def test_offset_past_the_end_is_200_with_an_empty_array(client):
    body = search(client, q="anything", offset=9999).json()
    assert body["torrents"] == []


@pytest.mark.parametrize(
    ("param", "value", "error"),
    [
        ("cat", "movies", "invalid_cat"),  # a nova3 category, not a TSP one
        ("sort", "name", "invalid_sort"),
        ("res", "4320p", "invalid_res"),
        ("year", "99", "invalid_year"),
    ],
)
def test_out_of_enum_parameters_are_400(client, param, value, error):
    response = search(client, q="x", **{param: value})
    assert response.status_code == 400
    assert response.json()["error"] == error


def test_response_carries_the_documented_envelope(client):
    body = search(client, q="big buck bunny", limit=2).json()
    assert body["query"] == "big buck bunny"
    assert body["limit"] == 2 and body["offset"] == 0
    assert isinstance(body["count"], int) and isinstance(body["took_ms"], int)
    assert len(body["torrents"]) <= 2


def test_nulls_are_omitted_rather_than_serialised(client):
    body = search(client, q="anything", limit=200).json()
    ubuntu = next(row for row in body["torrents"] if "Ubuntu" in row["name"])
    # `pub_date` was -1, so TSP's `first_seen` is absent, not null.
    assert "first_seen" not in ubuntu
    assert not any(value is None for row in body["torrents"] for value in row.values())


# --- rate limiting ---------------------------------------------------------


def test_rate_limit_returns_429_with_retry_after(settings_factory, fixture_registry):
    settings = settings_factory(rate_limit_per_min=2, rate_limit_burst=2)
    fixture_registry.save(settings.registry_path)
    with TestClient(create_app(settings)) as limited:
        for _ in range(2):
            assert limited.get("/api/v1/search", params={"q": "x"}, headers=KEY).status_code == 200
        response = limited.get("/api/v1/search", params={"q": "x"}, headers=KEY)

    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) >= 1
    assert response.json()["error"] == "rate_limited"


# --- operational surface ---------------------------------------------------


def test_engines_endpoint_reports_the_roster(client):
    rows = client.get("/api/v1/engines", headers=KEY).json()
    by_id = {row["id"]: row for row in rows}
    assert by_id["fixmagnet"]["provisioned"] is True
    assert by_id["fixmagnet"]["link_kind"] == "magnet"
    assert "fixslow" not in by_id  # disabled in the registry


def test_behind_a_tunnel_anonymous_callers_share_one_bucket_by_default(settings_factory, fixture_registry):
    """A tunnel makes every request arrive from 127.0.0.1.

    Without being told which header to believe, the socket address is all there
    is — so it identifies the tunnel, not the caller, and two different people
    share a rate-limit bucket. That is the safe default: believing a forwarded
    header nothing set would let anyone mint a fresh bucket per request.
    """
    settings = settings_factory(allow_anonymous=True, rate_limit_per_min=2, rate_limit_burst=2)
    fixture_registry.save(settings.registry_path)
    codes = []
    with TestClient(create_app(settings)) as tunnelled:
        for client_ip in ("203.0.113.7", "198.51.100.9", "192.0.2.4"):
            codes.append(
                tunnelled.get(
                    "/api/v1/search", params={"q": "x"},
                    headers={"CF-Connecting-IP": client_ip},
                ).status_code
            )
    assert codes == [200, 200, 429]


def test_a_trusted_proxy_header_separates_callers_behind_the_tunnel(settings_factory, fixture_registry):
    settings = settings_factory(
        allow_anonymous=True, rate_limit_per_min=2, rate_limit_burst=2,
        trusted_proxy_header="cf-connecting-ip",
    )
    fixture_registry.save(settings.registry_path)
    with TestClient(create_app(settings)) as tunnelled:
        def hit(client_ip: str) -> int:
            return tunnelled.get(
                "/api/v1/search", params={"q": "x"}, headers={"CF-Connecting-IP": client_ip}
            ).status_code

        first = [hit("203.0.113.7") for _ in range(3)]
        # A different caller through the same tunnel starts with a full budget.
        second = hit("198.51.100.9")
        # An X-Forwarded-For style chain names the original client first.
        chained = tunnelled.get(
            "/api/v1/search", params={"q": "x"},
            headers={"CF-Connecting-IP": "203.0.113.7, 10.0.0.1"},
        ).status_code

    assert first == [200, 200, 429]
    assert second == 200
    assert chained == 429  # same caller as `first`, still over its limit


def test_no_cors_headers_by_default(client):
    # A native TSP client never sends Origin; emitting CORS headers to everyone
    # would only widen who can spend the rate limit.
    response = client.get(
        "/api/v1/search", params={"q": "x"},
        headers={**KEY, "Origin": "https://somewhere.example"},
    )
    assert "access-control-allow-origin" not in response.headers


def test_cors_can_be_opened_to_named_origins(settings_factory, fixture_registry):
    settings = settings_factory(cors_origins=("https://my-frontend.netlify.app",))
    fixture_registry.save(settings.registry_path)
    with TestClient(create_app(settings)) as browser:
        preflight = browser.options(
            "/api/v1/search",
            headers={
                "Origin": "https://my-frontend.netlify.app",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "x-api-key",
            },
        )
        allowed = browser.get(
            "/api/v1/search", params={"q": "x"},
            headers={**KEY, "Origin": "https://my-frontend.netlify.app"},
        )
        denied = browser.get(
            "/api/v1/search", params={"q": "x"},
            headers={**KEY, "Origin": "https://not-mine.example"},
        )

    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "https://my-frontend.netlify.app"
    assert allowed.headers["access-control-allow-origin"] == "https://my-frontend.netlify.app"
    # An origin that was not named gets no header, so the browser blocks it.
    assert "access-control-allow-origin" not in denied.headers


def test_stats_is_deliberately_absent(client):
    # TSP says absence is fine; a meta-search has no catalogue to count.
    assert client.get("/api/v1/stats", headers=KEY).status_code == 404


def test_openapi_document_is_generated(client):
    schema = client.get("/openapi.json").json()
    assert "/api/v1/search" in schema["paths"]
