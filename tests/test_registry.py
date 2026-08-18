"""The registry, the static scanner, the wiki parser and the bot's diffing."""

from __future__ import annotations

import json
import textwrap
import warnings
from pathlib import Path

import pytest

from utsi.bot import Change, _carry_over, _diff, merge_health, render_plugins_md
from utsi.registry import (
    LINK_MAGNET,
    LINK_NEEDS_DL,
    LINK_UNKNOWN,
    STATUS_BROKEN,
    STATUS_OK,
    STATUS_WARN,
    Health,
    Plugin,
    Registry,
)
from utsi.scanner import scan
from utsi.wiki import dedupe, normalize_source_url, parse

REPO_ROOT = Path(__file__).resolve().parents[1]

WIKI = textwrap.dedent("""
    == Plugins for Public Sites ==

    {|class="sortable"
    |-
    !  Search Engine
    !  Author (Repository)
    !  Version
    !  Last update
    !  Download link
    !  Comments
    |-
    | [[https://www.google.com/s2/favicons?domain=alpha.test#.png]] [https://alpha.test/ Alpha Tracker]
    | [https://github.com/someone/plugins Someone]
    | 1.2
    | 19/Mar<br>2023
    | [https://raw.githubusercontent.com/someone/plugins/master/alpha.py [[https://example.test/Download.gif]]]
    | ✔ qbt 4.3.x / Python 3.8.5
    |-
    | [[https://example.test/f.png]] [https://beta.test/ Beta]
    | [https://github.com/other/repo Other]
    | 2.0
    | 13/Apr/2024
    | [https://github.com/other/repo/blob/main/beta.py [[https://example.test/Download.gif]]]
    | ✔ qbt 4.1.x <br>❗ broken on 5.0
    |-
    | [[https://example.test/g.png]] [https://gamma.test/ Gamma]
    | [https://github.com/third/repo Third]
    | 0.1
    | 01/Jan<br>2018
    | [https://raw.githubusercontent.com/third/repo/master/gamma.py [[https://example.test/Download.gif]]]
    | ✖ dead since 2020
    |}

    == Plugins for Private Sites ==

    {|class="sortable"
    |-
    !  Search Engine
    !  Author (Repository)
    !  Version
    !  Last update
    !  Download link
    !  Comments
    |-
    | [[https://example.test/d.png]] [https://delta.test/ Delta]
    | [https://github.com/fourth/repo Fourth]
    | 1.0
    | 05/Feb<br>2025
    | [https://raw.githubusercontent.com/fourth/repo/master/alpha.py [[https://example.test/Download.gif]]]
    | ✔ needs an account
    |}
""")


# --- wiki parser -----------------------------------------------------------


def test_parser_reads_every_column():
    # The private section also lists an `alpha.py`; keep them apart.
    plugins = {plugin.id: plugin for plugin in parse(WIKI) if not plugin.private}
    alpha = plugins["alpha"]
    assert alpha.site == "Alpha Tracker"
    assert alpha.site_url == "https://alpha.test/"
    assert alpha.author == "Someone"
    assert alpha.repo == "https://github.com/someone/plugins"
    assert alpha.version == "1.2"
    assert alpha.last_update == "2023-03-19"
    assert alpha.status == STATUS_OK
    assert alpha.private is False


def test_both_date_spellings_parse():
    assert {p.id: p.last_update for p in parse(WIKI)}["beta"] == "2024-04-13"


def test_worst_status_glyph_wins():
    # "✔ qbt 4.1.x <br>❗ broken on 5.0" — the wiki says ❗ plugins degrade the
    # whole search, so the pessimistic reading is the only safe one.
    statuses = {p.id: p.status for p in parse(WIKI)}
    assert statuses["beta"] == STATUS_WARN
    assert statuses["gamma"] == STATUS_BROKEN


def test_private_section_is_marked():
    assert [p.id for p in parse(WIKI) if p.private] == ["alpha"]


