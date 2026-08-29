"""Fixture engine: reports the same content as `fixmagnet`, differently.

Shorter names, higher seed counts, base32 infohashes — enough to exercise
dedupe by infohash, longest-name-wins, and `max()` on the swarm counts.
"""

import base64

from novaprinter import prettyPrinter

ROWS = [
    ("2c6b6858d61da9543d4231a71db4b1c9264b0685", "Big Buck Bunny 1080p", 2147483648, 999, 77, -1),
    ("deadbeef00000000000000000000000000000001", "Unique To This Engine 1080p x264", 1073741824, 50, 5, 1650000000),
]


class fixoverlap:
    url = "https://fixoverlap.test"
    name = "Fixture Overlap"
    supported_categories = {"all": ""}

    def search(self, what, cat="all"):
        for infohash, name, size, seeds, leech, pub in ROWS:
            b32 = base64.b32encode(bytes.fromhex(infohash)).decode()
            prettyPrinter({
                "link": f"magnet:?xt=urn:btih:{b32}",
                "name": name,
                "size": size,
                "seeds": seeds,
                "leech": leech,
                "engine_url": self.url,
                "pub_date": pub,
            })
