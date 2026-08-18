"""Environment-driven settings.

Every knob is an env var so the same image runs on Hugging Face Spaces, Render,
Cloud Run and `docker run` with nothing but `-e`.
"""

from __future__ import annotations

import os
import secrets
import sys
from dataclasses import dataclass
from pathlib import Path

from .categories import BROWSE_TERMS

PREFIX = "UTSI_"

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off", ""}


def _raw(name: str) -> str | None:
    value = os.environ.get(PREFIX + name)
    return value.strip() if value is not None else None


def _str(name: str, default: str) -> str:
    value = _raw(name)
    return value if value else default


def _opt(name: str) -> str | None:
    value = _raw(name)
    return value or None


def _bool(name: str, default: bool) -> bool:
    value = _raw(name)
    if value is None:
        return default
    lowered = value.lower()
    if lowered in _TRUE:
        return True
    if lowered in _FALSE:
        return False
    raise ValueError(f"{PREFIX}{name} must be a boolean, got {value!r}")


def _int(name: str, default: int, *, minimum: int = 0) -> int:
    value = _raw(name)
    if not value:
        return default
    return max(minimum, int(value))


def _float(name: str, default: float, *, minimum: float = 0.0) -> float:
    value = _raw(name)
    if not value:
        return default
    return max(minimum, float(value))


