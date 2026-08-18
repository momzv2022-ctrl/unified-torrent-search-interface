"""The HTTP surface: `GET /api/v1/search`, exactly as TSP specifies it.

Three conformance rules a naive implementation gets wrong, all enforced here:

* every row carries a `magnet` — rows that never resolved are dropped;
* `limit` is capped at 200 server-side, and clamped rather than rejected, since
  a 422 is not in TSP's retry contract;
* a bad key returns 401/403, never an empty result set.

`/api/v1/stats` is deliberately absent. TSP says absence is fine and clients
then offer every filter chip; a meta-search has no catalogue to count, so
reporting zeroes would be less honest than saying nothing.
"""

import asyncio
import logging
import secrets
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse

from . import __version__
from .categories import TSP_CATEGORIES
from .config import Settings
from .merge import SORTS
from .models import EngineStatus, ErrorResponse, SearchResult
from .nameparse import RESOLUTIONS
from .provision import Provisioner
from .registry import Registry
from .search import SearchQuery, SearchService, empty_result

log = logging.getLogger(__name__)

MAX_LIMIT = 200
DEFAULT_LIMIT = 50


class ApiError(Exception):
    """A response the client should see verbatim, raised from a dependency."""

    def __init__(self, status: int, error: str, detail: str, headers: dict[str, str] | None = None) -> None:
        super().__init__(error)
        self.status = status
        self.error = error
        self.detail = detail
        self.headers = headers


def _error(
    status: int, error: str, detail: str | None = None, headers: dict[str, str] | None = None
) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content=ErrorResponse(error=error, detail=detail).model_dump(exclude_none=True),
        headers=headers,
    )


class RateLimiter:
    """Sliding-window limiter, keyed by API key when there is one, else client IP.

    TSP clients back off and retry on 429, so shedding load this way is safe;
    dropping the connection is not.
    """

    def __init__(self, per_minute: int, burst: int) -> None:
        self.per_minute = per_minute
        self.burst = max(burst, 1)
        self._hits: dict[str, deque[float]] = {}

    def check(self, key: str) -> float:
        """Return 0 when allowed, else the seconds the client should back off."""
        if self.per_minute <= 0:
            return 0.0
        now = time.monotonic()
        window = self._hits.setdefault(key, deque())
        while window and now - window[0] >= 60.0:
            window.popleft()
        if len(window) >= max(self.per_minute, self.burst):
            return max(1.0, 60.0 - (now - window[0]))
        window.append(now)
        if len(self._hits) > 4096:
            self._prune(now)
        return 0.0

    def _prune(self, now: float) -> None:
        for key in [k for k, w in self._hits.items() if not w or now - w[-1] >= 60.0]:
            self._hits.pop(key, None)


#: Below this, a key is guessable in seconds. Generated keys are 43 characters.
MIN_SANE_KEY_LENGTH = 16


def browser_ui() -> str:
    """The single-file browser client served at `/`.

    Kept as a file rather than a string so it stays editable as HTML. Read once
    per process; it is a few kilobytes and never changes at runtime.
    """
    return (Path(__file__).with_name("ui.html")).read_text(encoding="utf-8")


def client_identity(request: Request, settings: Settings) -> str:
    """Who to rate-limit an unauthenticated request as.

    Behind a tunnel every request arrives from 127.0.0.1, so the socket address
    identifies the tunnel rather than the caller and one bucket would be shared
    by everyone. `UTSI_TRUSTED_PROXY_HEADER` names the header to believe
    instead — only set it when something in front actually sets that header,
    since otherwise a client can forge it and mint itself a bucket per request.
    """
    if settings.trusted_proxy_header:
        forwarded = request.headers.get(settings.trusted_proxy_header)
        if forwarded:
            # X-Forwarded-For style headers are a chain; the first entry is the
            # original client, the rest are intermediaries.
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "anonymous"


