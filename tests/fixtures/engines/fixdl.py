"""Fixture engine: `link` is an opaque token, the limetorrents shape.

`download_torrent()` prints `"<magnet> <original_param>"`, which is what nova3
guarantees and what the runner splits on the last space.
"""

from novaprinter import prettyPrinter

RESOLVABLE = "3333333333333333333333333333333333333333"


class fixdl:
    url = "https://fixdl.test"
    name = "Fixture Needs Download"
    supported_categories = {"all": ""}

    def search(self, what, cat="all"):
        for index, (token, name, seeds) in enumerate((
            ("resolvable", "Fixture Lazy Resolve 2021 2160p WEB-DL x265", 700),
            ("broken", "Fixture Lazy Broken 2021 1080p", 600),
        )):
            prettyPrinter({
                "link": f"{self.url}/torrent/{token}",
                "name": name,
                "size": 1073741824 * (index + 1),
                "seeds": seeds,
                "leech": 2,
                "engine_url": self.url,
                "pub_date": -1,
            })

    def download_torrent(self, info):
        if info.endswith("/resolvable"):
            print(f"magnet:?xt=urn:btih:{RESOLVABLE}&dn=resolved {info}")
        else:
            raise ValueError("cannot resolve this one")
