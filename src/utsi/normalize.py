"""nova3 result rows -> TSP rows.

`Candidate` is the mutable working form: it carries the fields TSP wants plus
the bookkeeping needed to merge duplicates and to resolve a link that is not
yet a magnet. `Candidate.to_torrent()` produces the wire model once a magnet
exists — TSP requires one on every row, so a candidate that never resolves is
dropped rather than emitted incomplete.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field

from .categories import classify_name
from .magnet import (
    TorrentMeta,
    display_name_from_magnet,
    infohash_from_magnet,
    looks_like_magnet,
    looks_like_torrent_url,
)
from .models import Torrent
from .nameparse import parse_name
from .registry import LINK_MAGNET, LINK_NEEDS_DL, LINK_TORRENT_URL
from .runner import EngineRow

_WHITESPACE = re.compile(r"[^a-z0-9]+")


def iso_from_unix(timestamp: int) -> str:
    return dt.datetime.fromtimestamp(timestamp, tz=dt.UTC).isoformat().replace("+00:00", "Z")


def now_iso() -> str:
    return dt.datetime.now(tz=dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def detect_link_kind(link: str) -> str:
    if looks_like_magnet(link):
        return LINK_MAGNET
    if looks_like_torrent_url(link):
        return LINK_TORRENT_URL
    return LINK_NEEDS_DL


@dataclass(slots=True)
class Candidate:
    """A result row on its way to becoming a TSP `Torrent`."""

    name: str
    engine_id: str
    link: str
    link_kind: str
    magnet: str | None = None
    infohash: str | None = None
    torrent_url: str | None = None
    size_bytes: int | None = None
    files: int | None = None
    seeders: int | None = None
    leechers: int | None = None
    category: str | None = None
    first_seen: str | None = None
    description_url: str | None = None
    sources: list[str] = field(default_factory=list)
    meta: dict[str, str] = field(default_factory=dict)

    @property
    def resolved(self) -> bool:
        return self.magnet is not None

    def dedupe_key(self) -> tuple[str, str]:
        """Infohash when known, else a normalised name+size fingerprint.

        Rows that still need resolution have no infohash yet, so they dedupe on
        the only stable thing they have. Merging runs again after resolution,
        by which point the infohash is available.
        """
        if self.infohash:
            return ("h", self.infohash)
        slug = _WHITESPACE.sub("", self.name.lower())
        return ("n", f"{slug}:{self.size_bytes if self.size_bytes is not None else '?'}")

    def apply_torrent_meta(self, meta: TorrentMeta) -> None:
        """Fold in what a fetched .torrent told us."""
        self.infohash = meta.infohash
        self.magnet = meta.magnet()
        if self.size_bytes is None and meta.size_bytes is not None:
            self.size_bytes = meta.size_bytes
        if self.files is None and meta.files is not None:
            self.files = meta.files

    def to_torrent(self, scraped_at: str) -> Torrent | None:
        if not self.magnet:
            return None
        return Torrent(
            magnet=self.magnet,
            infohash=self.infohash,
            name=self.name,
            size_bytes=self.size_bytes,
            files=self.files,
            category=self.category,
            seeders=self.seeders,
            leechers=self.leechers,
            year=self.meta.get("year"),
            resolution=self.meta.get("resolution"),
            codec=self.meta.get("codec"),
            source=self.meta.get("source"),
            season=self.meta.get("season"),
            episode=self.meta.get("episode"),
            first_seen=self.first_seen,
            scraped_at=scraped_at,
            torrent_url=self.torrent_url,
            description_url=self.description_url,
            sources=sorted(set(self.sources)) or None,
        )


def to_candidate(row: EngineRow, engine_id: str, tsp_category: str | None) -> Candidate | None:
    """Map one nova3 row onto a `Candidate`.

    *tsp_category* is the category we know the row belongs to because we asked
    the engine for it. When we had to ask for ``all`` it is ``None`` and the
    category is inferred from the name instead.
    """
    kind = detect_link_kind(row.link)
    candidate = Candidate(
        name=row.name,
        engine_id=engine_id,
        link=row.link,
        link_kind=kind,
        size_bytes=row.size_bytes,
        seeders=row.seeders,
        leechers=row.leechers,
        description_url=row.desc_link or None,
        sources=[engine_id],
        category=tsp_category or classify_name(row.name),
        meta=parse_name(row.name).as_dict(),
    )

    if kind == LINK_MAGNET:
        candidate.magnet = row.link
        candidate.infohash = infohash_from_magnet(row.link)
        if candidate.infohash is None:
            # A magnet without a readable btih is useless to a client.
            return None
        if not candidate.name:
            candidate.name = display_name_from_magnet(row.link) or ""
    elif kind == LINK_TORRENT_URL:
        # TSP calls this "decisive for thin swarms": keep it even once the
        # magnet is synthesised, so a client can skip BEP-9 entirely.
        candidate.torrent_url = row.link

    if row.pub_date:
        candidate.first_seen = iso_from_unix(row.pub_date)

    return candidate if candidate.name else None