def test_blob_urls_are_rewritten_to_raw():
    # A `blob` link serves HTML; fetching it would hand the scanner a syntax error.
    assert {p.id: p.url for p in parse(WIKI)}["beta"] == (
        "https://raw.githubusercontent.com/other/repo/main/beta.py"
    )


def test_normalize_source_url_leaves_raw_links_alone():
    raw = "https://raw.githubusercontent.com/o/r/main/x.py"
    assert normalize_source_url(raw) == raw


def test_dedupe_prefers_public_over_private():
    # Both sections define `alpha.py`; nova3 keys engines by module name, so
    # only one can exist in the engines directory.
    survivors = dedupe(parse(WIKI))
    assert [p.id for p in survivors] == ["alpha", "beta", "gamma"]
    assert next(p for p in survivors if p.id == "alpha").private is False


# The parser is also exercised against the live 750-line upstream page by the
# `registry-dry-run` job in CI, which is the real regression guard — checking a
# copy of someone else's wiki into this repo would be vendoring by another name.


# --- static scanner --------------------------------------------------------

GOOD = textwrap.dedent("""
    from helpers import retrieve_url
    from novaprinter import prettyPrinter


    class alpha:
        url = 'https://alpha.test'
        name = 'Alpha'
        supported_categories = {'all': ''}

        def search(self, what, cat='all'):
            prettyPrinter({'link': 'magnet:?xt=urn:btih:' + what, 'name': what, 'size': 1,
                           'seeds': 1, 'leech': 1, 'engine_url': self.url})
""")


def test_a_well_formed_plugin_passes():
    result = scan(GOOD, "alpha", declared_url="https://alpha.test")
    assert result.ok
    assert result.declared_class
    assert result.denials == []


@pytest.mark.parametrize(
    ("snippet", "code"),
    [
        ("import socket\n", "denied-import"),
        ("import subprocess\n", "denied-import"),
        ("from pickle import loads\n", "denied-import"),
        ("import ctypes.util\n", "denied-import"),
        ("x = eval('1')\n", "denied-call"),
        ("exec('x = 1')\n", "denied-call"),
        ("import os\nos.system('id')\n", "denied-call"),
        ("f = (1).__class__.__subclasses__\n", "dunder-access"),
    ],
)
def test_dangerous_constructs_are_rejected(snippet, code):
    result = scan(snippet + GOOD, "alpha")
    assert not result.ok
    assert any(finding.code == code for finding in result.denials)


def test_scanning_a_plugin_emits_no_warnings_of_its_own():
    """Third-party lint is not the operator's problem.

    Unescaped regex literals are everywhere in the plugin ecosystem; parsing
    them made the compiler print a warning per plugin per boot, naming files
    the operator does not own and cannot fix.
    """
    sloppy = GOOD.replace(
        "from helpers import retrieve_url",
        "from helpers import retrieve_url\nimport re\n_PATTERN = re.compile('\\\\d{4}-\\\\d{2}')",
    )
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        result = scan(sloppy, "alpha", declared_url="https://alpha.test")
    assert result.ok
    assert [str(w.message) for w in caught] == []


def test_a_file_with_no_engine_class_is_rejected():
    result = scan("x = 1\n", "alpha")
    assert not result.ok
    assert result.denials[0].code == "missing-class"


def test_a_case_mismatched_class_is_accepted():
    # `rutracker.py` really does define `class RuTracker`; the shim loads it.
    assert scan(GOOD.replace("class alpha", "class Alpha"), "alpha").ok


def test_a_single_searchable_class_is_accepted_under_any_name():
    assert scan(GOOD.replace("class alpha", "class SomethingElse"), "alpha").ok


def test_a_syntax_error_is_rejected_rather_than_deployed():
    result = scan("class alpha:\n    def search(self", "alpha")
    assert not result.ok
    assert result.denials[0].code == "syntax-error"


