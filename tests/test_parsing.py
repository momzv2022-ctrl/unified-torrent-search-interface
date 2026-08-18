"""The nova3 wire format, name parsing, categories and magnets."""

from __future__ import annotations

import base64

import pytest

from utsi.categories import NOVA_TO_TSP, classify_name, plan_request
from utsi.magnet import (
    build_magnet,
    display_name_from_magnet,
    infohash_from_magnet,
    looks_like_torrent_url,
    normalize_infohash,
    parse_torrent,
)
from utsi.nameparse import normalize_query, parse_name
from utsi.runner import parse_line, parse_output

HASH = "2c6b6858d61da9543d4231a71db4b1c9264b0685"


# --- the eight-field line --------------------------------------------------


def test_parse_line_reads_every_field():
    row = parse_line(
        f"magnet:?xt=urn:btih:{HASH}|Some Release 1080p|2147483648|412|20"
        "|https://site.test|https://site.test/d/1|1700000000"
    )
    assert row is not None
    assert row.link.startswith("magnet:")
    assert row.name == "Some Release 1080p"
    assert row.size_bytes == 2147483648  # already bytes on the wire, never re-parsed
    assert row.seeders == 412
    assert row.leechers == 20
    assert row.engine_url == "https://site.test"
    assert row.desc_link == "https://site.test/d/1"
    assert row.pub_date == 1700000000


def test_minus_one_means_unknown_not_zero():
    row = parse_line(f"magnet:?xt=urn:btih:{HASH}|N|-1|-1|-1|u||-1")
    assert row is not None
    assert (row.size_bytes, row.seeders, row.leechers, row.pub_date) == (None, None, None, None)


def test_zero_seeders_is_a_real_value():
    row = parse_line(f"magnet:?xt=urn:btih:{HASH}|N|0|0|0|u||-1")
    assert row is not None
    assert (row.size_bytes, row.seeders, row.leechers) == (0, 0, 0)


def test_millisecond_pub_date_is_recovered():
    row = parse_line(f"magnet:?xt=urn:btih:{HASH}|N|1|1|1|u||1234567890000")
    assert row is not None and row.pub_date == 1234567890


@pytest.mark.parametrize(
    "line",
    [
        "",
        "too|few|fields",
        "DEBUG: fetching page 2",
        "|missing link|1|1|1|u||-1",
        f"magnet:?xt=urn:btih:{HASH}||1|1|1|u||-1",  # empty name
        "-1|placeholder row|1|1|1|u||-1",  # torrentproject's unset link sentinel
    ],
)
def test_malformed_lines_are_skipped(line):
    assert parse_line(line) is None


def test_a_pipe_inside_the_link_does_not_shift_the_fields():
    # Splitting from the left would push the leftover into `name` and slide
    # every numeric field along by one.
    row = parse_line("https://site.test/a|b.torrent|Name Here|10|2|1|https://site.test||-1")
    assert row is not None
    assert row.link == "https://site.test/a|b.torrent"
    assert row.name == "Name Here"
    assert (row.size_bytes, row.seeders, row.leechers) == (10, 2, 1)
    assert row.pub_date is None


def test_parse_output_keeps_only_result_lines():
    stdout = (
        "DEBUG: page 1\n"
        f"magnet:?xt=urn:btih:{HASH}|A|1|1|1|u||-1\n"
        "garbage\n"
        f"magnet:?xt=urn:btih:{HASH}|B|2|2|2|u||-1\n"
    )
    assert [row.name for row in parse_output(stdout)] == ["A", "B"]


# --- infohashes and magnets ------------------------------------------------


def test_base32_infohash_becomes_hex():
    b32 = base64.b32encode(bytes.fromhex(HASH)).decode()
    assert normalize_infohash(b32) == HASH


@pytest.mark.parametrize("value", ["", None, "nothex", "2c6b6858", "z" * 40])
def test_unusable_infohashes_are_rejected(value):
    assert normalize_infohash(value) is None


def test_magnet_roundtrip():
    magnet = build_magnet(HASH, "A Name With Spaces", ("udp://t.test:80/announce",))
    assert infohash_from_magnet(magnet) == HASH
    assert display_name_from_magnet(magnet) == "A Name With Spaces"


def test_uppercase_magnet_infohash_is_normalised():
    assert infohash_from_magnet(f"magnet:?xt=urn:btih:{HASH.upper()}&dn=x") == HASH


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://s.test/tor/1.torrent", True),
        ("https://s.test/dl?file=x.torrent&k=1", True),
        ("https://s.test/torrent/12345", False),
        ("magnet:?xt=urn:btih:" + HASH, False),
    ],
)
def test_torrent_url_detection(url, expected):
    assert looks_like_torrent_url(url) is expected


