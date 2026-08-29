"""End-to-end fan-out: merge, sort, page, resolve, circuit-break."""

from __future__ import annotations

import pytest

from utsi.categories import BROWSE_TERMS, TSP_CATEGORIES, classify_name
from utsi.merge import apply_filters
from utsi.nameparse import matches_terms, query_terms
from utsi.normalize import Candidate
from utsi.provision import Provisioner
from utsi.registry import Health, Plugin
from utsi.search import SearchQuery, SearchService

from .conftest import TORRENT_INFOHASH, make_registry

BUNNY = "2c6b6858d61da9543d4231a71db4b1c9264b0685"


@pytest.fixture
async def service(settings, fixture_registry, torrent_origin, monkeypatch):
    report = await Provisioner(settings, fixture_registry).provision()
    created = SearchService(settings, report)
    try:
        yield created
    finally:
        await created.aclose()


def _by_hash(result, infohash):
    return next((t for t in result.torrents if t.infohash == infohash), None)


async def test_every_row_carries_a_magnet(service):
    result = await service.search(SearchQuery(q="anything", limit=200))
    assert result.torrents
    assert all(t.magnet and t.magnet.startswith("magnet:") for t in result.torrents)
    assert all(t.infohash and len(t.infohash) == 40 for t in result.torrents)


async def test_duplicates_merge_across_engines(service):
    result = await service.search(SearchQuery(q="anything", limit=200))
    bunny = _by_hash(result, BUNNY)
    assert bunny is not None
    # fixoverlap reports the same content in base32 with a higher seed count and
    # a shorter name; the merged row keeps the longest name and max() swarm.
    assert bunny.sources == ["fixmagnet", "fixoverlap"]
    assert bunny.name == "Big Buck Bunny 2008 1080p BluRay x264-GROUP"
    assert bunny.seeders == 999
    assert bunny.leechers == 77


async def test_metadata_is_parsed_from_the_name(service):
    result = await service.search(SearchQuery(q="anything", limit=200))
    bunny = _by_hash(result, BUNNY)
    assert (bunny.year, bunny.resolution, bunny.codec, bunny.source) == ("2008", "1080p", "x264", "bluray")

    show = next(t for t in result.torrents if "S02E05" in (t.name or ""))
    assert (show.season, show.episode) == ("02", "05")


async def test_pub_date_becomes_iso_and_minus_one_is_omitted(service):
    result = await service.search(SearchQuery(q="anything", limit=200))
    bunny = _by_hash(result, BUNNY)
    assert bunny.first_seen == "2023-11-14T22:13:20Z"
    ubuntu = next(t for t in result.torrents if "Ubuntu" in (t.name or ""))
    assert ubuntu.first_seen is None


async def test_torrent_url_rows_are_resolved_and_enriched(service):
    result = await service.search(SearchQuery(q="anything", limit=200))
    row = _by_hash(result, TORRENT_INFOHASH)
    assert row is not None
    # The .torrent was fetched, bdecoded and hashed; TSP calls the URL itself
    # "decisive for thin swarms", so it is kept alongside the magnet.
    assert row.torrent_url.endswith("/files/sample.torrent")
    assert row.size_bytes == 123456  # the line said -1; the file knew better
    assert row.files == 1


async def test_unresolvable_rows_are_dropped_not_emitted_without_a_magnet(service):
    result = await service.search(SearchQuery(q="anything", limit=200))
    names = [t.name for t in result.torrents]
    assert not any("Unresolvable" in name for name in names)
    assert not any("Lazy Broken" in name for name in names)
    assert any("Lazy Resolve" in name for name in names)


async def test_sort_by_seeders_is_the_default(service):
    result = await service.search(SearchQuery(q="anything", limit=200))
    seeders = [t.seeders or 0 for t in result.torrents]
    assert seeders == sorted(seeders, reverse=True)


async def test_sort_by_size(service):
    result = await service.search(SearchQuery(q="anything", sort="size", limit=200))
    sizes = [t.size_bytes or 0 for t in result.torrents]
    assert sizes == sorted(sizes, reverse=True)


async def test_sort_by_recent_puts_undated_rows_last(service):
    result = await service.search(SearchQuery(q="anything", sort="recent", limit=200))
    dates = [t.first_seen or "" for t in result.torrents]
    assert dates == sorted(dates, reverse=True)
    assert dates[-1] == ""


async def test_paging_is_stable_across_offsets(service):
    everything = await service.search(SearchQuery(q="anything", limit=200))
    first = await service.search(SearchQuery(q="anything", limit=3, offset=0))
    second = await service.search(SearchQuery(q="anything", limit=3, offset=3))

    assert [t.infohash for t in first.torrents] == [t.infohash for t in everything.torrents[:3]]
    assert [t.infohash for t in second.torrents] == [t.infohash for t in everything.torrents[3:6]]
    assert not {t.infohash for t in first.torrents} & {t.infohash for t in second.torrents}


