"""Category translation between the Torrent Stream Protocol and nova3.

TSP has six categories, nova3 has nine, and neither is a subset of the other.
Two directions matter:

* **request** — which single nova3 category to ask an engine for. nova3 accepts
  exactly one per invocation and silently drops an engine that does not declare
  the category it was handed, so we only ever send a declared one.
* **classify** — nova3 result lines carry no category field, so when we had to
  request ``all`` the only signal left is the release name.
"""

from __future__ import annotations

import re

#: The nova3 `Category` enum, verbatim.
NOVA_CATEGORIES = ("all", "anime", "books", "games", "movies", "music", "pictures", "software", "tv")

#: The TSP `cat` enum, minus the empty string that means "no filter".
TSP_CATEGORIES = ("video", "audio", "software", "archive", "document", "image")

#: TSP category -> generic queries that stand in for an empty one, best first.
#:
#: An empty `q` means "browse the whole index" in TSP, and a meta-search has no
#: index to browse, so it asks the sites something generic instead. *Which*
#: generic thing has to depend on the category, because both halves of the
#: pipeline reject the mismatch: browsing `cat=audio` for "1080p" asks each site
#: for the few music torrents that mention a video resolution, and `classify_name`
#: throws out whatever did come back.
#:
#: So each list is words that are common in that category's release names *and*
#: that `classify_name` reads back as that category — the two constraints an
#: empty query has to satisfy at once. `archive` is the weakest of the six:
#: nothing describes itself as an archive, so it leans on the names that carry
#: the extension.
BROWSE_TERMS: dict[str, tuple[str, ...]] = {
    "video": ("2160p", "1080p", "x265"),
    "audio": ("flac", "mp3", "discography"),
    "software": ("x64", "iso", "repack"),
    "document": ("epub", "pdf", "ebook"),
    "image": ("wallpapers", "imageset", "photos"),
    "archive": ("rar", "zip", "7z"),
}

#: TSP category -> the nova3 categories that fall inside it, best first.
TSP_TO_NOVA: dict[str, tuple[str, ...]] = {
    "video": ("movies", "tv", "anime"),
    "audio": ("music",),
    "software": ("software", "games"),
    "document": ("books",),
    "image": ("pictures",),
    # No nova3 category means "a compressed archive"; ask for everything and
    # keep only what the name betrays.
    "archive": (),
}

#: nova3 category -> the TSP category it lands in.
NOVA_TO_TSP: dict[str, str] = {
    "movies": "video",
    "tv": "video",
    "anime": "video",
    "music": "audio",
    "software": "software",
    "games": "software",
    "books": "document",
    "pictures": "image",
}


def plan_request(tsp_category: str, supported: tuple[str, ...] | list[str]) -> tuple[str, bool] | None:
    """Choose the nova3 category to request from one engine.

    Returns ``(nova_category, precise)`` where *precise* means every row the
    engine returns is known to belong to *tsp_category* without inspecting the
    name. Returns ``None`` when the engine cannot serve the category at all.
    """
    declared = set(supported)
    if not tsp_category:
        return ("all", False)

    wanted = [c for c in TSP_TO_NOVA.get(tsp_category, ()) if c in declared]
    if len(wanted) == 1:
        return (wanted[0], True)
    # Either the engine covers several of the wanted nova3 categories (one
    # invocation cannot ask for all of them) or none of them. Both collapse to
    # "ask for everything, filter on the name".
    if "all" in declared or not declared:
        return ("all", False)
    return None


# --- name classification --------------------------------------------------

_EXTENSION = re.compile(r"\.([a-z0-9]{2,5})$", re.IGNORECASE)

_EXTENSION_CATEGORY = {
    "mkv": "video", "mp4": "video", "avi": "video", "mov": "video", "m4v": "video",
    "wmv": "video", "mpg": "video", "mpeg": "video", "flv": "video", "webm": "video",
    "mp3": "audio", "flac": "audio", "wav": "audio", "aac": "audio", "ogg": "audio",
    "m4a": "audio", "opus": "audio", "alac": "audio", "wma": "audio", "ape": "audio",
    "pdf": "document", "epub": "document", "mobi": "document", "azw3": "document",
    "djvu": "document", "cbr": "document", "cbz": "document", "chm": "document",
    "jpg": "image", "jpeg": "image", "png": "image", "gif": "image", "bmp": "image",
    "tiff": "image", "webp": "image", "psd": "image", "svg": "image",
    "exe": "software", "msi": "software", "dmg": "software", "apk": "software",
    "deb": "software", "rpm": "software", "pkg": "software", "appimage": "software",
    "rar": "archive", "zip": "archive", "7z": "archive", "tar": "archive",
    "gz": "archive", "bz2": "archive", "xz": "archive", "tgz": "archive",
}