# --- .torrent files --------------------------------------------------------


def test_parse_torrent_derives_infohash_size_and_trackers(request):
    from tests.conftest import TORRENT_BYTES, TORRENT_INFOHASH

    meta = parse_torrent(TORRENT_BYTES)
    assert meta is not None
    assert meta.infohash == TORRENT_INFOHASH
    assert meta.size_bytes == 123456
    assert meta.files == 1
    assert meta.trackers == ("udp://tracker.fixture.test:6969/announce",)
    assert infohash_from_magnet(meta.magnet()) == TORRENT_INFOHASH


@pytest.mark.parametrize("data", [b"", b"not bencode", b"d", b"d4:infoi1ee", b"dxxx"])
def test_unparseable_torrents_return_none(data):
    assert parse_torrent(data) is None


def test_multi_file_torrent_totals_the_sizes():
    from tests.conftest import bencode

    info = {
        "name": "Pack",
        "piece length": 262144,
        "pieces": b"\x00" * 20,
        "files": [{"length": 100, "path": ["a"]}, {"length": 250, "path": ["b"]}],
    }
    meta = parse_torrent(bencode({"info": info}))
    assert meta is not None
    assert (meta.size_bytes, meta.files) == (350, 2)


# --- release names ---------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        (
            "Blade.Runner.2049.2017.2160p.UHD.BluRay.x265-TERMINAL",
            {"year": "2017", "resolution": "2160p", "codec": "x265", "source": "bluray"},
        ),
        (
            "Some.Show.S02E05.1080p.WEB-DL.x264-GRP",
            {"resolution": "1080p", "codec": "x264", "source": "web-dl", "season": "02", "episode": "05"},
        ),
        (
            "The.Office.US.3x11.HDTV.XviD",
            {"source": "hdtv", "codec": "xvid", "season": "03", "episode": "11"},
        ),
        ("Show Name Season 4 Complete 720p", {"resolution": "720p", "season": "04"}),
        ("Movie Name (2012) [480p] [DVDRip]", {"year": "2012", "resolution": "480p", "source": "dvd"}),
        ("No Metadata Here", {}),
    ],
)
def test_parse_name(name, expected):
    assert parse_name(name).as_dict() == expected


def test_a_numeric_title_does_not_steal_the_release_year():
    # "2012" is the film; 2009 is the release year, and it is the one adjacent
    # to the quality markers.
    assert parse_name("2012.2009.1080p.BluRay.x264").as_dict()["year"] == "2009"


def test_query_normalisation_treats_punctuation_as_separators():
    assert normalize_query("Sintel.2010-1080p") == "Sintel 2010 1080p"
    assert normalize_query("  spaced   out  ") == "spaced out"
    assert normalize_query("") == ""


# --- categories ------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Big Buck Bunny 2008 1080p BluRay x264", "video"),
        ("Pink Floyd - The Wall (1979) [FLAC]", "audio"),
        ("Adobe Photoshop 2024 v25.0 x64 Multilingual", "software"),
        ("Some Book 3rd Edition.epub", "document"),
        ("Nature Wallpapers 4000 Pack", "image"),
        ("Assorted Files.rar", "archive"),
        ("完全に不明", None),
    ],
)
def test_classify_name(name, expected):
    assert classify_name(name) == expected


def test_extension_beats_keyword():
    # A keyword match would call this video; the extension is the stronger signal.
    assert classify_name("Movie.1080p.x264.rar") == "archive"


@pytest.mark.parametrize(
    ("tsp_cat", "declared", "expected"),
    [
        # Exactly one nova3 category inside the TSP one: ask for it, trust it.
        ("audio", ("all", "music"), ("music", True)),
        ("document", ("all", "books"), ("books", True)),
        # Several inside it: one invocation cannot ask for all of them.
        ("video", ("all", "movies", "tv"), ("all", False)),
        # None declared: fall back to everything and filter on the name.
        ("video", ("all",), ("all", False)),
        ("archive", ("all", "movies"), ("all", False)),
        ("", ("all", "movies"), ("all", False)),
    ],
)
def test_plan_request(tsp_cat, declared, expected):
    assert plan_request(tsp_cat, declared) == expected


def test_engine_that_cannot_serve_the_category_is_skipped():
    # No `all`, and nothing overlapping `audio`: nova3 would silently drop it.
    assert plan_request("audio", ("movies", "tv")) is None


def test_nova_to_tsp_covers_every_nova_category_except_all():
    from utsi.categories import NOVA_CATEGORIES

    assert set(NOVA_TO_TSP) == set(NOVA_CATEGORIES) - {"all"}
