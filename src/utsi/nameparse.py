"""Pull TSP metadata out of a release name.

No nova3 plugin supplies ``year``, ``resolution``, ``codec``, ``source``,
``season`` or ``episode``. The release name is the only place they exist, so
this module is the sole source for those six fields.

Every value is normalised to a stable token so that a client filtering on
``res=1080p`` matches whether the name said ``1080p``, ``FHD`` or ``1920x1080``.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import asdict, dataclass

#: TSP's `res` enum.
RESOLUTIONS = ("2160p", "1080p", "720p", "480p")


@dataclass(slots=True)
class NameInfo:
    year: str = ""
    resolution: str = ""
    codec: str = ""
    source: str = ""
    season: str = ""
    episode: str = ""

    def as_dict(self) -> dict[str, str]:
        """Only the fields that were actually found."""
        return {key: value for key, value in asdict(self).items() if value}


# Separator characters TSP calls out, plus the bracketing scene names use.
_SEPARATORS = re.compile(r"[._\-+()\[\]{},]+")

_RESOLUTION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("2160p", re.compile(r"\b(2160p|4k|uhd|3840\s?x\s?2160)\b", re.IGNORECASE)),
    ("1080p", re.compile(r"\b(1080[pi]|fhd|1920\s?x\s?1080)\b", re.IGNORECASE)),
    ("720p", re.compile(r"\b(720p|hd\s?ready|1280\s?x\s?720)\b", re.IGNORECASE)),
    ("480p", re.compile(r"\b(480[pi]|sd|640\s?x\s?480|854\s?x\s?480)\b", re.IGNORECASE)),
)

_CODEC_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("x265", re.compile(r"\b(x265|h\s?265|hevc)\b", re.IGNORECASE)),
    ("x264", re.compile(r"\b(x264|h\s?264|avc)\b", re.IGNORECASE)),
    ("av1", re.compile(r"\bav1\b", re.IGNORECASE)),
    ("vp9", re.compile(r"\bvp9\b", re.IGNORECASE)),
    ("xvid", re.compile(r"\bxvid\b", re.IGNORECASE)),
    ("divx", re.compile(r"\bdivx\b", re.IGNORECASE)),
    ("mpeg2", re.compile(r"\b(mpeg\s?2|mpeg2video)\b", re.IGNORECASE)),
)

# Longest/most specific first: "bdremux" must win over "bdrip", "web-dl" over "web".
_SOURCE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("remux", re.compile(r"\b(remux|bd\s?remux|bdmux)\b", re.IGNORECASE)),
    (
        "bluray",
        re.compile(r"\b(blu\s?ray|bluray|bd\s?rip|bdrip|br\s?rip|brrip|bd\s?25|bd\s?50)\b", re.IGNORECASE),
    ),
    ("web-dl", re.compile(r"\b(web\s?dl|webdl)\b", re.IGNORECASE)),
    ("webrip", re.compile(r"\b(web\s?rip|webrip|web)\b", re.IGNORECASE)),
    ("hdtv", re.compile(r"\b(hd\s?tv|hdtv|pdtv|dsr)\b", re.IGNORECASE)),
    ("dvd", re.compile(r"\b(dvd\s?rip|dvdrip|dvd\s?r|dvd5|dvd9|dvd)\b", re.IGNORECASE)),
    ("hdrip", re.compile(r"\b(hd\s?rip|hdrip)\b", re.IGNORECASE)),
    ("screener", re.compile(r"\b(dvd\s?scr|screener|scr)\b", re.IGNORECASE)),
    ("telesync", re.compile(r"\b(telesync|hd\s?ts|ts)\b", re.IGNORECASE)),
    ("cam", re.compile(r"\b(cam\s?rip|camrip|hd\s?cam|cam)\b", re.IGNORECASE)),
)

_YEAR = re.compile(r"\b(19[0-9]{2}|20[0-9]{2})\b")

_SEASON_EPISODE = re.compile(r"\bs\s?(\d{1,2})\s?e\s?(\d{1,3})(?:\s?-\s?e?\d{1,3})?\b", re.IGNORECASE)
_SEASON_X_EPISODE = re.compile(r"\b(\d{1,2})x(\d{2,3})\b")
_SEASON_ONLY = re.compile(r"\b(?:season|series)\s?(\d{1,2})\b|\bs\s?(\d{1,2})\b(?!\s?e\d)", re.IGNORECASE)
_EPISODE_ONLY = re.compile(r"\b(?:episode|ep)\s?(\d{1,3})\b", re.IGNORECASE)

#: A year is only a *release* year if it precedes one of these markers; that is
#: what separates `2012.2009.1080p` (film "2012", released 2009) from a title
#: that merely contains a number.
_QUALITY_MARKER = re.compile(
    r"\b(2160p|1080[pi]|720p|480[pi]|4k|uhd|x26[45]|h\s?26[45]|hevc|avc|xvid|divx|av1"
    r"|blu\s?ray|bluray|bd\s?rip|bdrip|br\s?rip|web\s?dl|webdl|web\s?rip|webrip|hd\s?tv|hdtv"
    r"|dvd\s?rip|dvdrip|remux|complete|multi|proper|repack|extended|unrated|imax)\b",
    re.IGNORECASE,
)


def _normalize(name: str) -> str:
    """Turn scene punctuation into spaces so ``\\b`` anchors behave."""
    return _SEPARATORS.sub(" ", name)


def _first_match(text: str, patterns: tuple[tuple[str, re.Pattern[str]], ...]) -> str:
    """The canonical token whose pattern matches earliest in *text*.

    Scanning by position rather than by rule order keeps `WEB-DL` from losing to
    a stray `TS` later in the name, while the ordering within equal positions
    still favours the more specific rule.
    """
    best: tuple[int, int, str] | None = None
    for rank, (token, pattern) in enumerate(patterns):
        match = pattern.search(text)
        if match and (best is None or match.start() < best[0]):
            best = (match.start(), rank, token)
    return best[2] if best else ""


def _pick_year(text: str) -> str:
    candidates = list(_YEAR.finditer(text))
    if not candidates:
        return ""

    horizon = dt.date.today().year + 1
    plausible = [m for m in candidates if 1900 <= int(m.group(1)) <= horizon]
    if not plausible:
        return ""
    if len(plausible) == 1:
        return plausible[0].group(1)

    marker = _QUALITY_MARKER.search(text)
    if marker:
        before = [m for m in plausible if m.end() <= marker.start()]
        if before:
            return before[-1].group(1)
    return plausible[-1].group(1)


def _pick_season_episode(text: str) -> tuple[str, str]:
    match = _SEASON_EPISODE.search(text) or _SEASON_X_EPISODE.search(text)
    if match:
        return f"{int(match.group(1)):02d}", f"{int(match.group(2)):02d}"

    season = ""
    season_match = _SEASON_ONLY.search(text)
    if season_match:
        raw = season_match.group(1) or season_match.group(2)
        if raw:
            season = f"{int(raw):02d}"

    episode = ""
    episode_match = _EPISODE_ONLY.search(text)
    if episode_match:
        episode = f"{int(episode_match.group(1)):02d}"
    return season, episode


def parse_name(name: str) -> NameInfo:
    """Extract the six TSP metadata fields a release name can carry."""
    if not name:
        return NameInfo()

    text = _normalize(name)
    season, episode = _pick_season_episode(text)
    return NameInfo(
        year=_pick_year(text),
        resolution=_first_match(text, _RESOLUTION_PATTERNS),
        codec=_first_match(text, _CODEC_PATTERNS),
        source=_first_match(text, _SOURCE_PATTERNS),
        season=season,
        episode=episode,
    )


def normalize_query(query: str) -> str:
    """Apply TSP's query rules: ``.``, ``_`` and ``-`` are separators.

    Word order is irrelevant to TSP, so we only collapse separators and
    whitespace; the plugin decides how to match the terms.
    """
    return " ".join(_SEPARATORS.sub(" ", query).split())
