"""The fan-out: pick engines, run them in parallel, merge, resolve, page.

Budget model, per request:

* a **global deadline** (default 8s) after which we answer with whatever
  finished — a partial result beats a timeout;
* a **per-engine timeout** (default 6s), always clamped to the time actually
  left on the global deadline;
* a **cap on concurrent engines**, chosen by health score rather than "all of
  them";
* a **circuit breaker** per engine that survives across requests.

Rows are cached per `(engine, category, query)`. That halves the load on the
sites — upstream's own CI deliberately runs one query per plugin per day "to
avoid hammering the sites" — and it is what makes paging coherent: without it,
`offset=50` would re-scrape and merge a different set than `offset=0` did.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
from dataclasses import dataclass

import httpx

from .categories import BROWSE_TERMS, NOVA_TO_TSP, plan_request
from .config import Settings
from .magnet import infohash_from_magnet, parse_torrent
from .merge import apply_filters, merge, sort_candidates
from .models import SearchResult
from .nameparse import normalize_query, query_terms
from .normalize import Candidate, now_iso, to_candidate
from .provision import ProvisionReport
from .registry import LINK_NEEDS_DL, LINK_TORRENT_URL, Plugin
from .runner import EngineResult, EngineRow, EngineRunner

log = logging.getLogger(__name__)


@dataclass(slots=True)
class SearchQuery:
    """A validated TSP request."""

    q: str = ""
    cat: str = ""
    year: str = ""
    res: str = ""
    min_seeders: int = 0
    sort: str = ""
    limit: int = 50
    offset: int = 0


# --- health ----------------------------------------------------------------


@dataclass(slots=True)
class EngineState:
    consecutive_failures: int = 0
    open_until: float = 0.0
    ewma_ms: float = 0.0
    last_ok: float = 0.0
    last_error: str = ""
    trials: int = 0


class Breaker:
    """Per-engine circuit breaker and latency memory, held for the process life.

    The service is stateless by design, so this lives in memory: it is a
    performance signal, not durable state, and a fresh container starting with a
    clean slate is the correct behaviour.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._states: dict[str, EngineState] = {}

    def state(self, engine_id: str) -> EngineState:
        return self._states.setdefault(engine_id, EngineState())

    def available(self, engine_id: str) -> bool:
        state = self.state(engine_id)
        if state.open_until and time.monotonic() >= state.open_until:
            # Half-open: let one request through to see if the site came back.
            state.open_until = 0.0
            state.consecutive_failures = self.settings.breaker_failures - 1
        return state.open_until == 0.0

    def record(self, result: EngineResult) -> None:
        state = self.state(result.engine_id)
        state.trials += 1
        if result.ok:
            state.consecutive_failures = 0
            state.last_ok = time.monotonic()
            state.last_error = ""
            state.ewma_ms = (
                result.elapsed_ms if state.ewma_ms == 0 else 0.7 * state.ewma_ms + 0.3 * result.elapsed_ms
            )
        else:
            state.consecutive_failures += 1
            state.last_error = result.error
            if state.consecutive_failures >= self.settings.breaker_failures:
                state.open_until = time.monotonic() + self.settings.breaker_open_s
                log.warning(
                    "circuit opened for %s after %d failures: %s",
                    result.engine_id, state.consecutive_failures, result.error,
                )

    def score(self, plugin: Plugin) -> float:
        """Registry health, adjusted by what this process has actually seen."""
        state = self.state(plugin.id)
        score = plugin.base_score()
        score -= 0.25 * min(state.consecutive_failures, 3)
        if state.last_ok:
            score += 0.2
        if state.ewma_ms:
            # A engine that answers in 500ms is worth more than one taking 5s.
            score -= min(state.ewma_ms / 20000.0, 0.2)
        return score


# --- row cache -------------------------------------------------------------


