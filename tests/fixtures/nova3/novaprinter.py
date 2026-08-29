"""Test double for the nova3 `novaprinter` module.

Not a copy of upstream: this is the minimum surface a plugin touches, written
so the tests can exercise the real wire format offline. The format itself
(`link|name|size|seeds|leech|engine_url|desc_link|pub_date`, size already in
bytes, `-1` for unknown, `|` stripped from the name) is what upstream
`prettyPrinter` v1.54 emits.
"""

import re

_UNITS = {"T": 40, "G": 30, "M": 20, "K": 10}
_SIZE = re.compile(r"^(?P<size>\d*\.?\d+) *(?P<unit>[a-z]+)?", re.IGNORECASE)


def anySizeToBytes(size_string):
    if isinstance(size_string, int):
        return size_string
    if isinstance(size_string, float):
        return round(size_string)
    match = _SIZE.match(str(size_string).strip())
    if match is None:
        return -1
    size = float(match.group("size"))
    unit = match.group("unit")
    if unit is not None:
        size *= 2 ** _UNITS.get(unit[0].upper(), 0)
    return round(size)


def prettyPrinter(dictionary):
    outtext = "|".join((
        dictionary["link"],
        dictionary["name"].replace("|", " "),
        str(anySizeToBytes(dictionary["size"])),
        str(dictionary["seeds"]),
        str(dictionary["leech"]),
        dictionary["engine_url"],
        dictionary.get("desc_link", ""),
        str(dictionary.get("pub_date", -1)),
    ))
    with open(1, "w", encoding="utf-8", closefd=False) as utf8stdout:
        print(outtext, file=utf8stdout)