def test_foreign_hosts_are_recorded_but_not_fatal_by_default():
    # piratebay declares thepiratebay.org and calls apibay.org; hard-failing on
    # that would reject most working plugins.
    source = GOOD.replace("'https://alpha.test'", "'https://alpha.test'\n    api = 'https://apibay.test/q'")
    result = scan(source, "alpha", declared_url="https://alpha.test")
    assert result.ok
    assert "apibay.test" in result.hosts
    assert any(finding.code == "foreign-host" for finding in result.findings)


def test_strict_hosts_makes_them_fatal():
    source = GOOD.replace("'https://alpha.test'", "'https://alpha.test'\n    api = 'https://elsewhere.test/q'")
    assert not scan(source, "alpha", declared_url="https://alpha.test", strict_hosts=True).ok


def test_previously_reviewed_hosts_pass_even_under_strict_mode():
    source = GOOD.replace("'https://alpha.test'", "'https://alpha.test'\n    api = 'https://apibay.test/q'")
    result = scan(
        source, "alpha",
        declared_url="https://alpha.test",
        allowed_hosts=("apibay.test",),
        strict_hosts=True,
    )
    assert result.ok


def test_subdomains_of_the_declared_host_are_allowed():
    source = GOOD.replace("'https://alpha.test'", "'https://alpha.test'\n    api = 'https://api.alpha.test/q'")
    result = scan(source, "alpha", declared_url="https://alpha.test")
    assert not [f for f in result.findings if f.code == "foreign-host"]


# --- registry round trip ---------------------------------------------------


def test_registry_round_trips(tmp_path):
    registry = Registry(
        generated_at="2026-01-01T00:00:00Z",
        plugins=[Plugin(id="a", url="https://x.test/a.py", health=Health(score=0.9))],
    )
    path = tmp_path / "r.json"
    registry.save(path)
    assert Registry.load(path).plugins[0].health.score == 0.9


def test_selection_excludes_warn_broken_private_and_disabled():
    registry = Registry(plugins=[
        Plugin(id="ok", url="u"),
        Plugin(id="warn", url="u", wiki_status=STATUS_WARN),
        Plugin(id="broken", url="u", wiki_status=STATUS_BROKEN),
        Plugin(id="private", url="u", private=True),
        Plugin(id="off", url="u", enabled=False),
    ])
    assert [p.id for p in registry.selectable(include_private=False)] == ["ok"]
    assert [p.id for p in registry.selectable(include_private=True)] == ["ok", "private"]
    assert [p.id for p in registry.selectable(include_private=False, only=("off",))] == []


def test_magnet_engines_outscore_ones_needing_a_round_trip():
    magnet = Plugin(id="m", url="u", link_kind=LINK_MAGNET)
    needs_dl = Plugin(id="d", url="u", link_kind=LINK_NEEDS_DL)
    assert magnet.base_score() > needs_dl.base_score()


# --- bot diffing and health ------------------------------------------------


def _registry(*plugins: Plugin) -> Registry:
    return Registry(plugins=list(plugins))


class _Result:
    def __init__(self, registry: Registry) -> None:
        self.registry = registry
        self.changes: list[Change] = []
        self.fetch_errors: dict[str, str] = {}
        self.scan_rejections: dict[str, str] = {}


def test_a_content_change_to_a_trusted_plugin_needs_review():
    before = _registry(Plugin(id="a", url="u", pinned_sha256="a" * 64))
    result = _Result(_registry(Plugin(id="a", url="u", pinned_sha256="b" * 64)))
    _diff(result, before)  # type: ignore[arg-type]
    assert [c.kind for c in result.changes] == ["content-changed"]
    assert result.changes[0].review()


def test_a_new_plugin_needs_review():
    result = _Result(_registry(Plugin(id="a", url="u"), Plugin(id="b", url="u")))
    _diff(result, _registry(Plugin(id="a", url="u")))  # type: ignore[arg-type]
    assert [(c.kind, c.plugin_id) for c in result.changes] == [("added", "b")]
    assert result.changes[0].review()


