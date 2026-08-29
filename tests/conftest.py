"""Offline test rig.

The runtime directory is assembled from `tests/fixtures/` instead of being
fetched, and the settings point at a registry that lists only fixture engines.
Nothing in the suite touches the network or a real torrent site.
"""

from __future__ import annotations

import hashlib
import http.server
import shutil
import threading
from dataclasses import replace
from pathlib import Path

import pytest

from utsi.config import Settings
from utsi.registry import LINK_MAGNET, LINK_NEEDS_DL, LINK_TORRENT_URL, LINK_UNKNOWN, Plugin, Registry

FIXTURES = Path(__file__).parent / "fixtures"

#: Fixture engines: link shape, declared categories, and whether the default
#: registry includes them. `fixslow` hangs on purpose, so it is opt-in — only
#: the test that measures deadline behaviour should pay for it.
FIXTURE_ENGINES = {
    "fixmagnet": (LINK_MAGNET, ["all", "movies", "tv", "music"], True),
    "fixoverlap": (LINK_MAGNET, ["all"], True),
    "fixtorrent": (LINK_TORRENT_URL, ["all", "movies"], True),
    "fixdl": (LINK_NEEDS_DL, ["all"], True),
    "fixnoisy": (LINK_UNKNOWN, ["all", "music"], True),
    "fixbroken": (LINK_UNKNOWN, ["all"], True),
    "fixcase": (LINK_MAGNET, ["all"], True),
    "fixenv": (LINK_UNKNOWN, ["all"], False),
    "fixslow": (LINK_UNKNOWN, ["all"], False),
}


def bencode(value) -> bytes:
    """Minimal bencoder, used to build .torrent files the tests can verify."""
    if isinstance(value, int):
        return b"i%de" % value
    if isinstance(value, bytes):
        return b"%d:%s" % (len(value), value)
    if isinstance(value, str):
        return bencode(value.encode())
    if isinstance(value, list):
        return b"l" + b"".join(bencode(item) for item in value) + b"e"
    if isinstance(value, dict):
        items = sorted((k if isinstance(k, bytes) else k.encode(), v) for k, v in value.items())
        return b"d" + b"".join(bencode(k) + bencode(v) for k, v in items) + b"e"
    raise TypeError(type(value))


def make_torrent(name: str = "Fixture Torrent Release", length: int = 123456) -> tuple[bytes, str]:
    """A single-file .torrent and the v1 infohash a client should derive."""
    info = {"name": name, "piece length": 262144, "pieces": b"\x00" * 20, "length": length}
    payload = {"announce": "udp://tracker.fixture.test:6969/announce", "info": info}
    return bencode(payload), hashlib.sha1(bencode(info), usedforsecurity=False).hexdigest()


TORRENT_BYTES, TORRENT_INFOHASH = make_torrent()


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/files/sample.torrent":
            self.send_response(200)
            self.send_header("Content-Type", "application/x-bittorrent")
            self.send_header("Content-Length", str(len(TORRENT_BYTES)))
            self.end_headers()
            self.wfile.write(TORRENT_BYTES)
        else:
            self.send_error(404)

    def log_message(self, *args) -> None:
        return


@pytest.fixture
def unused_port() -> int:
    """A port the OS just confirmed is free."""
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture(scope="session")
def torrent_origin() -> str:
    """A local origin serving one .torrent, for the resolution path."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def runtime_dir(tmp_path: Path, torrent_origin: str) -> Path:
    runtime = tmp_path / "runtime"
    engines = runtime / "engines"
    engines.mkdir(parents=True)
    for core in FIXTURES.glob("nova3/*.py"):
        shutil.copyfile(core, runtime / core.name)
    for engine in FIXTURES.glob("engines/*.py"):
        shutil.copyfile(engine, engines / engine.name)
    # The runner hands plugins an allowlisted environment, so the test server's
    # port has to reach `fixtorrent` some other way.
    (engines / "_fixture_origin.txt").write_text(torrent_origin, encoding="utf-8")
    return runtime


def make_registry(*, enable: tuple[str, ...] = ()) -> Registry:
    """The fixture registry; *enable* switches on engines that are off by default."""
    return Registry(
        generated_at="2026-01-01T00:00:00Z",
        plugins=[
            Plugin(
                id=engine_id,
                url=f"https://fixtures.invalid/{engine_id}.py",
                source="official",
                site=f"https://{engine_id}.test",
                link_kind=link_kind,
                categories=categories,
                pinned_sha256=None,
                enabled=default_on or engine_id in enable,
            )
            for engine_id, (link_kind, categories, default_on) in FIXTURE_ENGINES.items()
        ],
    )


@pytest.fixture
def fixture_registry(tmp_path: Path) -> Registry:
    path = tmp_path / "registry.json"
    make_registry().save(path)
    return Registry.load(path)


@pytest.fixture
def settings(tmp_path: Path, runtime_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    registry_path = tmp_path / "registry.json"
    return Settings(
        runtime_dir=runtime_dir,
        registry_path=registry_path,
        offline=True,
        api_key="test-key",
        allow_anonymous=False,
        engine_timeout_s=6.0,
        request_deadline_s=10.0,
        resolve_timeout_s=4.0,
        cache_ttl_s=0.0,
        rate_limit_per_min=1000,
        # The fixture engines answer every query with the same canned rows, and
        # the suite asks them for `q="anything"` to say so. Holding those rows
        # to a query they were never written to answer would test the gate in
        # every test rather than the thing each test is about, so the gate is
        # off in the rig and on by name in the tests that are about it.
        query_match="off",
    )


@pytest.fixture
def settings_factory(settings: Settings):
    """Build a variant of the base settings without repeating every field."""

    def make(**overrides) -> Settings:
        return replace(settings, **overrides)

    return make