async def test_offset_past_the_end_is_an_empty_array_not_an_error(service):
    result = await service.search(SearchQuery(q="anything", offset=10_000))
    assert result.torrents == []
    assert result.count > 0


@pytest.fixture
async def gated(settings_factory, fixture_registry, torrent_origin, monkeypatch):
    """The same rig with the query gate at its shipped default."""
    gating = settings_factory(query_match="terms")
    report = await Provisioner(gating, fixture_registry).provision()
    created = SearchService(gating, report)
    try:
        yield created
    finally:
        await created.aclose()


async def test_a_row_that_answers_none_of_the_query_is_not_a_result(gated):
    # The fixture engines answer whatever they are asked, which is exactly what
    # several real indexes do: a site that cannot match `q` returns its newest
    # uploads rather than nothing, and the fan-out cannot tell the difference.
    # TSP's 200 is "matching rows", so the match is enforced here.
    result = await gated.search(SearchQuery(q="micheal jackson", limit=200))
    assert result.torrents == []
    assert result.count == 0, "count must describe the rows, not the fan-out"


async def test_the_gate_narrows_rather_than_empties(gated):
    result = await gated.search(SearchQuery(q="big buck bunny", limit=200))
    assert result.torrents
    assert all("bunny" in (t.name or "").lower() for t in result.torrents)
    assert _by_hash(result, BUNNY) is not None


async def test_a_word_the_release_name_dropped_is_not_grounds_to_drop_the_row(gated):
    # `Big Buck Bunny 2008` carries no "the". Wanting every term without this
    # would delete the row that was asked for.
    result = await gated.search(SearchQuery(q="the big buck bunny", limit=200))
    assert _by_hash(result, BUNNY) is not None


async def test_one_keystroke_is_forgiven_and_never_where_it_is_the_meaning():
    # The gate cannot be stricter than the engines it polices: an index that
    # answered `micheal jackson` with the real thing would have that answer
    # deleted here, which is this filter hiding a correct row.
    forgiven = [
        ("micheal jackson", "Michael Jackson - Thriller (1982) [24bit FLAC]"),
        ("thriler", "Michael Jackson Thriller 1982 FLAC"),
        ("sintell", "Sintel 2010 1080p"),
    ]
    for query, name in forgiven:
        assert matches_terms(name, query_terms(query)), f"{query} should find {name}"

    # A digit means a technical token, where the character is the whole meaning.
    refused = [
        ("sintel 2010", "Sintel 2011 Remaster"),
        ("sintel x264", "Sintel.2010.x265.HDR"),
        ("show s01e01", "Some Show S01E02 720p"),
        ("sintel 1080p", "Sintel 1081p"),
        ("bunny", "Buggy Software 2020"),
        ("micheal jackson", "Miraculous Tales of Ladybug and Cat Noir S06E18"),
    ]
    for query, name in refused:
        assert not matches_terms(name, query_terms(query)), f"{query} must not find {name}"


async def test_browsing_is_not_held_to_the_term_that_stood_in_for_the_query(
    settings_factory, fixture_registry, torrent_origin
):
    # An empty `q` means "browse the whole index". The generic query is this
    # server's invention, so filtering a browse against a word the client never
    # typed would hide rows rather than narrow them.
    browsing = settings_factory(query_match="terms", browse_queries=("2160p",))
    report = await Provisioner(browsing, fixture_registry).provision()
    service = SearchService(browsing, report)
    try:
        result = await service.search(SearchQuery(q="", limit=200))
        assert any("2160p" not in (t.name or "") for t in result.torrents)
    finally:
        await service.aclose()


async def test_the_gate_can_be_turned_off(service):
    # The rig runs with it off, which is the escape hatch working: in front of
    # an index doing its own fuzzy or synonym matching, a literal gate here
    # would delete the answers it found.
    result = await service.search(SearchQuery(q="micheal jackson", limit=200))
    assert result.torrents


async def test_min_seeders_filters_after_the_merge(service):
    result = await service.search(SearchQuery(q="anything", min_seeders=500, limit=200))
    assert result.torrents
    assert all((t.seeders or 0) >= 500 for t in result.torrents)


async def test_year_and_resolution_filters(service):
    result = await service.search(SearchQuery(q="anything", year="2008", limit=200))
    assert [t.year for t in result.torrents] == ["2008"]

    result = await service.search(SearchQuery(q="anything", res="2160p", limit=200))
    assert result.torrents
    assert all(t.resolution == "2160p" for t in result.torrents)


async def test_category_filter_uses_the_name_when_all_was_requested(service):
    result = await service.search(SearchQuery(q="anything", cat="software", limit=200))
    assert [t.name for t in result.torrents] == ["Ubuntu 24.04 LTS Desktop amd64 iso"]
    assert all(t.category == "software" for t in result.torrents)


