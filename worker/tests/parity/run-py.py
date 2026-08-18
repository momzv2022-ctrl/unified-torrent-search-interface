"""Run every parity scenario against the *Python* Worker and print the result.

This is the reference side of the port. It needs `cloudflare/src/` to exist, so
it only runs on a checkout that still has the Python Worker — see
`worker/tests/parity/README.md` for which commit that is. The frozen answers it
produced live in `worker/tests/golden/` and are what CI checks from now on.

    python3 worker/tests/parity/run-py.py > /tmp/py.json
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
FIXTURES = HERE.parent / "fixtures"
WORKER_SRC = REPO / "cloudflare" / "src"

if not WORKER_SRC.is_dir():
    sys.exit(
        "cloudflare/src is not in this checkout. This runner is the reference "
        "half of the port; see worker/tests/parity/README.md."
    )
sys.path.insert(0, str(WORKER_SRC))

import utsi_config  # noqa: E402
from utsi_gateway import search  # noqa: E402
from utsi_tsp import SearchQuery  # noqa: E402


class StubFetcher:
    """Answers from a URL-prefix table; 404s everything else."""

    def __init__(self, routes: dict) -> None:
        self.routes = routes
        self.calls: list[str] = []

    def _answer(self, url: str):
        self.calls.append(url)
        for prefix, route in self.routes.items():
            if not url.startswith(prefix):
                continue
            if "status" in route:
                return route["status"], ""
            if "text" in route:
                return 200, route["text"]
            return 200, (FIXTURES / route["fixture"]).read_text(encoding="utf-8")
        return 404, ""

    async def text(self, url, timeout, headers=None, method="GET", body=None):
        return self._answer(url)

    async def data(self, url, timeout, headers=None):
        status, _ = self._answer(url)
        return status, b""


def settings_for(scenario: dict) -> utsi_config.Settings:
    overrides = dict(scenario.get("settings") or {})
    if "engines" in overrides:
        overrides["engines"] = tuple(overrides["engines"])
    if "browse_queries" in overrides:
        overrides["browse_queries"] = tuple(overrides["browse_queries"])
    return utsi_config.Settings(api_key="k" * 32, **overrides)


def query_for(scenario: dict) -> SearchQuery:
    asked = scenario.get("query") or {}
    return SearchQuery(
        q=asked.get("q", ""),
        cat=asked.get("cat", ""),
        year=asked.get("year", ""),
        res=asked.get("res", ""),
        min_seeders=asked.get("min_seeders", 0),
        sort=asked.get("sort", ""),
        limit=asked.get("limit", 50),
        offset=asked.get("offset", 0),
    )


def pin(body: dict) -> dict:
    """Pin the three things that cannot be equal between two runs of two languages.

    The clock, the stopwatch, and the words a JSON parser uses to complain. The
    first two are time; the third is CPython's "Expecting value: line 1 column
    1" against V8's "Unexpected token '<'". That a site sent something that was
    not JSON is the contract; whose phrasing says so is not.
    """
    body["took_ms"] = 0
    for torrent in body.get("torrents") or []:
        if torrent.get("scraped_at"):
            torrent["scraped_at"] = "PINNED"
    for engine, message in (body.get("engine_errors") or {}).items():
        if message.startswith("not JSON:"):
            body["engine_errors"][engine] = "not JSON"
    return body


def main() -> None:
    scenarios = json.loads((HERE / "scenarios.json").read_text(encoding="utf-8"))
    results = {}
    for scenario in scenarios:
        reply = asyncio.run(
            search(
                query_for(scenario),
                StubFetcher(scenario.get("routes") or {}),
                settings_for(scenario),
            )
        )
        results[scenario["name"]] = pin(reply.body)
    print(json.dumps(results, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