# Ordered rules: the first family with a hit wins. Video markers come first
# because scene video names are the most distinctive, and because a game or
# application name essentially never carries a resolution or an SxxEyy tag.
_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "video",
        re.compile(
            r"\b("
            r"2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?|dolby[. _-]?vision"
            r"|x26[45]|h[. _-]?26[45]|hevc|avc|xvid|divx|av1"
            r"|blu[. _-]?ray|bd(?:rip|remux|mux)|br[. _-]?rip|web[. _-]?(?:dl|rip)"
            r"|hd(?:tv|rip|cam)|dvd(?:rip|scr|r)?|remux|telesync|cam[. _-]?rip"
            r"|s\d{1,2}[. _-]?e\d{1,3}|\d{1,2}x\d{2}|season[. _-]?\d{1,2}"
            r"|complete[. _-]series|episode[. _-]?\d{1,3}"
            r"|dts(?:[. _-]?hd)?|ddp?\d[. _-]?\d|aac\d[. _-]?\d|truehd|atmos"
            r")\b",
            re.IGNORECASE,
        ),
    ),
    (
        "audio",
        re.compile(
            r"\b("
            r"flac|mp3|aac|alac|ogg|opus|wav|ape|dsd"
            r"|\d{2,3}\s?kbps|v0|v2|cbr|vbr"
            r"|discography|anthology|album|ep|single|soundtrack|ost|bootleg"
            r"|audiobook|audio[. _-]?book|vinyl|cd[. _-]?(?:rip|q|da)|web[. _-]?flac"
            r")\b",
            re.IGNORECASE,
        ),
    ),
    (
        "software",
        re.compile(
            r"\b("
            r"x64|x86|win(?:32|64|dows)?|macos|osx|linux|ubuntu|debian|fedora|arch"
            r"|v\d+(?:\.\d+)+|build[. _-]?\d+|portable|multilingual|activated"
            r"|crack(?:ed|fix)?|keygen|patch|repack|pre[. _-]?activated|iso"
            r"|fitgirl|dodi|codex|plaza|skidrow|reloaded|empress|razor1911|tenoke"
            r"|gog|steam|denuvo|update[. _-]?only|dlc"
            r")\b",
            re.IGNORECASE,
        ),
    ),
    (
        "document",
        re.compile(
            r"\b("
            r"ebook|e[. _-]?book|epub|pdf|mobi|azw3|retail|magazine|comics?|manga"
            r"|\d(?:st|nd|rd|th)[. _-]?edition|textbook|novel|paperback"
            r")\b",
            re.IGNORECASE,
        ),
    ),
    (
        "image",
        re.compile(
            r"\b(wallpapers?|imageset|image[. _-]?pack|photos?|pics|pictures|artwork"
            r"|hi[. _-]?res[. _-]?scans)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "archive",
        re.compile(r"\b(rar|zip|7z|tar|tgz|gz|bz2|xz)\b", re.IGNORECASE),
    ),
)


def classify_name(name: str) -> str | None:
    """Best-effort TSP category for a release name, or ``None`` if unreadable.

    ``None`` means "no idea", which is not the same as "no". Every rule here
    keys off a technical marker — a resolution, a codec, a format — and a great
    many real releases carry none: "Big Buck Bunny", "Sintel 2010", most of
    what a DHT crawl returns. Callers filtering by category must keep those,
    because dropping them makes a filter delete correct answers rather than
    narrow them, and the caller can see the name too.
    """
    if not name:
        return None

    match = _EXTENSION.search(name.strip())
    if match:
        category = _EXTENSION_CATEGORY.get(match.group(1).lower())
        if category:
            return category

    for category, pattern in _RULES:
        if pattern.search(name):
            return category
    return None