async def test_category_filter_trusts_a_precisely_requested_category(service):
    # fixnoisy declares `music`, so every row it returns is audio by construction.
    result = await service.search(SearchQuery(q="anything", cat="audio", limit=200))
    assert any("Pink Floyd" in (t.name or "") for t in result.torrents)


async def test_a_category_filter_never_hides_a_row_nothing_contradicts():
    """A filter narrows a result set; it does not delete correct answers.

    `classify_name` only reads technical markers, so a bare title comes back
    as "no idea" — and "no idea" used to be treated as "no", which made a
    search for video hide rows the unfiltered search had just shown.
    """

    def candidate(name: str, category: str | None) -> Candidate:
        return Candidate(
            name=name, engine_id="e", link="magnet:?xt=urn:btih:" + "a" * 40,
            link_kind="magnet", category=category,
        )

    unreadable = candidate("Big Buck Bunny", classify_name("Big Buck Bunny"))
    assert unreadable.category is None, "the premise: this name reads as nothing"
    rows = [
        candidate("Sintel 2010 1080p BluRay", "video"),
        candidate("VA - Hits FLAC", "audio"),
        unreadable,
    ]

    for category in TSP_CATEGORIES:
        kept = apply_filters(rows, category=category)
        assert unreadable in kept, f"{category} hid a row it could not read"
        # ...and nothing it could read and disagreed with came through.
        assert {c.category for c in kept} <= {category, None}

    # Keeping the unknown is not keeping everything.
    assert [c.name for c in apply_filters(rows, category="audio")] == [
        "VA - Hits FLAC",
        "Big Buck Bunny",
    ]


async def test_failing_engines_do_not_sink_the_response(service):
    result = await service.search(SearchQuery(q="anything", limit=200))
    assert "fixbroken" not in (result.engines or [])
    assert "fixmagnet" in (result.engines or [])
    assert result.torrents


async def test_the_circuit_opens_after_repeated_failures(service, settings):
    for _ in range(settings.breaker_failures):
        await service.search(SearchQuery(q=f"q{_}"))
    assert not service.breaker.available("fixbroken")
    assert service.breaker.state("fixbroken").consecutive_failures >= settings.breaker_failures
    # An open engine is not even planned for the next request.
    assert "fixbroken" not in [plan.plugin.id for plan in service.plan("")]


async def test_a_slow_engine_does_not_delay_the_others(settings_factory, torrent_origin, monkeypatch):
    settings = settings_factory(engine_timeout_s=1.0, request_deadline_s=3.0)
    report = await Provisioner(settings, make_registry(enable=("fixslow",))).provision()
    service = SearchService(settings, report)
    try:
        result = await service.search(SearchQuery(q="anything", limit=200))
    finally:
        await service.aclose()

    # `fixslow` sleeps for ten minutes; the response must not wait for it.
    assert result.took_ms < 3500
    assert result.torrents
    assert "fixslow" not in (result.engines or [])


async def test_early_exit_does_not_wait_for_a_slow_engine(settings_factory):
    # Three fast engines and one that sleeps for ten minutes. The response must
    # come back at the speed of the fast ones, not the global deadline.
    settings = settings_factory(
        engine_timeout_s=30.0, request_deadline_s=30.0,
        early_exit_engines=2, early_exit_rows_factor=1,
    )
    report = await Provisioner(settings, make_registry(enable=("fixslow",))).provision()
    service = SearchService(settings, report)
    try:
        result = await service.search(SearchQuery(q="anything", limit=2))
    finally:
        await service.aclose()

    assert result.torrents
    assert result.took_ms < 10_000  # the deadline alone would have allowed 30s
    assert result.partial is True  # not every engine got to speak
    assert "fixslow" not in (result.engines or [])


async def test_early_exit_needs_several_engines_not_just_enough_rows(settings_factory):
    """Merge quality depends on more than one engine seeing the same content."""
    settings = settings_factory(early_exit_engines=4, early_exit_rows_factor=1)
    report = await Provisioner(settings, make_registry()).provision()
    service = SearchService(settings, report)
    try:
        result = await service.search(SearchQuery(q="anything", limit=1))
    finally:
        await service.aclose()

    # One engine returns four rows immediately, which alone clears the row bar.
    assert len(result.engines or []) >= 4


