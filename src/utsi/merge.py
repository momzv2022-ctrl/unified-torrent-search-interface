"""Dedupe, merge, filter and order the union of every engine's rows.

nova3 plugins do not page and do not sort reliably — the base class only
*recommends* seed-descending — so ordering and paging are ours to implement over
the merged set. Ordering is made total (every comparison ends in the dedupe
key) because a client paging `offset=0` then `offset=50` must see a stable
sequence.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from .nameparse import matches_terms
from .normalize import Candidate

SORTS = ("", "seeders", "size", "recent")


def merge(candidates: Iterable[Candidate]) -> list[Candidate]:
    """Collapse duplicates, keeping the best of each field.

    Same content from several engines: keep the longest name (the most
    descriptive release string), take `max()` of the swarm counts because a
    stale engine under-reports, and record every contributing engine in
    `sources`.
    """
    merged: dict[tuple[str, str], Candidate] = {}

    for candidate in candidates:
        key = candidate.dedupe_key()
        existing = merged.get(key)
        if existing is None:
            merged[key] = candidate
            continue

        if len(candidate.name) > len(existing.name):
            existing.name = candidate.name
            existing.meta = candidate.meta
        existing.seeders = _max(existing.seeders, candidate.seeders)
        existing.leechers = _max(existing.leechers, candidate.leechers)
        existing.size_bytes = existing.size_bytes if existing.size_bytes is not None else candidate.size_bytes
        existing.files = existing.files if existing.files is not None else candidate.files
        existing.category = existing.category or candidate.category
        existing.description_url = existing.description_url or candidate.description_url
        existing.torrent_url = existing.torrent_url or candidate.torrent_url
        existing.sources.extend(candidate.sources)
        # "first seen" is the earliest sighting anyone reports.
        if candidate.first_seen and (
            existing.first_seen is None or candidate.first_seen < existing.first_seen
        ):
            existing.first_seen = candidate.first_seen
        # Prefer a row we can already hand to a client over one needing a round trip.
        if existing.magnet is None and candidate.magnet is not None:
            existing.magnet = candidate.magnet
            existing.infohash = candidate.infohash
        elif existing.link_kind != candidate.link_kind and candidate.magnet is not None:
            existing.infohash = existing.infohash or candidate.infohash

    return list(merged.values())


def _max(left: int | None, right: int | None) -> int | None:
    if left is None:
        return right
    if right is None:
        return left
    return max(left, right)


def apply_filters(
    candidates: Iterable[Candidate],
    *,
    terms: Sequence[str] = (),
    category: str = "",
    year: str = "",
    resolution: str = "",
    min_seeders: int = 0,
) -> list[Candidate]:
    """Apply the TSP query filters that are ours to enforce.

    *terms* is ``q`` itself, here rather than left to the engines because not
    every engine applies it: a site that cannot match what it was asked answers
    with its newest uploads instead of with nothing, and by the time those rows
    reach the merge they are indistinguishable from real ones. TSP's ``200`` is
    "matching rows", so the match is enforced where the whole answer is visible.
    Empty means no gate; see ``SearchService.search`` for the case that wants it.
    """
    kept: list[Candidate] = []
    for candidate in candidates:
        if terms and not matches_terms(candidate.name, terms):
            continue
        # Only a category we know and that disagrees is grounds to drop. A
        # candidate we could not classify — no plugin category to go on and a
        # name with no technical marker in it — means "no idea", and treating
        # that as "no" makes the filter delete correct answers.
        if category and candidate.category and candidate.category != category:
            continue
        if year and candidate.meta.get("year") != year:
            continue
        if resolution and candidate.meta.get("resolution") != resolution:
            continue
        if min_seeders and (candidate.seeders or 0) < min_seeders:
            continue
        kept.append(candidate)
    return kept


def _by_seeders(candidate: Candidate) -> tuple[object, ...]:
    return (candidate.seeders or 0, candidate.size_bytes or 0)


def _by_size(candidate: Candidate) -> tuple[object, ...]:
    return (candidate.size_bytes or 0, candidate.seeders or 0)


def _by_recency(candidate: Candidate) -> tuple[object, ...]:
    # ISO-8601 sorts lexicographically; "" sinks rows with no date to the back
    # under a descending sort, which is what TSP asks for.
    return (candidate.first_seen or "", candidate.seeders or 0)


_SORT_KEYS = {"size": _by_size, "recent": _by_recency}


def sort_candidates(candidates: list[Candidate], sort: str) -> list[Candidate]:
    """Order by *sort*, descending, with a total tie-break for stable paging."""
    primary = _SORT_KEYS.get(sort, _by_seeders)  # "" (server default) and "seeders"
    return sorted(candidates, key=lambda c: (primary(c), c.dedupe_key()), reverse=True)