def test_a_plugin_gaining_a_host_needs_review():
    # The shape an exfiltration change takes.
    before = _registry(Plugin(id="a", url="u", hosts=["alpha.test"]))
    result = _Result(_registry(Plugin(id="a", url="u", hosts=["alpha.test", "collector.test"])))
    _diff(result, before)  # type: ignore[arg-type]
    assert [(c.kind, c.detail) for c in result.changes] == [("hosts-added", "collector.test")]
    assert result.changes[0].review()


def test_first_time_host_recording_is_not_a_change():
    # An empty "before" is a registry built before hosts were tracked, not a
    # plugin that suddenly grew ten new endpoints.
    result = _Result(_registry(Plugin(id="a", url="u", hosts=["alpha.test"])))
    _diff(result, _registry(Plugin(id="a", url="u", hosts=[])))  # type: ignore[arg-type]
    assert result.changes == []


def test_a_status_or_removal_change_does_not_need_review():
    result = _Result(_registry(Plugin(id="a", url="u", wiki_status=STATUS_WARN)))
    _diff(result, _registry(Plugin(id="a", url="u"), Plugin(id="gone", url="u")))  # type: ignore[arg-type]
    assert {c.kind for c in result.changes} == {"removed", "status-changed"}
    assert not any(c.review() for c in result.changes)


def test_a_rebuild_never_re_enables_a_disabled_plugin():
    result = _Result(_registry(Plugin(id="a", url="u", enabled=True)))
    _carry_over(result, _registry(Plugin(id="a", url="u", enabled=False)))  # type: ignore[arg-type]
    assert result.registry.plugins[0].enabled is False


def test_a_rebuild_keeps_health_and_learned_link_kind():
    result = _Result(_registry(Plugin(id="a", url="u", link_kind=LINK_UNKNOWN)))
    prior = Plugin(id="a", url="u", link_kind=LINK_MAGNET, health=Health(score=0.91))
    _carry_over(result, _registry(prior))  # type: ignore[arg-type]
    assert result.registry.plugins[0].link_kind == LINK_MAGNET
    assert result.registry.plugins[0].health.score == 0.91


def test_health_merge_disables_after_three_failures_and_recovers(tmp_path):
    registry = _registry(Plugin(id="a", url="u", health=Health(score=0.9)))
    failing = tmp_path / "fail.json"
    failing.write_text(json.dumps({
        "started_at": "2026-01-01T00:00:00Z",
        "engines": [{"engine": "a", "ok": False, "rows": 0, "error": "403"}],
    }))

    for _ in range(3):
        merge_health(registry, failing)
    plugin = registry.plugins[0]
    assert plugin.enabled is False
    assert plugin.health.consecutive_failures == 3
    assert plugin.health.last_error == "403"
    assert plugin.health.score < 0.2  # kept, with its history, not deleted

    recovered = tmp_path / "ok.json"
    recovered.write_text(json.dumps({
        "started_at": "2026-01-02T00:00:00Z",
        "engines": [{"engine": "a", "ok": True, "rows": 12, "elapsed_ms": 800, "link_kind": "magnet"}],
    }))
    merge_health(registry, recovered)
    assert plugin.enabled is True
    assert plugin.link_kind == LINK_MAGNET
    assert plugin.health.median_ms == 800


def test_plugins_md_attributes_every_author():
    registry = Registry(
        generated_at="2026-01-01T00:00:00Z",
        plugins=[
            Plugin(id="off", url="u", source="official", author="qBittorrent", license="GPL-2.0-or-later"),
            Plugin(id="com", url="u", source="wiki", author="Someone",
                   repo="https://github.com/someone/plugins", license="MIT"),
            Plugin(id="priv", url="u", source="wiki", author="Other", private=True),
        ],
    )
    markdown = render_plugins_md(registry)
    assert "qBittorrent" in markdown and "Someone" in markdown and "Other" in markdown
    assert "GPL-2.0-or-later" in markdown and "MIT" in markdown
    assert "🔒" in markdown  # the private one is flagged
    assert "fetched from its author at runtime" in markdown
