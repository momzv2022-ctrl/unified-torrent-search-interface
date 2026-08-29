"""Fixture engine whose class name only matches the module case-insensitively.

Real plugins do this (`rutracker.py` defines `class RuTracker`); nova3 drops
them, the shim recovers them.
"""

from novaprinter import prettyPrinter


class FixCase:
    url = "https://fixcase.test"
    name = "Fixture Case Mismatch"
    supported_categories = {"all": ""}

    def search(self, what, cat="all"):
        prettyPrinter({
            "link": "magnet:?xt=urn:btih:6666666666666666666666666666666666666666",
            "name": "Case Mismatch Recovered 1080p",
            "size": 1024, "seeds": 3, "leech": 0, "engine_url": self.url,
        })
