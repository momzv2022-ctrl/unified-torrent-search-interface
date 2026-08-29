"""Infohashes, magnet URIs, and just enough bencode to read a .torrent.

TSP requires a ``magnet`` on every row, but nova3 plugins hand back three
different shapes of ``link`` (a magnet, a .torrent URL, or an opaque token that
needs a second round trip). Everything needed to get from any of them to a
magnet lives here.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from dataclasses import dataclass, field
from urllib.parse import parse_qs, quote, urlsplit

#: Public trackers used when synthesising a magnet from a .torrent that carries
#: no announce URL. Same list the official piratebay/torrentscsv plugins embed.
DEFAULT_TRACKERS: tuple[str, ...] = (
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://open.demonii.com:1337/announce",
)

_HEX40 = re.compile(r"^[0-9a-fA-F]{40}$")
_BASE32 = re.compile(r"^[A-Za-z2-7]{32}$")
_BTIH = re.compile(r"urn:btih:([0-9A-Za-z]{32,40})", re.IGNORECASE)


def normalize_infohash(raw: str | None) -> str | None:
    """Return a lowercase 40-character hex infohash, or ``None``.

    Accepts hex (40 chars) and base32 (32 chars), the two encodings BEP-9
    magnets use in the wild.
    """
    if not raw:
        return None
    value = raw.strip()
    if _HEX40.match(value):
        return value.lower()
    if _BASE32.match(value):
        try:
            return base64.b32decode(value.upper()).hex()
        except (binascii.Error, ValueError):
            return None
    return None


def infohash_from_magnet(magnet: str | None) -> str | None:
    if not magnet:
        return None
    match = _BTIH.search(magnet)
    return normalize_infohash(match.group(1)) if match else None


def display_name_from_magnet(magnet: str) -> str | None:
    try:
        names = parse_qs(urlsplit(magnet).query).get("dn")
    except ValueError:
        return None
    return names[0] if names else None


def build_magnet(infohash: str, name: str | None = None, trackers: tuple[str, ...] | None = None) -> str:
    parts = [f"magnet:?xt=urn:btih:{infohash}"]
    if name:
        parts.append("dn=" + quote(name, safe=""))
    for tracker in trackers if trackers is not None else DEFAULT_TRACKERS:
        parts.append("tr=" + quote(tracker, safe=""))
    return "&".join(parts)


def looks_like_magnet(link: str) -> bool:
    return link.lower().startswith("magnet:")


def looks_like_torrent_url(link: str) -> bool:
    """True when *link* is an HTTP(S) URL that plausibly serves a .torrent file."""
    if not link.lower().startswith(("http://", "https://")):
        return False
    try:
        parts = urlsplit(link)
    except ValueError:
        return False
    return parts.path.lower().endswith(".torrent") or ".torrent" in parts.query.lower()


# --- bencode ---------------------------------------------------------------


class BencodeError(ValueError):
    """The byte stream is not valid bencode."""


_MAX_DEPTH = 32


def _parse(data: bytes, index: int, depth: int = 0) -> tuple[object, int]:
    """Decode one bencoded value at *index*, returning it and the next index."""
    if depth > _MAX_DEPTH:
        raise BencodeError("nesting too deep")
    if index >= len(data):
        raise BencodeError("truncated")

    marker = data[index : index + 1]
    if marker == b"i":
        end = data.index(b"e", index)
        return int(data[index + 1 : end]), end + 1
    if marker == b"l":
        items: list[object] = []
        index += 1
        while data[index : index + 1] != b"e":
            value, index = _parse(data, index, depth + 1)
            items.append(value)
        return items, index + 1
    if marker == b"d":
        mapping: dict[bytes, object] = {}
        index += 1
        while data[index : index + 1] != b"e":
            key, index = _parse(data, index, depth + 1)
            value, index = _parse(data, index, depth + 1)
            if isinstance(key, bytes):
                mapping[key] = value
        return mapping, index + 1
    if marker.isdigit():
        colon = data.index(b":", index)
        length = int(data[index:colon])
        if length < 0:
            raise BencodeError("negative string length")
        start = colon + 1
        end = start + length
        if end > len(data):
            raise BencodeError("truncated string")
        return data[start:end], end

    raise BencodeError(f"unexpected byte {marker!r} at {index}")


@dataclass(slots=True)
class TorrentMeta:
    """What a .torrent file tells us that the result line did not."""

    infohash: str
    name: str | None = None
    size_bytes: int | None = None
    files: int | None = None
    trackers: tuple[str, ...] = field(default_factory=tuple)

    def magnet(self) -> str:
        return build_magnet(self.infohash, self.name, self.trackers or None)


def _text(value: object) -> str | None:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return None


def _collect_trackers(root: dict[bytes, object]) -> tuple[str, ...]:
    trackers: list[str] = []
    announce = _text(root.get(b"announce"))
    if announce:
        trackers.append(announce)
    tiers = root.get(b"announce-list")
    if isinstance(tiers, list):
        for tier in tiers:
            if isinstance(tier, list):
                trackers.extend(url for item in tier if (url := _text(item)))
    seen: set[str] = set()
    return tuple(url for url in trackers if not (url in seen or seen.add(url)))


def parse_torrent(data: bytes) -> TorrentMeta | None:
    """Read a .torrent file: v1 infohash, display name, total size, file count.

    The infohash is ``sha1(bencode(info_dict))``, taken over the *original*
    bytes of the info dict rather than a re-encoding, so a file that round-trips
    imperfectly still hashes correctly.
    """
    if not data.startswith(b"d"):
        return None

    try:
        index = 1
        info_span: tuple[int, int] | None = None
        root: dict[bytes, object] = {}
        while data[index : index + 1] != b"e":
            key, index = _parse(data, index)
            start = index
            value, index = _parse(data, index)
            if isinstance(key, bytes):
                root[key] = value
                if key == b"info":
                    info_span = (start, index)
    except (BencodeError, ValueError, IndexError):
        return None

    if info_span is None:
        return None
    info = root.get(b"info")
    if not isinstance(info, dict):
        return None

    infohash = hashlib.sha1(data[info_span[0] : info_span[1]], usedforsecurity=False).hexdigest()

    size: int | None = None
    files: int | None = None
    length = info.get(b"length")
    if isinstance(length, int):
        size, files = length, 1
    else:
        entries = info.get(b"files")
        if isinstance(entries, list):
            lengths = [e.get(b"length") for e in entries if isinstance(e, dict)]
            sizes = [n for n in lengths if isinstance(n, int)]
            if sizes:
                size, files = sum(sizes), len(entries)

    return TorrentMeta(
        infohash=infohash,
        name=_text(info.get(b"name")),
        size_bytes=size,
        files=files,
        trackers=_collect_trackers(root),
    )
