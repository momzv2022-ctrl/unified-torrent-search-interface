"""`qbittorrent/utsi.py`, run the way qBittorrent runs it: a separate process,
the nova3 printer on the path, one line of output per result.

The file ships with `URL` and `KEY` empty, and the setup page fills them in by
replacing those two lines in the browser. The tests splice the same way, so a
file whose two lines have drifted from what the page looks for fails here.
"""

from __future__ import annotations

import http.server
import json
import subprocess
import sys
import threading
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PLUGIN = REPO / "qbittorrent" / "utsi.py"
NOVA3 = REPO / "tests" / "fixtures" / "nova3"

EMPTY_URL = 'URL = ""'
EMPTY_KEY = 'KEY = ""'

KEY = "abcd-efgh-jkmn-pqrs-tuvw-xyz2"

ANSWER = {
    "query": "big buck bunny",
    "count": 3,
    "took_ms": 412,
    "engines": ["knaben", "yts"],
    "torrents": [
        {
            "magnet": "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big%20Buck%20Bunny",
            "name": "Big Buck Bunny 2008 1080p BluRay x264-GRP",
            "size_bytes": 1073741824,
            "seeders": 340,
            "leechers": 12,
            "description_url": "https://index.test/view/1",
            "first_seen": "2019-01-01T00:00:00Z",
        },
        {
            # No size, no swarm counts, no date: every unknown is -1, never 0.
            "magnet": "magnet:?xt=urn:btih:3333333333333333333333333333333333333333",
            "name": "Sintel (2010) 1080p | with a pipe in the name",
        },
        {
            # A row with no link at all is dropped rather than printed broken.
            "name": "nothing to download here",
            "seeders": 5,
        },
    ],
}


class _Server(http.server.ThreadingHTTPServer):
    requests: list[dict]
    reply: tuple[int, str]


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        server: _Server = self.server  # type: ignore[assignment]
        # urllib sends the header as `X-api-key`; what matters is that the
        # server, which reads headers case-insensitively, finds it.
        server.requests.append({"path": self.path, "key": self.headers.get("X-API-Key")})
        status, body = server.reply
        if self.headers.get("X-API-Key") != KEY and status == 200:
            status, body = 403, json.dumps({"error": "invalid_api_key"})
        payload = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args) -> None:
        return


@pytest.fixture
def server():
    instance = _Server(("127.0.0.1", 0), _Handler)
    instance.requests = []
    instance.reply = (200, json.dumps(ANSWER))
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    try:
        yield instance
    finally:
        instance.shutdown()
        instance.server_close()


def filled_in(url: str, key: str) -> str:
    """The plugin with its two lines filled in, exactly as the setup page does it."""
    source = PLUGIN.read_text(encoding="utf-8")
    assert source.count(EMPTY_URL) == 1 and source.count(EMPTY_KEY) == 1
    return source.replace(EMPTY_URL, f'URL = "{url}"').replace(EMPTY_KEY, f'KEY = "{key}"')


def run(tmp_path: Path, source: str, what: str, cat: str = "all") -> subprocess.CompletedProcess:
    """Run `utsi().search(what, cat)` in a fresh interpreter, like nova2 does."""
    (tmp_path / "utsi.py").write_text(source, encoding="utf-8")
    return subprocess.run(
        [sys.executable, "-c", f"import utsi; utsi.utsi().search({what!r}, {cat!r})"],
        cwd=tmp_path,
        env={"PYTHONPATH": f"{tmp_path}:{NOVA3}", "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_the_committed_file_ships_empty_and_names_its_class_after_itself():
    source = PLUGIN.read_text(encoding="utf-8")
    assert source.count(EMPTY_URL) == 1, "the setup page looks for exactly this line"
    assert source.count(EMPTY_KEY) == 1, "the setup page looks for exactly this line"
    # qBittorrent refuses a plugin whose class is not named after its file.
    assert "\nclass utsi:" in source
    # The two lines come before any code, so a person opening the file finds
    # them without reading past the header.
    assert source.index(EMPTY_URL) < source.index("\nimport ")
    # Standard library only, which is qBittorrent's rule for plugins. The one
    # exception is the printer qBittorrent itself supplies.
    imported = {
        line.split()[1].split(".")[0]
        for line in source.splitlines()
        if line.startswith(("import ", "from "))
    }
    assert imported <= {"json", "sys", "urllib", "datetime", "novaprinter"}, imported


def test_a_search_asks_the_url_with_the_key_and_prints_nova3_rows(tmp_path, server):
    origin = f"http://127.0.0.1:{server.server_port}"
    result = run(tmp_path, filled_in(origin + "/", KEY), "big%20buck%20bunny", "movies")

    assert result.returncode == 0, result.stderr
    assert result.stderr == ""

    [request] = server.requests
    assert request["path"] == "/api/v1/search?q=big%20buck%20bunny&limit=100&cat=video"
    assert request["key"] == KEY

    lines = result.stdout.splitlines()
    assert len(lines) == 2, lines
    assert lines[0].split("|") == [
        "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big%20Buck%20Bunny",
        "Big Buck Bunny 2008 1080p BluRay x264-GRP",
        "1073741824",
        "340",
        "12",
        origin,
        "https://index.test/view/1",
        "1546300800",
    ]
    assert lines[1].split("|") == [
        "magnet:?xt=urn:btih:3333333333333333333333333333333333333333",
        "Sintel (2010) 1080p   with a pipe in the name",
        "-1",
        "-1",
        "-1",
        origin,
        "",
        "-1",
    ]


def test_all_means_no_category_filter(tmp_path, server):
    origin = f"http://127.0.0.1:{server.server_port}"
    run(tmp_path, filled_in(origin, KEY), "ubuntu", "all")
    [request] = server.requests
    assert request["path"] == "/api/v1/search?q=ubuntu&limit=100"


def test_every_qbittorrent_category_maps_to_one_the_url_accepts(tmp_path, server):
    origin = f"http://127.0.0.1:{server.server_port}"
    accepted = {"video", "audio", "software", "archive", "document", "image"}
    for cat in ["movies", "tv", "anime", "music", "games", "software", "pictures", "books"]:
        server.requests.clear()
        run(tmp_path, filled_in(origin, KEY), "x", cat)
        [request] = server.requests
        sent = request["path"].split("&cat=")[1]
        assert sent in accepted, (cat, sent)


def test_an_unfilled_file_says_so_and_asks_nothing(tmp_path, server):
    result = run(tmp_path, PLUGIN.read_text(encoding="utf-8"), "x")
    assert result.returncode == 0
    assert result.stdout == ""
    assert "URL or KEY is empty" in result.stderr
    assert server.requests == []


def test_a_refused_key_is_named_not_hidden(tmp_path, server):
    origin = f"http://127.0.0.1:{server.server_port}"
    result = run(tmp_path, filled_in(origin, "not-the-key"), "x")
    assert result.returncode == 0
    assert result.stdout == ""
    assert "refused the key" in result.stderr


def test_a_url_that_does_not_answer_fails_quietly(tmp_path, unused_port):
    result = run(tmp_path, filled_in(f"http://127.0.0.1:{unused_port}", KEY), "x")
    assert result.returncode == 0
    assert result.stdout == ""
    assert "could not reach" in result.stderr


def test_an_answer_that_is_not_json_is_not_printed_as_rows(tmp_path, server):
    server.reply = (200, "<html>not a search url</html>")
    origin = f"http://127.0.0.1:{server.server_port}"
    result = run(tmp_path, filled_in(origin, KEY), "x")
    assert result.stdout == ""
    assert "not JSON" in result.stderr