class RowCache:
    """Tiny TTL cache of engine output, keyed by what was actually asked."""

    def __init__(self, settings: Settings) -> None:
        self._ttl = settings.cache_ttl_s
        self._max = settings.cache_max_entries
        self._entries: dict[tuple[str, str, str], tuple[float, list[EngineRow]]] = {}

    def get(self, key: tuple[str, str, str]) -> list[EngineRow] | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        expires, rows = entry
        if time.monotonic() >= expires:
            self._entries.pop(key, None)
            return None
        return rows

    def put(self, key: tuple[str, str, str], rows: list[EngineRow]) -> None:
        if self._ttl <= 0:
            return
        if len(self._entries) >= self._max:
            # Cheap eviction: drop the oldest quarter. Insertion order is age
            # order because a refreshed key is re-inserted.
            for stale in list(itertools.islice(self._entries, max(1, self._max // 4))):
                self._entries.pop(stale, None)
        self._entries.pop(key, None)
        self._entries[key] = (time.monotonic() + self._ttl, rows)


# --- the service -----------------------------------------------------------


@dataclass(slots=True)
class _Plan:
    plugin: Plugin
    nova_category: str
    precise_category: str | None


class SearchService:
    def __init__(self, settings: Settings, report: ProvisionReport) -> None:
        self.settings = settings
        self.report = report
        self.runner = EngineRunner(settings)
        self.breaker = Breaker(settings)
        self.cache = RowCache(settings)
        # One cycle per category, plus one for "no category asked for". Sharing
        # a single cycle would browse `cat=audio` for a video word, which asks
        # every plugin's music category for something no music torrent is
        # called; `""` is the only one the operator can override.
        self._browse = {cat: itertools.cycle(terms) for cat, terms in BROWSE_TERMS.items()}
        self._browse[""] = itertools.cycle(settings.browse_queries or ("1080p",))
        self._http: httpx.AsyncClient | None = None

    def _browse_term(self, category: str) -> str:
        """The generic query that stands in for an empty `q`, for *category*."""
        return next(self._browse.get(category) or self._browse[""])

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                timeout=self.settings.resolve_timeout_s,
                follow_redirects=True,
                headers={"User-Agent": "utsi/1.0"},
            )
        return self._http

    # --- engine selection --------------------------------------------------

    def plan(self, category: str) -> list[_Plan]:
        """Engines to query, best first, capped at the per-request limit."""
        plans: list[tuple[float, _Plan]] = []
        for plugin in self.report.available():
            if not self.breaker.available(plugin.id):
                continue
            choice = plan_request(category, tuple(plugin.categories))
            if choice is None:
                continue
            nova_category, precise = choice
            plans.append((
                self.breaker.score(plugin),
                _Plan(
                    plugin=plugin,
                    nova_category=nova_category,
                    precise_category=NOVA_TO_TSP.get(nova_category) if precise else None,
                ),
            ))

        plans.sort(key=lambda item: (-item[0], item[1].plugin.id))
        return [plan for _score, plan in plans[: self.settings.max_engines_per_request]]

    # --- fan-out -----------------------------------------------------------

    async def _run_one(self, plan: _Plan, query: str, deadline: float) -> tuple[_Plan, list[EngineRow], bool]:
        key = (plan.plugin.id, plan.nova_category, query)
        cached = self.cache.get(key)
        if cached is not None:
            return plan, cached, True

        budget = min(self.settings.engine_timeout_s, deadline - time.monotonic())
        result = await self.runner.search(plan.plugin.id, plan.nova_category, query, timeout=budget)
        self.breaker.record(result)
        if result.ok:
            self.cache.put(key, result.rows)
        else:
            log.info("engine %s failed: %s", plan.plugin.id, result.error)
        return plan, result.rows, result.ok

    def _seen_enough(self, answered: int, rows: int, needed: int) -> bool:
        """Whether the fan-out can stop before every engine has reported.

        A meta-search is only as fast as its slowest member unless it is willing
        to leave one behind. Waiting for all twelve when three have already
        produced several pages of results buys almost nothing and costs the
        whole tail — one 6s site turns a 400ms response into a 6s one.

        Both conditions matter. The engine count protects merge quality: swarm
        counts are `max()`-ed across engines and duplicates collapse by
        infohash, so a single engine's view is measurably worse than three.

        Off by default. The cost is paging: two requests for the same query can
        stop on different engine subsets, so `offset=0` then `offset=50` is no
        longer a coherent sequence. Worth it for a client that shows one page,
        wrong for one that pages.
        """
        if self.settings.early_exit_engines <= 0:
            return False
        return (
            answered >= self.settings.early_exit_engines
            and rows >= needed * self.settings.early_exit_rows_factor
        )

    async def _fan_out(
        self, plans: list[_Plan], query: str, deadline: float, needed: int
    ) -> tuple[list[Candidate], list[str], bool]:
        pending = {asyncio.create_task(self._run_one(plan, query, deadline)) for plan in plans}
        candidates: list[Candidate] = []
        answered: list[str] = []

        while pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            done, pending = await asyncio.wait(
                pending, timeout=remaining, return_when=asyncio.FIRST_COMPLETED
            )
            if not done:  # the global deadline expired
                break

            for task in done:
                try:
                    plan, rows, ok = task.result()
                except Exception:  # pragma: no cover - defensive
                    log.exception("engine task crashed")
                    continue
                if not ok:
                    continue
                answered.append(plan.plugin.id)
                candidates.extend(
                    candidate
                    for row in rows
                    if (candidate := to_candidate(row, plan.plugin.id, plan.precise_category)) is not None
                )

            if self._seen_enough(len(answered), len(candidates), needed):
                log.debug(
                    "early exit: %d engines, %d rows, %d still running",
                    len(answered), len(candidates), len(pending),
                )
                break

        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

        # `partial` means "not every engine got to speak", whether that was the
        # deadline or the early exit. Either way the client is seeing a subset.
        return candidates, sorted(answered), bool(pending)

    # --- link resolution ---------------------------------------------------

    async def _resolve(self, candidate: Candidate, deadline: float) -> bool:
        """Turn a non-magnet link into a magnet. True when it worked."""
        budget = min(self.settings.resolve_timeout_s, deadline - time.monotonic())
        if budget <= 0:
            return False

        if candidate.link_kind == LINK_TORRENT_URL:
            try:
                response = await self._client().get(candidate.link, timeout=budget)
                response.raise_for_status()
            except (httpx.HTTPError, ValueError):
                return False
            data = response.content[: self.settings.torrent_max_bytes]
            meta = parse_torrent(data)
            if meta is None:
                return False
            candidate.apply_torrent_meta(meta)
            return True

        if candidate.link_kind == LINK_NEEDS_DL:
            magnet = await self.runner.resolve_download(candidate.engine_id, candidate.link, timeout=budget)
            if not magnet:
                return False
            infohash = infohash_from_magnet(magnet)
            if infohash is None:
                return False
            candidate.magnet = magnet
            candidate.infohash = infohash
            return True

        return False

    async def _resolve_window(
        self, ordered: list[Candidate], query: SearchQuery, deadline: float
    ) -> list[Candidate]:
        """Resolve only the unresolved rows that could reach the client's page.

        Resolving every row would cost one extra round trip each and blow the
        latency budget, so only the prefix the request can actually see is
        resolved, bounded by `UTSI_MAX_RESOLVE`. Rows past that, and rows that
        fail to resolve, are dropped: TSP requires a magnet on every row.
        """
        horizon = query.offset + query.limit + self.settings.resolve_lookahead
        prefix, rest = ordered[:horizon], ordered[horizon:]

        pending = [c for c in prefix if not c.resolved][: self.settings.max_resolve]
        if pending:
            await asyncio.gather(*(self._resolve(c, deadline) for c in pending), return_exceptions=True)

        keep = [c for c in prefix if c.resolved]
        keep.extend(c for c in rest if c.resolved)
        return keep

    # --- entry point -------------------------------------------------------

    async def search(self, query: SearchQuery) -> SearchResult:
        started = time.monotonic()
        deadline = started + self.settings.request_deadline_s

        terms = normalize_query(query.q)
        browsing = False
        if not terms:
            # Empty `q` is legal in TSP ("browse the whole index") but there is
            # no index to browse. Either answer with a rotating generic query or
            # answer empty — never 400.
            if self.settings.empty_query_mode == "empty":
                return SearchResult(
                    query=query.q, count=0, limit=query.limit, offset=query.offset,
                    took_ms=int((time.monotonic() - started) * 1000), torrents=[], engines=[],
                )
            terms = self._browse_term(query.cat)
            browsing = True

        # The words a row has to answer, and the one search with none: browsing.
        # The term standing in for an empty `q` is this server's own invention,
        # and holding a client's "show me the index" to a word it never typed
        # would hide rows rather than narrow them.
        gate: tuple[str, ...] = ()
        if not browsing and self.settings.query_match != "off":
            gate = query_terms(terms)

        plans = self.plan(query.cat)
        candidates, answered, timed_out = await self._fan_out(
            plans, terms, deadline, query.offset + query.limit
        )

        merged = merge(candidates)
        filtered = apply_filters(
            merged,
            terms=gate,
            category=query.cat,
            year=query.year,
            resolution=query.res,
            min_seeders=query.min_seeders,
        )
        ordered = sort_candidates(filtered, query.sort)
        resolved = await self._resolve_window(ordered, query, deadline)

        # Resolution reveals infohashes the first pass could not see, so the
        # same content from a magnet engine and a .torrent engine collapses now.
        final = sort_candidates(merge(resolved), query.sort)

        scraped_at = now_iso()
        page = [
            torrent
            for candidate in final[query.offset : query.offset + query.limit]
            if (torrent := candidate.to_torrent(scraped_at)) is not None
        ]
        return SearchResult(
            query=query.q,
            count=len(final),
            limit=query.limit,
            offset=query.offset,
            took_ms=int((time.monotonic() - started) * 1000),
            torrents=page,
            engines=answered,
            partial=timed_out or None,
        )


def empty_result(query: SearchQuery, took_ms: int = 0) -> SearchResult:
    return SearchResult(
        query=query.q, count=0, limit=query.limit, offset=query.offset,
        took_ms=took_ms, torrents=[], engines=[],
    )


__all__ = ["Breaker", "EngineState", "RowCache", "SearchQuery", "SearchService", "empty_result"]
