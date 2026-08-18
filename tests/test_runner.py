"""The sandboxed subprocess: isolation, timeouts, failure attribution."""

from __future__ import annotations

import json
import os
import time

import pytest

from utsi.provision import Provisioner
from utsi.runner import EngineRunner, build_env


@pytest.fixture
async def runner(settings, fixture_registry) -> EngineRunner:
    await Provisioner(settings, fixture_registry).provision()
    return EngineRunner(settings)


async def test_engine_rows_come_back_parsed(runner):
    result = await runner.search("fixmagnet", "all", "anything")
    assert result.ok
    assert result.exit_code == 0
    assert len(result.rows) == 4
    assert result.rows[0].name.startswith("Big Buck Bunny")
    assert result.rows[0].link.startswith("magnet:")


async def test_a_raising_plugin_is_a_clean_failure_not_a_crash(runner):
    result = await runner.search("fixbroken", "all", "q")
    assert not result.ok
    assert result.rows == []
    assert "challenge page" in result.stderr


async def test_a_hanging_plugin_is_killed_at_the_timeout(runner):
    started = time.monotonic()
    result = await runner.search("fixslow", "all", "q", timeout=2.0)
    elapsed = time.monotonic() - started
    assert not result.ok
    assert "timeout" in result.error
    # The kill must be prompt; the fixture would otherwise sleep for 600s.
    assert elapsed < 6.0


async def test_debug_chatter_does_not_become_results(runner):
    result = await runner.search("fixnoisy", "all", "q")
    assert result.ok
    assert len(result.rows) == 1
    row = result.rows[0]
    assert row.name.startswith("Pink Floyd")
    assert row.size_bytes == round(1.4 * 2**30)  # "1.4 GB" is converted upstream, not here
    assert row.seeders is None and row.leechers is None


async def test_class_name_case_mismatch_still_loads(runner):
    # `fixcase.py` defines `class FixCase`; nova3 would drop it outright.
    result = await runner.search("fixcase", "all", "q")
    assert result.ok
    assert len(result.rows) == 1


async def test_undeclared_category_is_reported_not_silently_dropped(runner):
    result = await runner.search("fixoverlap", "movies", "q")
    assert not result.ok
    assert "does not declare category" in result.stderr


async def _introspect(runner: EngineRunner, query: str = "hello world") -> dict[str, str]:
    """Run `fixenv`, which reports what the child process actually received."""
    _code, stdout, _stderr, _ms = await runner._spawn(["search", "fixenv", "all", query], 15.0)
    return {
        line.split(" ", 1)[0]: line.split(" ", 1)[1]
        for line in stdout.splitlines()
        if line.startswith(("ENV ", "ARGV ", "WHAT "))
    }


async def test_the_plugin_environment_carries_no_secrets(runner, monkeypatch):
    monkeypatch.setenv("UTSI_API_KEY", "super-secret")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "also-secret")

    child_env = json.loads((await _introspect(runner))["ENV"])
    assert "UTSI_API_KEY" not in child_env
    assert "AWS_SECRET_ACCESS_KEY" not in child_env
    assert child_env["PATH"] == "/usr/local/bin:/usr/bin:/bin"


async def test_the_query_reaches_the_plugin_percent_quoted(runner):
    # nova2.py quotes the space-joined keywords before the plugin sees them.
    assert (await _introspect(runner))["WHAT"] == "hello%20world"


async def test_plugins_do_not_see_our_argv(runner):
    assert len(json.loads((await _introspect(runner))["ARGV"])) == 1


async def test_download_resolution_splits_on_the_last_space(runner):
    magnet = await runner.resolve_download("fixdl", "https://fixdl.test/torrent/resolvable")
    assert magnet is not None
    assert magnet == "magnet:?xt=urn:btih:3333333333333333333333333333333333333333&dn=resolved"


async def test_download_resolution_failure_returns_none(runner):
    assert await runner.resolve_download("fixdl", "https://fixdl.test/torrent/broken") is None


async def test_info_reports_declared_capabilities(runner):
    info = await runner.info("fixmagnet")
    assert info is not None
    assert info["url"] == "https://fixmagnet.test"
    assert info["supported_categories"] == ["all", "movies", "music", "tv"]
    assert info["has_download_torrent"] is False


async def test_missing_engine_is_an_import_failure(runner):
    result = await runner.search("does_not_exist", "all", "q")
    assert not result.ok
    assert "ModuleNotFoundError" in result.stderr


def test_socks_proxy_is_the_only_optional_variable_passed(settings_factory):
    env = build_env(settings_factory(socks_proxy="socks5h://127.0.0.1:9050"))
    assert env["qbt_socks_proxy"] == "socks5h://127.0.0.1:9050"
    assert set(env) - {"qbt_socks_proxy"} == set(build_env(settings_factory(socks_proxy="")))


def test_no_ambient_environment_leaks_in(settings, monkeypatch):
    monkeypatch.setenv("SOME_DEPLOY_TOKEN", "leak")
    assert "SOME_DEPLOY_TOKEN" not in build_env(settings)
    assert os.environ.get("SOME_DEPLOY_TOKEN") == "leak"
