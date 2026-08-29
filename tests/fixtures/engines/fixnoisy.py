"""Fixture engine: interleaves debug chatter and malformed lines with real rows."""

from novaprinter import prettyPrinter


class fixnoisy:
    url = "https://fixnoisy.test"
    name = "Fixture Noisy"
    supported_categories = {"all": "", "music": "music"}

    def search(self, what, cat="all"):
        print("DEBUG: fetching page 1")
        print("not|enough|fields")
        prettyPrinter({
            "link": "magnet:?xt=urn:btih:5555555555555555555555555555555555555555",
            "name": "Pink Floyd - The Wall (1979) [FLAC]",
            "size": "1.4 GB", "seeds": -1, "leech": -1,
            "engine_url": self.url, "pub_date": 1234567890000,
        })
        print("DEBUG: done")
