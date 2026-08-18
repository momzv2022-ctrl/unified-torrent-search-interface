# The API, and how nova3 output becomes it

[← back to the README](../README.md)

## The API

`GET /api/v1/search`, exactly as [TSP][tsp] specifies it.

| Parameter | Notes |
|---|---|
| `q` | Search terms. `.`, `_` and `-` are separators; word order is irrelevant. |
| `cat` | `video`, `audio`, `software`, `archive`, `document`, `image`, or empty. |
| `year` | Four digits, parsed from the release name. |
| `res` | `2160p`, `1080p`, `720p`, `480p`. |
| `min_seeders` | Applied after merging, so it sees the best count any engine reported. |
| `sort` | `seeders`, `size`, `recent`. Empty means server default (seeders). |
| `limit` | Clamped to 1–200 server-side. |
| `offset` | Clamped to ≥ 0. Past the end returns `200` with an empty array. |

Authentication is `X-API-Key` on every request. A missing key is `401`, a wrong
one is `403`, never an empty result set. Over the rate limit is `429` with
`Retry-After`; TSP clients back off and retry.

```sh
curl -H "X-API-Key: $KEY" \
  'http://localhost:7860/api/v1/search?q=big+buck+bunny&cat=video&sort=seeders&limit=10'
```

Two non-TSP additions, both ignored by TSP clients: each row carries `sources`
(the engines it was merged from) and `description_url`, and the envelope carries
`engines` and `partial`. `sources` in particular makes a surprising row easy to
trace back.

`GET /api/v1/engines` reports the live roster: which plugins provisioned, which
circuits are open, and why. `GET /healthz` needs no key.

**`/api/v1/stats` is deliberately absent.** TSP says absence is fine and clients
then offer every filter chip. A meta-search has no catalogue to count, so
reporting zeroes would be less honest than saying nothing.

### Empty `q`

Legal in TSP, where it means "browse the whole index", but there is no index to
browse. Two behaviours, and it is never a `400`:

- `UTSI_EMPTY_QUERY_MODE=browse` (default) answers with a rotating generic query
  (`2160p`, `1080p`, `x265`), so a client that opens on an empty search sees
  something.
- `UTSI_EMPTY_QUERY_MODE=empty` answers `200` with no rows.

## How it handles nova3

### The output format

One line per result on stdout:

```
link|name|size_bytes|seeds|leech|engine_url|desc_link|pub_date
```

`size` is **already an integer byte count**. `prettyPrinter` runs
`anySizeToBytes()` before printing, so it is never re-parsed here. `-1` means
unknown for any numeric field and becomes an omitted TSP field rather than a
zero. Lines are split from the right, so a stray `|` inside a URL cannot slide
the numeric fields along by one.

### The three shapes of `link`

TSP requires a `magnet` on every row, but plugins return three different things:

1. **A magnet URI** (`piratebay`, `torrentscsv`, `eztv`, `solidtorrents`). Used
   directly; base32 infohashes are normalised to lowercase hex.
2. **A `.torrent` URL** (`torlock`). Kept as `torrent_url`, which TSP calls
   "decisive for thin swarms", *and* fetched, bdecoded, and hashed to
   `sha1(bencode(info))` to synthesise the magnet. The file also fills in
   `size_bytes` and `files` when the result line said `-1`.
3. **An opaque token** needing a second round trip (`limetorrents`,
   `torrentproject`). Resolved through the plugin's own `download_torrent()`.

Shape 3 costs an extra HTTP round trip *per row*, so it is resolved **lazily**:
only rows that could reach the client's page are resolved, bounded by
`UTSI_MAX_RESOLVE`. Engines that return magnets score higher and get picked
first. Rows that never resolve are dropped, because an incomplete row would violate TSP.

### Categories

TSP has six categories, nova3 has nine, and neither is a subset of the other.
A plugin only accepts a category it declares, and `nova2.py` silently drops an
engine handed anything else, so the request is planned per engine:

- exactly one nova3 category inside the TSP one → ask for it, and every row is
  known to belong;
- several, or none → ask for `all`.

nova3 result lines carry **no category field**, so when `all` was requested the
category is inferred from the release name. `year`, `resolution`, `codec`,
`source`, `season` and `episode` come from the name too. No plugin supplies them.

Inference only works on names that carry a marker — a resolution, a codec, a
format. A bare title like `Sintel 2010` yields nothing, and **a row whose
category cannot be read is kept under every `cat`**, not dropped: a filter that
deleted it would be hiding a correct answer rather than narrowing the list. Only
a category that is known and different is grounds to drop. Rows we are sure of
carry `category` in the response; rows we are not, omit it.

### Paging and sorting

Plugins do not page and do not sort reliably; the base class only *recommends*
seed-descending. Ordering and paging are done here over the merged set, with a
total tie-break so `offset=0` then `offset=50` is a stable sequence. Engine
output is cached per `(engine, category, query)`, which both halves the load on
the sites and is what makes that stability possible.

### Making it faster

A fan-out is only as fast as its slowest member, so latency work is mostly
about deciding who to wait for. In rough order of effect:

| Lever | Cost |
|---|---|
| `utsi probe` then `--merge-health` | none, measured latency feeds engine ranking |
| `UTSI_ENGINE_TIMEOUT_S=3` (from 6) | drops genuinely slow-but-working engines |
| `UTSI_MAX_ENGINES_PER_REQUEST=6` (from 12) | narrower coverage, fewer chances to hit a slow site |
| `UTSI_CACHE_TTL_S=900` (from 300) | staler swarm counts |
| `UTSI_ENGINES=torrentscsv,piratebay,…` | only the engines you name |
| `UTSI_EARLY_EXIT_ENGINES=3` | **breaks stable paging**, see below |

The health merge is the one with no downside, and it needs a real run to work
from: a registry that has seen `utsi probe` ranks fast engines above slow ones
and drops the ones that never answer.

**Early exit** stops the fan-out once *N* engines have answered **and** those
answers add up to three pages' worth of rows, instead of waiting for all twelve.
One 6s site otherwise turns a 400ms response into a 6s one.

Both halves of that rule matter. Three engines that reply with nothing do not
end the search. The row bar is unmet, so it keeps expanding to the rest of the
list. An obscure query, where you actually want every engine to get a turn,
behaves exactly as it does today.

It is off by default because it trades away a TSP guarantee: two requests for
the same query can stop on different engine subsets, so `offset=0` followed by
`offset=50` is no longer a coherent sequence. If your client shows one page and
never pages, you lose nothing:

```sh
UTSI_EARLY_EXIT_ENGINES=3 utsi serve
```

Responses cut short this way carry `"partial": true`.

### Merging

Rows are keyed by lowercase hex infohash. When the same infohash arrives from
several engines the longest name wins (the most descriptive release string),
swarm counts take `max()` because a stale engine under-reports, and every
contributing engine is recorded in `sources`.