def _announce(settings: Settings, registry: Registry) -> None:
    if settings.allow_anonymous:
        log.warning(
            "UTSI_ALLOW_ANONYMOUS=1 — this instance is unauthenticated. "
            "An open scraper proxy on a public URL will be found and abused."
        )
    else:
        log.info("API key (send it as the X-API-Key header): %s", settings.api_key)
        if len(settings.api_key) < MIN_SANE_KEY_LENGTH:
            # Worth saying even when bound to localhost: a tunnel is one command
            # away, and this key is the only thing gating the fan-out.
            log.warning(
                "UTSI_API_KEY is only %d characters. Fine for local testing, not for a "
                "public URL — generate one with `python3 -c \"import secrets; "
                'print(secrets.token_urlsafe(32))"`.',
                len(settings.api_key),
            )
    log.info(
        "registry %s: %d plugins, nova3 core pinned at %s",
        settings.registry_path, len(registry.plugins), registry.runtime.ref[:12] or "master",
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    registry = Registry.load(settings.registry_path)
    provisioner = Provisioner(settings, registry)
    limiter = RateLimiter(settings.rate_limit_per_min, settings.rate_limit_burst)

    service_lock = asyncio.Lock()
    service_ref: list[SearchService] = []

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # Bind the port first and provision in the background: free tiers health
        # check immediately, and a slow plugin fetch must not read as a crash.
        task = asyncio.create_task(provisioner.provision())
        _announce(settings, registry)
        try:
            yield
        finally:
            task.cancel()
            for existing in service_ref:
                await existing.aclose()

    app = FastAPI(
        title="Unified Torrent Search Interface",
        version=__version__,
        summary="A Torrent Stream Protocol index backed by qBittorrent search plugins.",
        lifespan=lifespan,
    )

    if settings.cors_origins:
        # Only needed when the caller is a web page on another origin — a native
        # TSP client is unaffected either way. Named origins only: a wildcard
        # would let any page on the internet spend this instance's rate limit.
        # No credentials, because auth is a header rather than a cookie.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=False,
            allow_methods=["GET", "OPTIONS"],
            allow_headers=["X-API-Key", "Content-Type"],
            max_age=600,
        )
        log.info("CORS enabled for: %s", ", ".join(settings.cors_origins))

    async def service() -> SearchService:
        if service_ref:
            return service_ref[0]
        async with service_lock:
            if not service_ref:
                report = await provisioner.wait_ready()
                service_ref.append(SearchService(settings, report))
        return service_ref[0]

    async def authorize(
        request: Request,
        x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
    ) -> str:
        if not settings.allow_anonymous:
            if not x_api_key:
                raise ApiError(401, "missing_api_key", "Send the key in the X-API-Key header.")
            if not secrets.compare_digest(x_api_key, settings.api_key):
                raise ApiError(403, "invalid_api_key", "The X-API-Key header did not match.")
        # A key identifies its holder and cannot be forged; only fall back to
        # the network address when there is no key.
        identity = x_api_key or client_identity(request, settings)
        retry_after = limiter.check(identity)
        if retry_after:
            raise ApiError(
                429, "rate_limited", f"Retry in {int(retry_after)}s.",
                {"Retry-After": str(int(retry_after))},
            )
        return identity

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return _error(exc.status, exc.error, exc.detail, exc.headers)

    if settings.ui:
        page = browser_ui()

        @app.get("/", include_in_schema=False, response_class=HTMLResponse)
        async def ui() -> HTMLResponse:
            """A browser is the client. No app to install, and pointing a phone
            at a fresh tunnel answers "did that work?" with more than a 404.

            Unauthenticated because it has to be — a browser cannot send a
            header when following a link. The page itself carries no key and no
            data; it asks for the key and holds it client-side.
            """
            return HTMLResponse(page)

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> JSONResponse:
        report = provisioner.report
        return JSONResponse({
            "status": "ok",
            "version": __version__,
            "engines_ready": len(report.available()),
            "engines_configured": len(report.slots),
            # Lets the browser client hide the key field, and say so plainly.
            "anonymous": settings.allow_anonymous,
            "core_error": report.core_error or None,
        })

    @app.get(
        "/api/v1/search",
        response_model=SearchResult,
        response_model_exclude_none=True,
        summary="Search the index, or list it when q is empty",
        responses={
            400: {"model": ErrorResponse}, 401: {"model": ErrorResponse},
            403: {"model": ErrorResponse}, 429: {"model": ErrorResponse},
        },
    )
    async def search(
        _identity: Annotated[str, Depends(authorize)],
        q: str = Query("", description="Search terms; `. _ -` are separators, word order is irrelevant."),
        cat: str = Query("", description="TSP category filter; empty for all."),
        year: str = Query("", description="Four-digit year, or empty."),
        res: str = Query("", description="One of 2160p, 1080p, 720p, 480p."),
        min_seeders: int = Query(0, ge=0),
        sort: str = Query("", description="seeders | size | recent; empty means server default."),
        limit: int = Query(DEFAULT_LIMIT, description=f"Clamped to 1..{MAX_LIMIT}."),
        offset: int = Query(0, description="Clamped to >= 0."),
    ):
        if cat and cat not in TSP_CATEGORIES:
            return _error(400, "invalid_cat", f"cat must be one of {', '.join(TSP_CATEGORIES)}")
        if sort and sort not in SORTS:
            return _error(400, "invalid_sort", "sort must be one of seeders, size, recent")
        if res and res not in RESOLUTIONS:
            return _error(400, "invalid_res", f"res must be one of {', '.join(RESOLUTIONS)}")
        if year and not (year.isdigit() and len(year) == 4):
            return _error(400, "invalid_year", "year must be four digits")

        query = SearchQuery(
            q=q, cat=cat, year=year, res=res,
            min_seeders=max(0, min_seeders),
            sort=sort,
            limit=max(1, min(limit, MAX_LIMIT)),
            offset=max(0, offset),
        )

        started = time.monotonic()
        searcher = await service()
        if not searcher.report.available():
            # Nothing to fan out to. An empty page is the honest answer and it
            # keeps clients from retrying a 5xx they cannot fix.
            log.warning("search with no provisioned engines: %s", searcher.report.core_error)
            return empty_result(query, int((time.monotonic() - started) * 1000))
        return await searcher.search(query)

    @app.get(
        "/api/v1/engines",
        response_model=list[EngineStatus],
        summary="Engine roster and live health (not part of TSP)",
    )
    async def engines(_identity: Annotated[str, Depends(authorize)]) -> list[EngineStatus]:
        searcher = await service()
        rows = []
        for slot in searcher.report.slots.values():
            plugin = slot.plugin
            engine_state = searcher.breaker.state(plugin.id)
            rows.append(EngineStatus(
                id=plugin.id,
                name=plugin.site or plugin.id,
                url=plugin.url,
                source=plugin.source,
                link_kind=plugin.link_kind,
                categories=list(plugin.categories),
                provisioned=slot.ok,
                breaker_open=not searcher.breaker.available(plugin.id),
                consecutive_failures=engine_state.consecutive_failures,
                last_error=engine_state.last_error or slot.error or None,
                median_ms=int(engine_state.ewma_ms) or plugin.health.median_ms,
                score=round(searcher.breaker.score(plugin), 3),
            ))
        return sorted(rows, key=lambda row: (not row.provisioned, row.id))

    return app
