"""Fixture engine: `link` is a `.torrent` URL, the torlock shape.

The origin of the local test server arrives in a file beside this module, not
in the environment — the runner scrubs the environment down to an allowlist, so
there is no way to smuggle it in that way. The gateway really fetches the file,
bdecodes it and derives the infohash.
"""

import pathlib

from novaprinter import prettyPrinter

ORIGIN = (pathlib.Path(__file__).with_name("_fixture_origin.txt")).read_text().strip()


class fixtorrent:
    url = ORIGIN
    name = "Fixture Torrent URL"
    supported_categories = {"all": "", "movies": "movies"}

    def search(self, what, cat="all"):
        prettyPrinter({
            "link": f"{ORIGIN}/files/sample.torrent",
            "name": "Fixture Torrent Release 2019 1080p BluRay x264",
            "size": -1,
            "seeds": 42,
            "leech": 3,
            "engine_url": ORIGIN,
            "desc_link": f"{ORIGIN}/desc/1",
            "pub_date": 1500000000,
        })
        prettyPrinter({
            "link": f"{ORIGIN}/files/missing.torrent",
            "name": "Fixture Unresolvable 2019 1080p",
            "size": 100,
            "seeds": 500,
            "leech": 1,
            "engine_url": ORIGIN,
            "pub_date": -1,
        })
