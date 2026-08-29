"""Fixture engine: never returns. Exercises the per-engine timeout and group kill."""

import time

from novaprinter import prettyPrinter


class fixslow:
    url = "https://fixslow.test"
    name = "Fixture Slow"
    supported_categories = {"all": ""}

    def search(self, what, cat="all"):
        prettyPrinter({
            "link": "magnet:?xt=urn:btih:4444444444444444444444444444444444444444",
            "name": "Printed Before Hanging 1080p",
            "size": 1, "seeds": 1, "leech": 1, "engine_url": self.url,
        })
        time.sleep(600)
