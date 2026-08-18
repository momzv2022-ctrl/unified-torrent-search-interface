"""`utsi share` — the one command that produces a URL and a key.

The tunnel handshake needs Cloudflare, so a stub `cloudflared` stands in: it
prints the same banner shape the real one does, then stays up. That covers
everything this project owns — spawning it, finding the URL, checking the URL
answers, and shutting both halves down.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import textwrap
from dataclasses import replace
from pathlib import Path

import pytest

from utsi import share as share_mod
from utsi.share import QuickTunnel, find_url, install_hint, share, summary

REAL_BANNER = textwrap.dedent("""
    2026-08-11T09:56:50Z INF Thank you for trying Cloudflare Tunnel.
    2026-08-11T09:56:50Z INF Requesting new quick Tunnel on trycloudflare.com...
    2026-08-11T09:56:52Z INF +--------------------------------------------+
    2026-08-11T09:56:52Z INF |  https://calm-mode-tiny-fox.trycloudflare.com  |
    2026-08-11T09:56:52Z INF +--------------------------------------------+
""")


def test_finds_the_url_in_the_real_banner():
    assert find_url(REAL_BANNER) == "https://calm-mode-tiny-fox.trycloudflare.com"


@pytest.mark.parametrize(
    "line",
    [
        "",
        "INF Requesting new quick Tunnel on trycloudflare.com...",  # no scheme or subdomain
        "ERR Host not in allowlist: api.trycloudflare.com.",
    ],
)
def test_does_not_mistake_chatter_for_a_url(line):
    assert find_url(line) == ""


def test_the_summary_leads_with_the_two_things_that_matter():
    text = summary("https://x.trycloudflare.com", "secret-key", reachable=True)
    assert "https://x.trycloudflare.com" in text
    assert "secret-key" in text
    assert "Ctrl-C" in text
    # Nothing about the URL surviving the process, because it does not.
    assert "stops working" in text


def test_the_summary_says_so_when_the_url_did_not_answer():
    assert "did not answer" in summary("https://x.trycloudflare.com", "k", reachable=False)


def test_the_summary_is_honest_about_running_without_a_key():
    assert "unauthenticated" in summary("https://x.trycloudflare.com", "", reachable=True)


def test_install_hint_is_platform_specific():
    assert install_hint()  # never empty, whatever the platform


def _stub_cloudflared(tmp_path: Path, body: str) -> Path:
    """A fake `cloudflared` on PATH, so the tunnel plumbing can be exercised."""
    directory = tmp_path / "bin"
    directory.mkdir(exist_ok=True)
    script = directory / "cloudflared"
    script.write_text("#!/bin/sh\n" + body, encoding="utf-8")
    script.chmod(0o755)
    return directory


async def test_quick_tunnel_reports_the_url_and_stops_cleanly(tmp_path, monkeypatch):
    directory = _stub_cloudflared(
        tmp_path, 'echo "INF |  https://stub-tunnel.trycloudflare.com  |"\nexec sleep 60\n'
    )
    monkeypatch.setenv("PATH", f"{directory}{os.pathsep}{os.environ['PATH']}")

    tunnel = QuickTunnel(port=1)
    try:
        assert await tunnel.start() == "https://stub-tunnel.trycloudflare.com"
    finally:
        await tunnel.stop()
    assert tunnel._process.returncode is not None  # actually reaped


async def test_a_tunnel_that_dies_early_is_reported_not_hung(tmp_path, monkeypatch):
    directory = _stub_cloudflared(tmp_path, 'echo "ERR Host not in allowlist" >&2\nexit 1\n')
    monkeypatch.setenv("PATH", f"{directory}{os.pathsep}{os.environ['PATH']}")

    tunnel = QuickTunnel(port=1)
    with pytest.raises(RuntimeError, match="exited before reporting a URL"):
        await tunnel.start()
    await tunnel.stop()


async def test_a_silent_tunnel_times_out_rather_than_waiting_forever(tmp_path, monkeypatch):
    directory = _stub_cloudflared(tmp_path, "exec sleep 60\n")
    monkeypatch.setenv("PATH", f"{directory}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setattr(share_mod, "URL_TIMEOUT_S", 1.0)

    tunnel = QuickTunnel(port=1)
    with pytest.raises(RuntimeError, match="did not report a URL in time"):
        await tunnel.start()
    await tunnel.stop()


async def test_missing_cloudflared_explains_itself(settings, fixture_registry, monkeypatch, capsys):
    fixture_registry.save(settings.registry_path)
    monkeypatch.setenv("PATH", str(tmp_empty := Path("/nonexistent-bin")))
    assert not tmp_empty.exists()

    assert await share(settings, tunnel=True) == 1
    err = capsys.readouterr().err
    assert "not installed" in err
    assert "--no-tunnel" in err


@pytest.mark.parametrize(
    ("bound", "probed"),
    [
        ("0.0.0.0", "127.0.0.1"),   # wildcard: loopback reaches it
        ("::", "127.0.0.1"),
        ("", "127.0.0.1"),
        ("127.0.0.1", "127.0.0.1"),
        ("100.101.102.103", "100.101.102.103"),  # a Tailscale address
        ("192.168.1.20", "192.168.1.20"),        # a LAN address
    ],
)
def test_readiness_is_probed_where_the_server_actually_bound(bound, probed):
    """Binding to one address and polling another reports a healthy server dead."""
    assert share_mod.probe_host(bound) == probed


def test_ipv6_literals_are_bracketed_in_the_url():
    assert share_mod.origin("::1", 7860) == "http://[::1]:7860"
    assert share_mod.origin("127.0.0.1", 7860) == "http://127.0.0.1:7860"


async def test_serves_and_prints_the_local_url_without_a_tunnel(
    settings, fixture_registry, capsys, unused_port
):
    fixture_registry.save(settings.registry_path)
    local = replace(settings, port=unused_port, host="127.0.0.1")
    task = asyncio.create_task(share(local, tunnel=False))

    # Each readouterr() drains the buffer, so accumulate rather than sampling.
    printed = ""
    try:
        for _ in range(80):
            await asyncio.sleep(0.25)
            printed += capsys.readouterr().out
            if f"http://127.0.0.1:{unused_port}" in printed:
                break
        else:
            pytest.fail(f"share() never printed a URL; saw: {printed!r}")
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    assert local.api_key in printed
    assert "Ctrl-C" in printed