async def test_early_exit_needs_rows_not_just_answers(settings_factory, fixture_registry):
    """Engines that answer with nothing must not end the fan-out.

    Both halves of the rule are load-bearing. If three engines reply and find
    nothing, the row bar is unmet and the search keeps expanding to the rest —
    which is the case that matters, because an obscure query is exactly when
    you want every engine to get a turn.
    """
    settings = settings_factory(early_exit_engines=3, early_exit_rows_factor=3)
    report = await Provisioner(settings, fixture_registry).provision()
    service = SearchService(settings, report)
    try:
        assert service._seen_enough(answered=3, rows=0, needed=10) is False
        assert service._seen_enough(answered=3, rows=29, needed=10) is False
        assert service._seen_enough(answered=3, rows=30, needed=10) is True
        # ...and enough rows from too few engines is not enough either, because
        # swarm counts are max()-ed across engines.
        assert service._seen_enough(answered=2, rows=999, needed=10) is False
    finally:
        await service.aclose()


async def test_early_exit_is_off_by_default(settings, fixture_registry):
    # Stable paging is a TSP guarantee; early exit trades it away, so it has to
    # be asked for. `test_paging_is_stable_across_offsets` is what it would break.
    assert settings.early_exit_engines == 0

    report = await Provisioner(settings, fixture_registry).provision()
    service = SearchService(settings, report)
    try:
        result = await service.search(SearchQuery(q="anything", limit=1))
    finally:
        await service.aclose()

    assert result.partial is None  # every healthy engine got to speak
    assert "fixmagnet" in (result.engines or [])


async def test_max_plugins_provisions_only_the_best(settings_factory):
    """Boot cost is per plugin: a fetch, a scan and a byte-compile each."""
    registry = make_registry()
    for plugin in registry.plugins:
        plugin.health.score = {"fixmagnet": 0.9, "fixoverlap": 0.8}.get(plugin.id, 0.1)

    report = await Provisioner(settings_factory(max_plugins=2), registry).provision()
    assert sorted(slot.plugin.id for slot in report.slots.values()) == ["fixmagnet", "fixoverlap"]


async def test_probe_measured_latency_feeds_engine_ranking():
    quick = Plugin(id="quick", url="u", health=Health(score=0.9, median_ms=300))
    slow = Plugin(id="slow", url="u", health=Health(score=0.9, median_ms=5000))
    assert quick.base_score() > slow.base_score()


async def test_empty_query_browses_rather_than_erroring(service):
    result = await service.search(SearchQuery(q="", limit=5))
    assert result.query == ""
    assert result.torrents  # the fixture engines answer any query


async def test_browsing_a_category_asks_for_words_that_category_uses(service):
    """Every category used to browse for a video word, which found nothing.

    Plugins are asked for the nova3 category too, so `cat=audio` asked each
    one for the music torrents that mention 1080p — and whatever came back had
    to get past `classify_name` as well.
    """
    for category, terms in BROWSE_TERMS.items():
        seen = {service._browse_term(category) for _ in range(len(terms) * 2)}
        assert seen == set(terms), f"{category} browsed for {seen}"
        for term in terms:
            assert classify_name(f"Some Release {term}") == category, (
                f"browsing {category} for {term!r} returns rows the filter then drops"
            )


async def test_an_uncategorised_browse_is_the_one_the_operator_can_set(
    settings_factory, fixture_registry
):
    settings = settings_factory(browse_queries=("ubuntu",))
    report = await Provisioner(settings, fixture_registry).provision()
    service = SearchService(settings, report)
    try:
        assert service._browse_term("") == "ubuntu"
        # ...and it does not leak into a categorised browse, which would undo the fix.
        assert service._browse_term("audio") in BROWSE_TERMS["audio"]
    finally:
        await service.aclose()


async def test_empty_query_can_be_configured_to_return_nothing(settings_factory, fixture_registry):
    settings = settings_factory(empty_query_mode="empty")
    report = await Provisioner(settings, fixture_registry).provision()
    service = SearchService(settings, report)
    try:
        result = await service.search(SearchQuery(q=""))
    finally:
        await service.aclose()
    assert result.torrents == [] and result.count == 0


async def test_cached_rows_skip_the_subprocess(settings_factory, fixture_registry):
    settings = settings_factory(cache_ttl_s=300.0)
    report = await Provisioner(settings, fixture_registry).provision()
    service = SearchService(settings, report)
    try:
        first = await service.search(SearchQuery(q="cache me", limit=200))
        second = await service.search(SearchQuery(q="cache me", limit=200))
    finally:
        await service.aclose()

    assert [t.infohash for t in first.torrents] == [t.infohash for t in second.torrents]
    assert second.took_ms <= first.took_ms


async def test_engines_are_capped_per_request(settings_factory, fixture_registry):
    settings = settings_factory(max_engines_per_request=2)
    report = await Provisioner(settings, fixture_registry).provision()
    service = SearchService(settings, report)
    try:
        assert len(service.plan("")) == 2
        # Magnet engines score highest: one round trip instead of two.
        assert all(plan.plugin.link_kind == "magnet" for plan in service.plan(""))
    finally:
        await service.aclose()
