"""Fixture engine: the common case — `link` is already a magnet URI."""

from novaprinter import prettyPrinter

ROWS = [
    ("2c6b6858d61da9543d4231a71db4b1c9264b0685", "Big Buck Bunny 2008 1080p BluRay x264-GROUP", 2147483648, 412, 20, 1700000000),
    ("bcd6e4cf65da2b83e1e2f5e0e1e6a2a9f6b0d1c2", "Sintel 2010 2160p WEB-DL x265 HDR", 8589934592, 95, 4, 1600000000),
    ("aabbccddeeff00112233445566778899aabbccdd", "Ubuntu 24.04 LTS Desktop amd64 iso", 5368709120, 1200, 33, -1),
    ("1111111111111111111111111111111111111111", "Some.Show.S02E05.720p.HDTV.x264", 734003200, 8, 1, 1710000000),
]


class fixmagnet:
    url = "https://fixmagnet.test"
    name = "Fixture Magnet"
    supported_categories = {"all": "0", "movies": "200", "tv": "205", "music": "100"}

    def search(self, what, cat="all"):
        for infohash, name, size, seeds, leech, pub in ROWS:
            prettyPrinter({
                "link": f"magnet:?xt=urn:btih:{infohash}&dn={name.replace(' ', '+')}",
                "name": name,
                "size": size,
                "seeds": seeds,
                "leech": leech,
                "engine_url": self.url,
                "desc_link": f"{self.url}/t/{infohash}",
                "pub_date": pub,
            })
