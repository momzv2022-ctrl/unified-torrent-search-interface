"""M4 — the registry bot.

Rebuilds `registry.json` and `PLUGINS.md` from upstream, pinning everything to
immutable commit SHAs so a plugin's content cannot change under a deployment
without the hash changing too. Run daily by `.github/workflows/registry.yml`.

What it deliberately does **not** do: auto-trust new code. A new plugin, or a
content change to one already trusted, is reported as a change so a human looks
at it. Silently merging third-party Python is the exact failure the sandbox and
the pinning exist to prevent.

It also deliberately does not smoke-test by default. Running ~90 scrapers a day
from GitHub Actions' address space measures Cloudflare's opinion of GitHub
Actions, not the plugins, and would auto-disable a healthy registry. Health
belongs to the host that actually serves traffic: `utsi probe` there, then
`utsi registry-update --merge-health probe-report.json`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .registry import (
    LINK_MAGNET,
    LINK_NEEDS_DL,
    LINK_TORRENT_URL,
    LINK_UNKNOWN,
    STATUS_OK,
    Health,
    Plugin,
    Registry,
    Runtime,
)
from .scanner import scan
from .wiki import WikiPlugin, dedupe, parse

log = logging.getLogger(__name__)

PLUGIN_REPO = "qbittorrent/search-plugins"
QBITTORRENT_REPO = "qbittorrent/qBittorrent"
NOVA3_PATH = "src/searchengine/nova3"
WIKI_PATH = "wiki/Unofficial-search-plugins.mediawiki"
VERSIONS_PATH = "nova3/engines/versions.txt"

#: The official engines, whose `link` shape was established by reading each
#: plugin's source. `jackett` is an adapter to a service the operator runs, so
#: it ships disabled: it is useless without `JACKETT_*` configuration.
OFFICIAL_LINK_KINDS = {
    "eztv": LINK_MAGNET,
    "piratebay": LINK_MAGNET,
    "solidtorrents": LINK_MAGNET,
    "torrentscsv": LINK_MAGNET,
    "torlock": LINK_TORRENT_URL,
    "limetorrents": LINK_NEEDS_DL,
    "torrentproject": LINK_NEEDS_DL,
    "jackett": LINK_MAGNET,
}

#: Categories each official engine declares, read from its `supported_categories`.
OFFICIAL_CATEGORIES = {
    "eztv": ["all", "tv"],
    "jackett": ["all", "anime", "books", "games", "movies", "music", "pictures", "software", "tv"],
    "limetorrents": ["all", "anime", "books", "games", "movies", "music", "tv"],
    "piratebay": ["all", "games", "movies", "music", "software"],
    "solidtorrents": ["all"],
    "torlock": ["all", "anime", "books", "games", "movies", "music", "pictures", "software", "tv"],
    "torrentproject": ["all"],
    "torrentscsv": ["all"],
}

#: Licences verified by reading each repository directly. Repos absent here are
#: recorded as "unknown", which under default copyright means no redistribution
#: right — one more reason this project fetches rather than vendors.
KNOWN_LICENSES = {
    "qbittorrent/search-plugins": "GPL-2.0-or-later",
    "LightDestory/qBittorrent-Search-Plugins": "GPL-3.0",
    "BurningMop/qBittorrent-Search-Plugins": "MIT",
    "imDMG/qBt_SE": "MIT",
    "tolotp/qbittorrent-search-plugins-de-busqueda": "MIT",
    "bugsbringer/qbit-plugins": "none",
    "MadeOfMagicAndWires/qBit-plugins": "none",
}

RAW = "https://raw.githubusercontent.com"


def resolve_ref(repo: str, ref: str = "HEAD") -> str:
    """The commit SHA behind a branch, so every URL we pin is immutable."""
    try:
        output = subprocess.run(
            ["git", "ls-remote", f"https://github.com/{repo}", ref],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout
        for line in output.splitlines():
            sha, _, name = line.partition("\t")
            if name.strip() in (ref, "HEAD", f"refs/heads/{ref}") and len(sha.strip()) == 40:
                return sha.strip()
    except (subprocess.SubprocessError, OSError) as exc:
        log.warning("git ls-remote %s failed: %r", repo, exc)

    response = httpx.get(f"https://api.github.com/repos/{repo}/commits/{ref}", timeout=30)
    response.raise_for_status()
    return str(response.json()["sha"])


def _repo_slug(repo_url: str) -> str:
    parts = [p for p in repo_url.replace("https://", "").replace("http://", "").split("/") if p]
    return "/".join(parts[1:3]) if len(parts) >= 3 else ""


@dataclass(slots=True)
class Change:
    kind: str  # added | removed | content-changed | status-changed | url-changed | hosts-added
    plugin_id: str
    detail: str = ""

    #: Changes that must not be applied without a human looking at the diff.
    #: `hosts-added` belongs here because a plugin that gains a host it never
    #: talked to before is the shape an exfiltration change takes.
    NEEDS_REVIEW = ("added", "content-changed", "hosts-added")

    def review(self) -> bool:
        return self.kind in self.NEEDS_REVIEW

    def __str__(self) -> str:
        return f"{self.kind}: {self.plugin_id}{' — ' + self.detail if self.detail else ''}"


@dataclass(slots=True)
class BuildResult:
    registry: Registry
    changes: list[Change] = field(default_factory=list)
    fetch_errors: dict[str, str] = field(default_factory=dict)
    scan_rejections: dict[str, str] = field(default_factory=dict)

    def review_changes(self) -> list[Change]:
        return [change for change in self.changes if change.review()]

    def summary(self) -> str:
        counts: dict[str, int] = {}
        for change in self.changes:
            counts[change.kind] = counts.get(change.kind, 0) + 1
        parts = [f"{count} {kind}" for kind, count in sorted(counts.items())] or ["no changes"]
        return (
            f"{len(self.registry.plugins)} plugins; " + ", ".join(parts)
            + f"; {len(self.fetch_errors)} unreachable; {len(self.scan_rejections)} rejected by scan"
        )


def _official_plugins(ref: str, versions: str) -> list[Plugin]:
    plugins: list[Plugin] = []
    for line in versions.splitlines():
        engine_id, _, version = line.partition(":")
        engine_id = engine_id.strip()
        if not engine_id:
            continue
        plugins.append(Plugin(
            id=engine_id,
            url=f"{RAW}/{PLUGIN_REPO}/{ref}/nova3/engines/{engine_id}.py",
            source="official",
            site=engine_id,
            author="qBittorrent",
            repo=f"https://github.com/{PLUGIN_REPO}",
            version=version.strip(),
            license=KNOWN_LICENSES[PLUGIN_REPO],
            wiki_status=STATUS_OK,
            categories=OFFICIAL_CATEGORIES.get(engine_id, ["all"]),
            link_kind=OFFICIAL_LINK_KINDS.get(engine_id, LINK_UNKNOWN),
            # jackett proxies a service the operator has to run; it answers
            # nothing on a default deployment, so it is off unless asked for.
            enabled=engine_id != "jackett",
            notes="Adapter for a self-hosted Jackett/Torznab instance." if engine_id == "jackett" else "",
            health=Health(score=0.8),
        ))
    return plugins


def _wiki_plugin(entry: WikiPlugin) -> Plugin:
    repo_slug = _repo_slug(entry.repo)
    return Plugin(
        id=entry.id,
        url=entry.url,
        source="wiki",
        site=entry.site,
        site_url=entry.site_url,
        author=entry.author,
        repo=entry.repo,
        version=entry.version,
        last_update=entry.last_update,
        license=KNOWN_LICENSES.get(repo_slug, "unknown"),
        wiki_status=entry.status,
        private=entry.private,
        categories=["all"],
        link_kind=LINK_UNKNOWN,
        # ✖ and ❗ are hard-excluded: the wiki states they "will result in the
        # slowdown and malfunction of other plugins as well".
        enabled=entry.status == STATUS_OK,
        notes=entry.comments[:200],
        health=Health(score=0.5),
    )


async def _fetch_all(urls: dict[str, str], concurrency: int = 8) -> dict[str, bytes | Exception]:
    results: dict[str, bytes | Exception] = {}
    semaphore = asyncio.Semaphore(concurrency)

    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        async def one(key: str, url: str) -> None:
            async with semaphore:
                try:
                    response = await client.get(url)
                    response.raise_for_status()
                    results[key] = response.content
                except (httpx.HTTPError, ValueError) as exc:
                    results[key] = exc

        await asyncio.gather(*(one(key, url) for key, url in urls.items()))
    return results


async def build(
    previous: Registry | None = None,
    *,
    include_wiki: bool = True,
    plugin_ref: str | None = None,
    runtime_ref: str | None = None,
) -> BuildResult:
    """Rebuild the registry from upstream, preserving health and manual flags."""
    plugin_ref = plugin_ref or resolve_ref(PLUGIN_REPO)
    runtime_ref = runtime_ref or resolve_ref(QBITTORRENT_REPO)
    log.info("search-plugins@%s qBittorrent@%s", plugin_ref[:12], runtime_ref[:12])

    sources = await _fetch_all({
        "versions": f"{RAW}/{PLUGIN_REPO}/{plugin_ref}/{VERSIONS_PATH}",
        "wiki": f"{RAW}/{PLUGIN_REPO}/{plugin_ref}/{WIKI_PATH}",
    })
    for key, value in sources.items():
        if isinstance(value, Exception):
            raise RuntimeError(f"could not fetch {key}: {value!r}")

    plugins = _official_plugins(plugin_ref, sources["versions"].decode("utf-8"))  # type: ignore[union-attr]
    official_ids = {plugin.id for plugin in plugins}
    if include_wiki:
        entries = dedupe(parse(sources["wiki"].decode("utf-8")))  # type: ignore[union-attr]
        plugins.extend(_wiki_plugin(entry) for entry in entries if entry.id not in official_ids)

    result = BuildResult(registry=Registry(plugins=plugins))
    await _hash_and_scan(result)
    await _pin_runtime(result, runtime_ref)

    result.registry.plugin_repo_ref = plugin_ref
    _carry_over(result, previous)
    _diff(result, previous)
    return result


async def _hash_and_scan(result: BuildResult) -> None:
    """Fetch every plugin once: record its hash, its hosts, and any denial."""
    plugins = {plugin.id: plugin for plugin in result.registry.plugins}
    bodies = await _fetch_all({pid: plugin.url for pid, plugin in plugins.items()})

    for plugin_id, body in bodies.items():
        plugin = plugins[plugin_id]
        if isinstance(body, Exception):
            result.fetch_errors[plugin_id] = repr(body)
            plugin.enabled = False
            plugin.notes = (plugin.notes + " | unreachable").strip(" |")
            continue

        plugin.pinned_sha256 = hashlib.sha256(body).hexdigest()
        try:
            source = body.decode("utf-8")
        except UnicodeDecodeError as exc:
            result.scan_rejections[plugin_id] = f"not utf-8: {exc}"
            plugin.enabled = False
            continue

        report = scan(source, plugin_id, declared_url=plugin.site_url)
        plugin.hosts = report.hosts
        # The engine's own `url` attribute beats whatever the wiki recorded.
        plugin.site_url = report.declared_url or plugin.site_url
        if not report.ok:
            result.scan_rejections[plugin_id] = report.summary()
            plugin.enabled = False
            plugin.notes = (plugin.notes + f" | static scan: {report.summary()}").strip(" |")


async def _pin_runtime(result: BuildResult, runtime_ref: str) -> None:
    from .provision import CORE_FILES

    base = f"{RAW}/{QBITTORRENT_REPO}/{runtime_ref}/{NOVA3_PATH}"
    bodies = await _fetch_all({name: f"{base}/{name}" for name in CORE_FILES})

    files: dict[str, str] = {}
    for name, body in bodies.items():
        if isinstance(body, Exception):
            raise RuntimeError(f"could not fetch nova3 core file {name}: {body!r}")
        files[name] = hashlib.sha256(body).hexdigest()

    result.registry.runtime = Runtime(
        repo=QBITTORRENT_REPO, ref=runtime_ref, base_url=base, files=files
    )


def _carry_over(result: BuildResult, previous: Registry | None) -> None:
    """Keep health history, learned facts and operator overrides across a rebuild.

    `enabled` is sticky in one direction only: a plugin switched off — by an
    operator, or automatically after three failed health merges — stays off
    until something explicitly turns it back on. `merge_health` is what turns
    it back on when the site recovers. A daily rebuild never re-enables on its
    own, because "the wiki still lists it" is not evidence that it works.
    """
    if previous is None:
        return
    old = previous.by_id()
    for plugin in result.registry.plugins:
        prior = old.get(plugin.id)
        if prior is None:
            continue
        plugin.health = prior.health
        if prior.link_kind != LINK_UNKNOWN:
            plugin.link_kind = prior.link_kind
        if prior.source == "wiki" and prior.categories != ["all"]:
            plugin.categories = prior.categories
        if not prior.enabled:
            plugin.enabled = False


def _diff(result: BuildResult, previous: Registry | None) -> None:
    if previous is None:
        result.changes = [Change("added", plugin.id) for plugin in result.registry.plugins]
        return

    old = previous.by_id()
    new = result.registry.by_id()

    for plugin_id in sorted(new.keys() - old.keys()):
        result.changes.append(Change("added", plugin_id, new[plugin_id].url))
    for plugin_id in sorted(old.keys() - new.keys()):
        result.changes.append(Change("removed", plugin_id))

    for plugin_id in sorted(new.keys() & old.keys()):
        before, after = old[plugin_id], new[plugin_id]
        if before.url != after.url:
            result.changes.append(Change("url-changed", plugin_id, f"{before.url} -> {after.url}"))
        elif before.pinned_sha256 and after.pinned_sha256 and before.pinned_sha256 != after.pinned_sha256:
            result.changes.append(Change(
                "content-changed", plugin_id,
                f"{before.pinned_sha256[:12]} -> {after.pinned_sha256[:12]}",
            ))
        if before.wiki_status != after.wiki_status:
            result.changes.append(Change(
                "status-changed", plugin_id, f"{before.wiki_status} -> {after.wiki_status}"
            ))
        gained = sorted(set(after.hosts) - set(before.hosts))
        if gained and before.hosts:
            result.changes.append(Change("hosts-added", plugin_id, ", ".join(gained)))


def merge_health(registry: Registry, probe_json: Path) -> int:
    """Fold a `utsi probe` run into the registry's health scores.

    Health is measured where the service runs, not in CI — see the module
    docstring. A plugin that fails three consecutive merges is auto-disabled but
    kept in the file with its history intact.
    """
    payload = json.loads(probe_json.read_text(encoding="utf-8"))
    by_id = registry.by_id()
    touched = 0

    for row in payload.get("engines", []):
        plugin = by_id.get(row.get("engine"))
        if plugin is None:
            continue
        touched += 1
        usable = bool(row.get("ok")) and int(row.get("rows", 0)) > 0
        health = plugin.health
        # Exponential moving average: one bad day nudges, three sink it.
        health.score = round(0.6 * health.score + 0.4 * (1.0 if usable else 0.0), 3)
        health.rows = int(row.get("rows", 0))
        health.median_ms = int(row.get("elapsed_ms", 0)) or None
        if usable:
            health.consecutive_failures = 0
            health.last_ok = payload.get("started_at", "")
            health.last_error = None
            if row.get("link_kind") and "," not in row["link_kind"]:
                plugin.link_kind = row["link_kind"]
            # A recovered site is the one signal that flips `enabled` back on.
            if plugin.wiki_status == STATUS_OK:
                plugin.enabled = True
        else:
            health.consecutive_failures += 1
            health.last_error = (row.get("error") or "no rows")[:200]
            if health.consecutive_failures >= 3:
                plugin.enabled = False
    return touched


def render_plugins_md(registry: Registry) -> str:
    """Human-readable roster, with attribution for every plugin author."""
    lines = [
        "# Plugins",
        "",
        "Every plugin below is **fetched from its author at runtime**. None of this",
        "code is stored in this repository — see the README for why that is a",
        "deliberate design constraint rather than an oversight.",
        "",
        f"- registry generated: `{registry.generated_at}`",
        f"- qbittorrent/search-plugins pinned at: `{registry.plugin_repo_ref}`",
        f"- nova3 runtime pinned at: `{registry.runtime.ref}`",
        "",
        "`✔`/`❗`/`✖` are the community status glyphs from the qBittorrent wiki.",
        "The wiki states that `❗` and `✖` plugins \"will result in the slowdown and",
        "malfunction of other plugins as well\", so both are excluded by default.",
        "",
    ]
    glyph = {"ok": "✔", "warn": "❗", "broken": "✖"}

    for title, wanted in (("Official plugins", "official"), ("Community plugins", "wiki")):
        chosen = [p for p in sorted(registry.plugins, key=lambda p: p.id) if p.source == wanted]
        if not chosen:
            continue
        enabled = sum(1 for p in chosen if p.enabled)
        lines += [
            f"## {title} ({enabled} enabled / {len(chosen)})",
            "",
            "| Plugin | Site | Author | Repository | Licence | Status | Updated | Link kind | Enabled |",
            "|---|---|---|---|---|:--:|---|---|:--:|",
        ]
        for plugin in chosen:
            repo = f"[{_repo_slug(plugin.repo) or 'source'}]({plugin.repo})" if plugin.repo else "—"
            private = " 🔒" if plugin.private else ""
            label = plugin.site or plugin.id
            site = f"[{label}]({plugin.site_url})" if plugin.site_url else label
            lines.append(
                f"| `{plugin.id}` | {site}{private} | {plugin.author or '—'} | {repo} "
                f"| {plugin.license} | {glyph.get(plugin.wiki_status, '?')} | {plugin.last_update or '—'} "
                f"| {plugin.link_kind} | {'yes' if plugin.enabled else 'no'} |"
            )
        lines.append("")

    lines += [
        "🔒 marks a private-site plugin. These need user credentials and are",
        "excluded unless `UTSI_INCLUDE_PRIVATE=1` is set — leaving them out removes",
        "an entire class of credential-handling liability.",
        "",
    ]
    return "\n".join(lines)