def _tuple(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    value = _raw(name)
    if value is None:
        return default
    items = tuple(part.strip() for part in value.split(",") if part.strip())
    return items or default


def _default_registry_path() -> Path:
    """`./registry.json` when present, else the copy shipped beside the source tree."""
    cwd_candidate = Path.cwd() / "registry.json"
    if cwd_candidate.is_file():
        return cwd_candidate
    return Path(__file__).resolve().parents[2] / "registry.json"


def _default_key_file() -> Path:
    return Path.home() / ".utsi" / "api-key"


def load_or_create_key(path: Path) -> str:
    """The API key, kept across restarts.

    A key generated fresh on every boot means pasting a new one into the client
    after every restart, which nobody does twice. Persisting it makes stopping
    and starting the server free.
    """
    try:
        existing = path.read_text(encoding="utf-8").strip()
    except OSError:
        existing = ""
    if existing:
        return existing

    key = secrets.token_urlsafe(32)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Created 0600 rather than chmod'd afterwards: no window where the key
        # exists world-readable.
        handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            file.write(key + "\n")
    except OSError:
        # Read-only filesystem — a container image, say. An ephemeral key is
        # still a working key; it just goes back to changing on each boot.
        pass
    return key


@dataclass(frozen=True, slots=True)
class Settings:
    # --- serving -----------------------------------------------------------
    host: str = "0.0.0.0"
    port: int = 7860  # Hugging Face Spaces' default exposed port
    api_key: str = ""
    allow_anonymous: bool = False
    rate_limit_per_min: int = 30
    rate_limit_burst: int = 15
    # Browser origins allowed to call the API cross-site. Empty means no CORS
    # headers at all, which is what a native TSP client wants — CORS only
    # matters when the caller is a web page on another domain.
    cors_origins: tuple[str, ...] = ()
    # Header carrying the real client IP when something sits in front — a
    # tunnel, a CDN, a reverse proxy. Cloudflare sets `CF-Connecting-IP`.
    # Empty by default: a forwarded header is only as trustworthy as whatever
    # set it, and if nothing did, any client can put whatever it likes there and
    # get a fresh rate-limit bucket per request.
    trusted_proxy_header: str = ""
    # Serve the single-file browser client at `/`. Set 0 for a bare API.
    ui: bool = True

    # --- provisioning ------------------------------------------------------
    runtime_dir: Path = Path("/tmp/utsi-runtime")
    registry_path: Path = Path("registry.json")
    offline: bool = False
    fetch_concurrency: int = 8
    fetch_timeout_s: float = 20.0
    engines: tuple[str, ...] = ()
    include_private: bool = False
    strict_hosts: bool = False
    # Provision only the best N plugins by health score, rather than every
    # enabled one. Boot fetches and byte-compiles each plugin, so on a phone
    # this is the difference between sixty round trips and a dozen. 0 = all.
    max_plugins: int = 0

    # --- fan-out -----------------------------------------------------------
    request_deadline_s: float = 8.0
    engine_timeout_s: float = 6.0
    max_engines_per_request: int = 12
    breaker_failures: int = 3
    breaker_open_s: float = 900.0
    cache_ttl_s: float = 300.0
    cache_max_entries: int = 512
    # Stop waiting for stragglers once this many engines have answered with this
    # many times the requested page in rows.
    #
    # Off by default, and that is a correctness decision rather than caution:
    # TSP clients page, and a page-1 computed from three engines followed by a
    # page-2 computed from eight is not a coherent sequence. Turn it on when
    # latency matters more than paging — a client that only ever shows the first
    # page loses nothing.
    early_exit_engines: int = 0
    early_exit_rows_factor: int = 3

    # --- link resolution ---------------------------------------------------
    max_resolve: int = 10
    resolve_lookahead: int = 20
    resolve_timeout_s: float = 4.0
    torrent_max_bytes: int = 5 * 1024 * 1024

    # --- sandbox -----------------------------------------------------------
    python_executable: str = sys.executable
    stdout_max_bytes: int = 4 * 1024 * 1024
    stderr_max_bytes: int = 64 * 1024
    rlimit_as_mb: int = 512
    rlimit_cpu_s: int = 20
    rlimit_nofile: int = 256
    rlimit_fsize_mb: int = 32
    socks_proxy: str = ""

    # --- semantics ---------------------------------------------------------
    empty_query_mode: str = "browse"

    #: What an empty `q` browses when no category was asked for. With one, the
    #: category's own terms in `BROWSE_TERMS` are used instead — a video word
    #: asked of the music bucket finds nothing.
    browse_queries: tuple[str, ...] = BROWSE_TERMS["video"]

    @classmethod
    def from_env(cls) -> Settings:
        allow_anonymous = _bool("ALLOW_ANONYMOUS", False)
        api_key = _str("API_KEY", "")
        if not api_key and not allow_anonymous:
            key_file = _opt("KEY_FILE")
            api_key = load_or_create_key(Path(key_file) if key_file else _default_key_file())

        empty_query_mode = _str("EMPTY_QUERY_MODE", "browse").lower()
        if empty_query_mode not in ("browse", "empty"):
            raise ValueError(f"{PREFIX}EMPTY_QUERY_MODE must be 'browse' or 'empty'")

        registry = _opt("REGISTRY")
        return cls(
            host=_str("HOST", "0.0.0.0"),
            port=_int("PORT", int(os.environ.get("PORT", "7860")), minimum=1),
            api_key=api_key,
            allow_anonymous=allow_anonymous,
            rate_limit_per_min=_int("RATE_LIMIT_PER_MIN", 30),
            rate_limit_burst=_int("RATE_LIMIT_BURST", 15),
            cors_origins=_tuple("CORS_ORIGINS", ()),
            trusted_proxy_header=_str("TRUSTED_PROXY_HEADER", "").lower(),
            ui=_bool("UI", True),
            runtime_dir=Path(_str("RUNTIME_DIR", "/tmp/utsi-runtime")),
            registry_path=Path(registry) if registry else _default_registry_path(),
            offline=_bool("OFFLINE", False),
            fetch_concurrency=_int("FETCH_CONCURRENCY", 8, minimum=1),
            fetch_timeout_s=_float("FETCH_TIMEOUT_S", 20.0, minimum=1.0),
            engines=_tuple("ENGINES", ()),
            include_private=_bool("INCLUDE_PRIVATE", False),
            strict_hosts=_bool("STRICT_HOSTS", False),
            max_plugins=_int("MAX_PLUGINS", 0),
            request_deadline_s=_float("REQUEST_DEADLINE_S", 8.0, minimum=1.0),
            engine_timeout_s=_float("ENGINE_TIMEOUT_S", 6.0, minimum=1.0),
            max_engines_per_request=_int("MAX_ENGINES_PER_REQUEST", 12, minimum=1),
            breaker_failures=_int("BREAKER_FAILURES", 3, minimum=1),
            breaker_open_s=_float("BREAKER_OPEN_S", 900.0),
            cache_ttl_s=_float("CACHE_TTL_S", 300.0),
            cache_max_entries=_int("CACHE_MAX_ENTRIES", 512, minimum=1),
            early_exit_engines=_int("EARLY_EXIT_ENGINES", 0),
            early_exit_rows_factor=_int("EARLY_EXIT_ROWS_FACTOR", 3, minimum=1),
            max_resolve=_int("MAX_RESOLVE", 10),
            resolve_lookahead=_int("RESOLVE_LOOKAHEAD", 20),
            resolve_timeout_s=_float("RESOLVE_TIMEOUT_S", 4.0, minimum=0.5),
            torrent_max_bytes=_int("TORRENT_MAX_BYTES", 5 * 1024 * 1024, minimum=1024),
            python_executable=_str("PYTHON", sys.executable),
            stdout_max_bytes=_int("STDOUT_MAX_BYTES", 4 * 1024 * 1024, minimum=1024),
            stderr_max_bytes=_int("STDERR_MAX_BYTES", 64 * 1024, minimum=512),
            rlimit_as_mb=_int("RLIMIT_AS_MB", 512),
            rlimit_cpu_s=_int("RLIMIT_CPU_S", 20),
            rlimit_nofile=_int("RLIMIT_NOFILE", 256),
            rlimit_fsize_mb=_int("RLIMIT_FSIZE_MB", 32),
            # Upstream `helpers.enable_socks_proxy()` reads `qbt_socks_proxy`; accept
            # either spelling so a self-hoster can route the fan-out through an exit node.
            socks_proxy=_str("SOCKS_PROXY", os.environ.get("qbt_socks_proxy", "")),  # noqa: SIM112
            empty_query_mode=empty_query_mode,
            browse_queries=_tuple("BROWSE_QUERIES", BROWSE_TERMS["video"]),
        )
