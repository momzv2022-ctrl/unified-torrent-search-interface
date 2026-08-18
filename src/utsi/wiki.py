"""Parser for `wiki/Unofficial-search-plugins.mediawiki`.

The community plugin list is not wiki-only: it is a file on `master` in
qbittorrent/search-plugins, which a `deploy_wiki.yaml` workflow mirrors to the
GitHub wiki. Tracking the repo file gives commit history, blame and PR context
from a plain `git clone`, with no API token.

Shape, as measured: two sections (`Plugins for Public Sites`, `Plugins for
Private Sites`), rows separated by `|-`, cells introduced by a leading `|`, six
columns — Search Engine, Author (Repository), Version, Last update, Download
link, Comments.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .registry import STATUS_BROKEN, STATUS_OK, STATUS_WARN

PUBLIC_SECTION = "Plugins for Public Sites"
PRIVATE_SECTION = "Plugins for Private Sites"

_SECTION = re.compile(r"^==\s*(.+?)\s*==\s*$")
_EXTERNAL_LINK = re.compile(r"\[(\S+)(?:\s+([^\]]*))?\]")
_PY_URL = re.compile(r"https?://\S+?\.py\b")
#: `[[...]]` is only ever an image here (favicons, the download badge). Dropping
#: these first is what keeps `[url label]` extraction from matching the badge.
_IMAGE = re.compile(r"\[\[[^\]]*\]\]")
#: The column is hand-maintained, so both `19/Mar<br>2023` and `13/Apr/2024`
#: occur; `<br>` has already collapsed to a space by the time this runs.
_DATE = re.compile(r"(\d{1,2})\s*/\s*([A-Za-z]{3})\w*[\s/]*(\d{4})")
_MONTHS = {
    m: i
    for i, m in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), start=1
    )
}


@dataclass(slots=True)
class WikiPlugin:
    """One table row, already reduced to what the registry needs."""

    id: str
    url: str
    site: str
    site_url: str
    author: str
    repo: str
    version: str
    last_update: str
    status: str
    comments: str
    private: bool

    def rank(self) -> tuple[int, int, str]:
        """Preference order when two rows claim the same module name."""
        status_rank = {STATUS_OK: 0, STATUS_WARN: 1, STATUS_BROKEN: 2}[self.status]
        return (int(self.private), status_rank, _invert(self.last_update))


def _cells(row: str) -> list[str]:
    """Split a MediaWiki table row into its cells.

    Cells start at a line-leading `|`; continuation lines belong to the cell
    above, which matters because the Comments column wraps with `<br>`.
    """
    cells: list[str] = []
    for line in row.splitlines():
        stripped = line.strip()
        if stripped.startswith("|") and not stripped.startswith("|-"):
            cells.append(stripped[1:].strip())
        elif cells and stripped:
            cells[-1] += " " + stripped
    return cells


def _status(comments: str) -> str:
    """Worst glyph wins.

    A row can carry several — "✔ qbt 4.1.x / Python 3.5.0 <br>❗ qbt 4.3.0.1" is
    real. The wiki states ✖ and ❗ plugins "will result in the slowdown and
    malfunction of other plugins as well", so the pessimistic reading is the
    only safe one.
    """
    if "✖" in comments:
        return STATUS_BROKEN
    if "❗" in comments:
        return STATUS_WARN
    return STATUS_OK


def _label(cell: str) -> tuple[str, str]:
    """First `[url label]` in a cell, as ``(label, url)``."""
    cleaned = _IMAGE.sub(" ", cell)
    for match in _EXTERNAL_LINK.finditer(cleaned):
        url, label = match.group(1), (match.group(2) or "").strip()
        if url.startswith(("http://", "https://")) and label:
            return _strip_markup(label), url.rstrip("].,")
    return _strip_markup(cleaned), ""


def _strip_markup(text: str) -> str:
    text = _IMAGE.sub(" ", text)
    text = _EXTERNAL_LINK.sub(lambda m: (m.group(2) or "").strip(), text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("'''", "").replace("''", "")
    return " ".join(text.split()).strip("[] ")


def _iso_date(cell: str) -> str:
    """`19/Mar<br>2023` -> `2023-03-19`; empty when the cell is not a date."""
    match = _DATE.search(cell)
    if not match:
        return ""
    month = _MONTHS.get(match.group(2).lower())
    if not month:
        return ""
    return f"{int(match.group(3)):04d}-{month:02d}-{int(match.group(1)):02d}"


_BLOB = re.compile(r"^https?://github\.com/([^/]+)/([^/]+)/blob/(.+)$", re.IGNORECASE)


def normalize_source_url(url: str) -> str:
    """Point at raw bytes rather than a rendered page.

    A `github.com/o/r/blob/ref/x.py` link serves HTML; fetching it would hand
    the static scan a syntax error instead of a plugin.
    """
    match = _BLOB.match(url)
    if match:
        owner, repo, rest = match.groups()
        return f"https://raw.githubusercontent.com/{owner}/{repo}/{rest}"
    return url


def _plugin_url(cell: str) -> str:
    """The `.py` download link, ignoring the badge images around it."""
    match = _PY_URL.search(_IMAGE.sub(" ", cell))
    return normalize_source_url(match.group(0).rstrip("].,")) if match else ""


def parse(text: str) -> list[WikiPlugin]:
    """Every plugin row in the page, public and private sections alike."""
    plugins: list[WikiPlugin] = []
    section = ""
    buffer: list[str] = []

    def flush() -> None:
        if not buffer:
            return
        row = "\n".join(buffer)
        buffer.clear()
        plugin = _row_to_plugin(row, section)
        if plugin is not None:
            plugins.append(plugin)

    for line in text.splitlines():
        heading = _SECTION.match(line)
        if heading:
            flush()
            section = heading.group(1)
            continue
        if section not in (PUBLIC_SECTION, PRIVATE_SECTION):
            continue
        if line.strip().startswith("|-"):
            flush()
            continue
        if line.strip().startswith("|}"):
            flush()
            section = ""
            continue
        buffer.append(line)
    flush()
    return plugins


def _row_to_plugin(row: str, section: str) -> WikiPlugin | None:
    cells = _cells(row)
    if len(cells) < 6 or cells[0].startswith("!"):
        return None

    url = _plugin_url(cells[4])
    if not url:
        return None

    site, site_url = _label(cells[0])
    author, repo = _label(cells[1])
    module = url.rsplit("/", 1)[-1].removesuffix(".py")
    if not module or not module.isidentifier():
        return None

    return WikiPlugin(
        id=module,
        url=url,
        site=site,
        site_url=site_url,
        author=author,
        repo=repo,
        version=_strip_markup(cells[2]),
        last_update=_iso_date(_strip_markup(cells[3])),
        status=_status(cells[5]),
        comments=_strip_markup(cells[5]),
        private=section == PRIVATE_SECTION,
    )


def _invert(iso_date: str) -> str:
    """Sort newest-first under an ascending sort; undated rows go last."""
    return "".join(chr(ord("9") - int(c)) if c.isdigit() else c for c in iso_date) or "~"


def dedupe(plugins: list[WikiPlugin]) -> list[WikiPlugin]:
    """One row per module name.

    nova3 keys engines by module name and requires the class inside to match,
    so two `thepiratebay.py` entries from different authors cannot coexist in
    one engines directory. Public beats private, ✔ beats ❗ beats ✖, and the
    most recently updated wins the remaining ties.
    """
    best: dict[str, WikiPlugin] = {}
    for plugin in plugins:
        incumbent = best.get(plugin.id)
        if incumbent is None or plugin.rank() < incumbent.rank():
            best[plugin.id] = plugin
    return sorted(best.values(), key=lambda p: p.id)
