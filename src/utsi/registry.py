"""`registry.json` — the only state this project owns.

It stores *where* a plugin lives and *what it hashed to*, never the plugin
itself. A URL pinned to an immutable commit SHA plus a `pinned_sha256` makes a
plugin change a review event rather than a silent auto-update.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

#: Wiki status glyphs. The wiki states that ✖ and ❗ plugins "will result in the
#: slowdown and malfunction of other plugins as well", so both are excluded.
STATUS_OK = "ok"
STATUS_WARN = "warn"
STATUS_BROKEN = "broken"

#: How a plugin's `link` field must be turned into a magnet.
LINK_MAGNET = "magnet"  # already a magnet URI
LINK_TORRENT_URL = "torrent_url"  # a .torrent URL: fetch, bdecode, hash
LINK_NEEDS_DL = "needs_dl"  # opaque token: resolve via the plugin's download_torrent()
LINK_UNKNOWN = "unknown"  # not smoke-tested yet; detected per row at runtime

#: Preference applied when picking engines for a request. A magnet costs one
#: round trip; `needs_dl` costs one more per row and blows the latency budget.
LINK_KIND_BONUS = {
    LINK_MAGNET: 0.15,
    LINK_TORRENT_URL: 0.0,
    LINK_UNKNOWN: -0.05,
    LINK_NEEDS_DL: -0.20,
}


@dataclass(slots=True)
class Health:
    score: float = 0.5
    last_ok: str | None = None
    last_error: str | None = None
    median_ms: int | None = None
    rows: int | None = None
    consecutive_failures: int = 0

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> Health:
        data = data or {}
        return cls(
            score=float(data.get("score", 0.5)),
            last_ok=data.get("last_ok"),
            last_error=data.get("last_error"),
            median_ms=data.get("median_ms"),
            rows=data.get("rows"),
            consecutive_failures=int(data.get("consecutive_failures", 0)),
        )


@dataclass(slots=True)
class Plugin:
    id: str
    url: str
    source: str = "wiki"  # official | wiki
    site: str = ""
    site_url: str = ""
    author: str = ""
    repo: str = ""
    version: str = ""
    last_update: str = ""
    license: str = "unknown"
    wiki_status: str = STATUS_OK
    private: bool = False
    categories: list[str] = field(default_factory=lambda: ["all"])
    link_kind: str = LINK_UNKNOWN
    pinned_sha256: str | None = None
    #: Hosts the plugin's source refers to, recorded at ingest. The point is not
    #: to allow or deny them but to notice the day a plugin gains one.
    hosts: list[str] = field(default_factory=list)
    health: Health = field(default_factory=Health)
    enabled: bool = True
    notes: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Plugin:
        known = {f for f in cls.__slots__ if f != "health"}
        kwargs = {key: value for key, value in data.items() if key in known}
        kwargs["categories"] = list(data.get("categories") or ["all"])
        return cls(health=Health.from_dict(data.get("health")), **kwargs)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def selectable(self, *, include_private: bool) -> bool:
        """Eligible to be provisioned and queried."""
        return (
            self.enabled
            and self.wiki_status == STATUS_OK
            and (include_private or not self.private)
        )

    def base_score(self) -> float:
        score = self.health.score + LINK_KIND_BONUS.get(self.link_kind, 0.0)
        if self.health.median_ms:
            # Latency measured by `utsi probe`, so a registry that has seen a
            # real run prefers the engines that answer quickly. Capped, because
            # a slow engine with unique content still beats no engine.
            score -= min(self.health.median_ms / 20000.0, 0.25)
        return score


@dataclass(slots=True)
class Runtime:
    """The nova3 core files, pinned the same way plugins are."""

    repo: str = "qbittorrent/qBittorrent"
    ref: str = "master"
    base_url: str = ""
    files: dict[str, str] = field(default_factory=dict)  # filename -> sha256

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> Runtime:
        data = data or {}
        return cls(
            repo=data.get("repo", "qbittorrent/qBittorrent"),
            ref=data.get("ref", "master"),
            base_url=data.get("base_url", ""),
            files=dict(data.get("files") or {}),
        )

    def url_for(self, filename: str) -> str:
        return f"{self.base_url.rstrip('/')}/{filename}"


@dataclass(slots=True)
class Registry:
    generated_at: str = ""
    plugin_repo_ref: str = ""
    runtime: Runtime = field(default_factory=Runtime)
    plugins: list[Plugin] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> Registry:
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            generated_at=data.get("generated_at", ""),
            plugin_repo_ref=data.get("plugin_repo_ref", ""),
            runtime=Runtime.from_dict(data.get("runtime")),
            plugins=[Plugin.from_dict(item) for item in data.get("plugins", [])],
        )

    def save(self, path: Path) -> None:
        payload = {
            "generated_at": self.generated_at,
            "plugin_repo_ref": self.plugin_repo_ref,
            "runtime": asdict(self.runtime),
            "plugins": [plugin.to_dict() for plugin in sorted(self.plugins, key=lambda p: p.id)],
        }
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    def by_id(self) -> dict[str, Plugin]:
        return {plugin.id: plugin for plugin in self.plugins}

    def selectable(self, *, include_private: bool, only: tuple[str, ...] = ()) -> list[Plugin]:
        chosen = [p for p in self.plugins if p.selectable(include_private=include_private)]
        if only:
            wanted = set(only)
            chosen = [p for p in chosen if p.id in wanted]
        return sorted(chosen, key=lambda p: p.id)
