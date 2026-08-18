# The Cloudflare Worker

The same search API as `./start.sh`, at a fixed address that is always up, on a
machine you neither own nor pay for. One JavaScript file, no dependencies, no
build step, pasted into a free Cloudflare account.

The setup page is at
**<https://momzv2022-ctrl.github.io/unified-torrent-search-interface/>**. It mints a
key in your browser and hands you a link that opens Cloudflare's playground with
the program already loaded — press Deploy and name it. The steps are in the
[README](../README.md); how that link works, and what about it is still
unverified, is in [docs/deploy-link.md](deploy-link.md). This document is the
reasoning, the settings, and the trade-offs.

---

## What you give up, and how to get it back

The local server searches around a hundred sites by running qBittorrent's own
search plugins. This Worker cannot run those plugins at all.

That is the runtime, not laziness. A Worker has no subprocesses, no process
groups and no resource limits — so the box each plugin runs inside on your own
machine, the one that makes it acceptable to run a hundred strangers' scripts,
cannot be built here. Running them anyway would mean loading unaudited code into
the same isolate that holds your API key. So the engines here are short adapters,
written in this repository, that talk to indexes with a real JSON or XML API.
**No third-party code runs in this Worker.**

The way to get the hundred back is not to smuggle plugins in. It is to
[point the Worker at a machine that already runs them](#your-own-index) — a
`./start.sh` instance of this project, at your address, where the sandbox exists
and the sites will actually answer. The Worker in front of it is then a fixed URL
that stays up when that machine does not.

| | Local server | This Worker |
|---|---|---|
| Engines | ~100 qBittorrent plugins | your own index first, plus API-backed indexes |
| Third-party code | fetched, pinned, sandboxed per plugin | none |
| Runs when your machine is off | no | yes |
| Public URL | a tunnel, new each start | fixed, `*.workers.dev` |
| Cost | your electricity | free |
| Browser page at `/` | yes | no, by design |

Everything else is identical: the same `/api/v1/search`, the same JSON, the same
key in the same header, the same release-name parsing. A client cannot tell the
two apart — and that is checked, not asserted. See
[parity](#how-we-know-it-is-the-same-api).

---

## Routes

| Route | Key needed | What it is |
|---|---|---|
| `/api/v1/search` | yes | TSP search. The whole product. |
| `/api/v1/engines` | yes | Which engines exist and which are switched on. |
| `/api/v1/engines?probe=1` | yes | Runs every engine once and reports what answered **from your Worker**. |
| `/healthz` | no | Liveness, version, per-engine state, update check. |
| `/` | no | Three lines of plain text, so a browser says something useful. `UTSI_BANNER=0` turns it off. |

`Authorization: Bearer YOUR-KEY` works as well as `X-API-Key`. The key never goes
in the query string: it would end up in Cloudflare's request logs and in the
referrer of anything the client links onward.

Three non-TSP fields ride along on a search response, and clients ignore all of
them: `engines` lists what answered, `engine_errors` says why anything did not,
and `browse_query` names the generic term an empty `q` was answered with.

### Reading `/healthz`

This is the endpoint to open when something is wrong, and it is written to be
useful rather than reassuring.

```json
{
  "status": "degraded",
  "api_key": "ok",
  "coverage": "narrow",
  "version": "0.3.0",
  "runtime": "cloudflare-worker",
  "engines_ready": 4,
  "engines": ["knaben", "torrentscsv", "yts", "nyaa"],
  "anonymous": false,
  "engine_status": {
    "knaben": { "origin": "https://api.knaben.org", "origin_from": "built-in",
                "last": "rate_limited", "rows": 0, "ms": 118, "seconds_ago": 31,
                "error": "rate limited (HTTP 429)" },
    "torrentscsv": { "origin": "https://torrents-csv.com", "origin_from": "built-in",
                "last": "error", "rows": 0, "ms": 412, "seconds_ago": 31,
                "error": "HTTP 403" },
    "yts":    { "origin": "https://yts.bz", "origin_from": "UTSI_ENGINE_URLS",
                "last": "ok", "rows": 40, "ms": 380, "seconds_ago": 31 }
  },
  "update": { "latest": "0.4.0", "available": true }
}
```

- **`status`** is `ok`, `degraded` or `not_configured`. `degraded` means one of
  two things: every engine this Worker has tried came back broken, or — the case
  above — the broad engines are all down and only a single-subject one is left,
  so films still work and nothing else does. The old Python Worker reported `ok`
  whenever *anything* answered, which in a paste-and-deploy world, where nobody
  is watching a build log, is the difference between noticing and concluding the
  project is bad.
- **`coverage`** is `broad`, `narrow`, `none` or `unknown`, and it is the field
  that says which of those two degraded cases you are in. `unknown` means this
  isolate has not run a search yet. A deployment that is narrow *because you set
  it that way* — `UTSI_ENGINES=yts,nyaa` — reports `narrow` and stays `ok`; it is
  doing what you asked.
- **`last: "rate_limited"`** is separated from `"error"` on purpose, because the
  two need opposite repairs. A site that is down is fixed by waiting, or by
  pointing the engine at another address with `UTSI_ENGINE_URLS`. A site that is
  throttling you is fixed by asking it less — changing address will not help, and
  `knaben` in particular has published a temporary one-request-per-two-seconds
  limit under load. If you see this often, put an index of your own in front:
  `UTSI_UPSTREAM_URL` or `UTSI_TORZNAB_URL`.
- **`engine_status`** is what happened *the last time this isolate asked*. A
  Worker has no durable state and isolates come and go around requests, so
  `"last": "unused"` just means this one has not run a search yet. Run one, then
  look again.
- **`origin_from`** says whether the address came from the list baked into the
  file or from your `UTSI_ENGINE_URLS`.
- **`update`** compares this file's version against the one the project
  publishes. It is fetched on `/healthz` only, never on the search path, cached
  for an hour, and its failing is silent. `UTSI_UPDATE_CHECK=0` switches it off —
  it is the one request this Worker makes that is not on your behalf.

Nothing here reaches the network on your behalf except that update check, which
means an unauthenticated `/healthz` cannot be turned into an amplifier. For a
live answer, `?probe=1` on `/api/v1/engines` — which needs the key.

---

## Settings

Set them in the dashboard under **Workers & Pages → your Worker → Settings →
Variables and Secrets**. They are read on every request, so nothing needs a
redeploy.

Two of them belong in the **Secrets** half of that page rather than the variables
half: `UTSI_UPSTREAM_URL` and `UTSI_UPSTREAM_APIKEY`. The URL is a secret for the
same reason the key is — it is the address of a private server.

| Setting | Default | What it does |
|---|---|---|
| `UTSI_API_KEY` | — | The key. Overrides the `API_KEY` line in the file, which is how you rotate without re-pasting. Nothing serves without one of the two. |
| `UTSI_ALLOW_ANONYMOUS` | `0` | Serve with no key at all. On a public URL this is an open scraper proxy, and open scraper proxies get found. |
| `UTSI_ENGINES` | `upstream,knaben,torrentscsv,yts,nyaa` | Which engines to fan out to, **in priority order**. |
| `UTSI_ENGINE_URLS` | — | `id=origin` pairs, pointing an engine somewhere else when its domain moves. Replaces that engine's whole address list. |
| `UTSI_UPSTREAM_URL` | — | Your own TSP index. Setting it makes `upstream` the primary engine. |
| `UTSI_UPSTREAM_APIKEY` | — | Its key, sent as `X-API-Key`. |
| `UTSI_MAX_ROWS_PER_ENGINE` | `100` | Rows kept per engine before merging. The main CPU lever — [see below](#why-it-is-shaped-the-way-it-is). Unfiltered searches with a small `limit` are budgeted below it automatically. |
| `UTSI_EMPTY_QUERY_MODE` | `browse` | What an empty `q` means: `browse` searches a generic term, `empty` returns no rows. Never a 400. |
| `UTSI_BROWSE_QUERIES` | `2160p,1080p,x265` | What an uncategorised `browse` searches for, rotating hourly. With a `cat`, that category's own words are used instead. |
| `UTSI_FALLBACK` | `1` | Ask one more index when everything else found nothing — if `UTSI_FALLBACK_URL` is set. |
| `UTSI_FALLBACK_URL` | — | Where that goes: an index of your own. Unset — the default — the fallback never runs. |
| `UTSI_FALLBACK_APIKEY` | — | Its key, if it needs one. |
| `UTSI_TORZNAB_URL` | — | A Jackett, Prowlarr or NZBHydra instead of, or as well as, an upstream. |
| `UTSI_TORZNAB_APIKEY` | — | Its API key. |
| `UTSI_MAX_RESOLVE` | `0` | `.torrent` files to fetch per request to recover a missing infohash. Only Torznab needs it. |
| `UTSI_CORS_ORIGINS` | — | Named origins allowed to call this from a web page. No wildcard, deliberately: one would let any page spend your instance. |
| `UTSI_BANNER` | `1` | The plain-text page at `/`. |
| `UTSI_UPDATE_CHECK` | `1` | Whether `/healthz` asks the project whether a newer version exists. |
| `UTSI_ENGINE_TIMEOUT_S` | `8` | Per-engine wall clock. |
| `UTSI_UPSTREAM_TIMEOUT_S` | `15` | Longer, because your own index runs its own fan-out behind its own deadline. |
| `UTSI_REQUEST_DEADLINE_S` | `20` | Whole-request wall clock. Whatever finished by then is what you get. |

---

## The engines

| id | What it is | Breadth | Default |
|---|---|---|---|
| `upstream` | Your own TSP index — a `./start.sh` instance of this project | broad | **on**, as soon as its URL is set |
| `knaben` | A meta-index over dozens of trackers behind one JSON API | broad | on |
| `piratebay` | One large site's own JSON API, and the quickest engine here | broad | on |
| `torrentscsv` | A DHT crawl rather than a curated site, so it misses different things | broad | on |
| `animetosho` | Anime, aggregated over Nyaa and Tokyo Toshokan, in JSON | narrow | on |
| `eztvx` | Television episodes, from the site's own JSON API | narrow | on |
| `yts` | Films only, but clean releases and accurate metadata | narrow | on |
| `nyaa` | East Asian media, by RSS — [see below](#engines-that-are-shipped-off) | narrow | **off** |
| `torznab` | Your own Jackett, Prowlarr or NZBHydra | broad | off until its URL is set |
| `fallback` | An index of your own, asked **only** when every engine above found nothing | broad | off until its URL is set |

**Breadth is not a ranking, and it is not depth.** It is which questions an
engine can answer at all. A broad engine has an opinion about anything you ask
it; `yts` knows about films and `nyaa` knows about East Asian media, and no
number of them adds up to a general index. It matters because of what a stock
deployment looks like when things go wrong: `upstream` is off until you set a
URL, so if the broad engines are down, searches for a film still work while
searches for a book, a disk image or a game return nothing. `/healthz` reports
that as `"coverage": "narrow"` and `"status": "degraded"` rather than pretending
it is fine, which it did until recently.

Depth is a separate and less flattering question, and `torrentscsv` is the
example. It is genuinely broad — it has no categories and will answer about
anything — but it is a thin index in practice: measured from a home connection,
a search for *Big Buck Bunny*, one of the most-seeded torrents in existence,
came back with **one row**. Its data was seeded from a 2017 dump and its
tooling has not been published in years. Count it as insurance, not as a second
opinion, and do not let its presence in the `broad` column persuade you that a
stock deployment has two working general indexes. Realistically it has one, and
that is the whole argument for [owning the index outright](#owning-the-index-outright).

The sites the hundred plugins scrape mostly refuse data-centre addresses, and
this Worker cannot run those plugins anyway — but `knaben` has already indexed
most of those sites and answers with JSON, which is how a stock deploy covers
dozens of trackers in one subrequest.

`torrentscsv` and `nyaa` are also covered by plugins in `registry.json`, so an
upstream instance already searches those sources from a better address and the
merge collapses whatever overlaps. They are on by default anyway, because the
deployment with no upstream is the one that needs them.

**Order is the setting.** The fan-out is parallel, but the merge consumes engines
in the order `UTSI_ENGINES` lists them, and the first engine to report a given
release supplies the fields that reach the client — its release name, its
category, its description link. Later engines fill gaps and raise the swarm
counts (those are `max`-ed, never overwritten). Put the index you trust first;
that is deterministic regardless of which site answers quickest.

### Engines that are shipped off

`bt4g` used to be here, as the second broad engine — a DHT crawler read by RSS,
chosen because it was **not reading the same sources** as knaben, which is a
meta-index over other websites and inherits their outages. Two broad engines that
fail for the same reason are one broad engine, and that argument was right.

It was removed anyway, on measurement. Four probes of a deployed Worker, run
hours apart, and `bt4g` answered **HTTP 403 to every one of them** — fast, in
20-40ms, which is a refusal rather than an outage. Its RSS path was the only door
that had ever been open and it is now shut to Cloudflare's addresses. An adapter
that has never once answered from the network this actually runs on is not
insurance; it is a subrequest spent on nothing, and in this project it was also
1.5 KB of a deploy link that has a hard ceiling.

`nyaa` is still here but no longer on by default, for the same kind of reason:
**HTTP 429 on all four probes**. It is rate limiting Cloudflare's address space,
not refusing it, so it may well work from yours — `UTSI_ENGINES` turns it back on.
`animetosho` covers much of the same ground from a host that is not throttling,
which is why it took the default slot.

The general rule this leaves: **being refused is per-network.** These measurements
are from one Worker on one account. Run `/api/v1/engines?probe=1` from yours
before trusting any of it, and set `UTSI_ENGINES` from what you see rather than
from this page.

## Your own index

This is the setting that matters. Point the Worker at a machine already running
this project and you get the hundred plugins back, searched from an address the
sites will answer, with the per-plugin sandbox intact — while the Worker stays
the fixed, always-up URL in front of it.

Add `UTSI_UPSTREAM_URL` and `UTSI_UPSTREAM_APIKEY` in the dashboard as
**secrets**. The Worker picks them up on the next request.

**Nothing ships pointing at anyone's index, including the author's.** A default
here would route every deployment's searches through one machine — whoever ran it
would be operating a public torrent-search endpoint on their own account,
carrying everyone's traffic against one free-tier quota, and every copy would
break the day it went down. What you deploy is yours and points nowhere else.

Give the **origin only** — `https://your-box.example.com`, no `/api/v1/search`,
no trailing slash. A pasted API URL is trimmed back for you, because it is the
one that was in front of you when you went looking. The Worker forwards `q`,
`cat`, `year`, `res` and `min_seeders`, so your index filters before its rows
count against `UTSI_MAX_ROWS_PER_ENGINE`; and because it runs the same name
parser, its `year`/`resolution`/`codec`/`source`/`season`/`episode` are reused
rather than recomputed, which is the most expensive step in the pipeline.

Four things to know:

- **It must be reachable from Cloudflare's network.** A `192.168.x.x` address
  will not work. A `trycloudflare.com` tunnel does, but its hostname changes
  every time `./start.sh` runs, so a stable hostname is worth setting up.
- **HTTPS, with a certificate a browser would accept.** Workers verify TLS and
  there is no way to turn that off. If `curl` needs `-k`, this will not work.
- **When it is down, the Worker still answers** from whatever else is configured,
  and says so: `engine_errors: {"upstream": "HTTP 502"}` rather than quietly
  returning less.
- **401 and 403 from it are told apart.** 401 means no key arrived, 403 means one
  arrived and did not match, and the error text says which and what to check.

### A Jackett instead

If what you run is a Jackett, Prowlarr or NZBHydra, use `torznab`: set
`UTSI_ENGINES` to include it, point `UTSI_TORZNAB_URL` at
`https://jackett.example.com/api/v2.0/indexers/all/results/torznab/api`, and set
`UTSI_TORZNAB_APIKEY`. Indexers that hand back a `.torrent` file rather than a
magnet need `UTSI_MAX_RESOLVE` above zero, or those rows are dropped — TSP
requires a magnet on every row and there is nowhere else to get one.

**That address has to be one the public internet can reach**, and this is the
trap, because the obvious thing to type is the address you use at home:

- `http://192.168.1.5:9117/...`, `http://10.0.0.4/...` or anything on
  `localhost` **cannot work**. A Worker refuses to fetch a private address and
  Cloudflare answers error 1003. It is not a bug you can configure around; the
  Worker runs in Cloudflare's network, not yours. Put a Cloudflare Tunnel or a
  public reverse proxy in front of your Jackett and use that hostname.
- **Odd ports need saying so.** Jackett's 9117 and Prowlarr's 9696 are not
  standard, and reaching them wants the `allow_custom_ports` compatibility flag.
  If the hostname is proxied through Cloudflare, only Cloudflare's own proxied
  ports resolve at all — 80, 8080, 8880, 2052, 2082, 2086, 2095 and, over TLS,
  443, 2053, 2083, 2087, 2096 and 8443. Anything else needs the DNS record grey,
  not orange.

This is also why `./start.sh` is the smoother of the two paths: it prints a
`trycloudflare.com` address, which is a public hostname on a standard port, and
sidesteps all of the above.

### Owning the index outright

Everything on the engine list above is somebody else's service, and every entry
can be blocked, throttled or retired without warning. The durable answer is to
stop querying other people's indexes and run one, and that is nearer than it
sounds: **bitmagnet** is a self-hosted crawler that watches the BitTorrent DHT
itself, classifies what it finds, and exposes a **Torznab endpoint** — which
means this Worker already speaks to it. Point `UTSI_TORZNAB_URL` at your own
bitmagnet (subject to the reachability rules just above) and nothing on that
table is load-bearing any more — `knaben` included; they become supplements to an
index whose uptime is yours.

It is not free: a DHT crawler wants a machine that stays on, disk, and time to
build up an index worth searching, and bitmagnet's own releases are slow-moving.
But it is the only option here whose availability nobody else controls, and it is
the honest end of the argument that this whole page keeps circling.

### When everything comes back empty

Some searches find nothing anywhere. For that case the Worker can ask one more
index, and only then: an ordinary search is answered by the fan-out and never
reaches it. Nothing ships configured; it stays dark until `UTSI_FALLBACK_URL`
points it at an index of your own.

Two properties make it a last resort rather than an engine: it is asked **only**
when every engine that ran came back with nothing, and it **cannot be put in
`UTSI_ENGINES`** — a last resort promoted into the fan-out stops being one.

---

## Why it is shaped the way it is

A free Worker gets **10 ms of CPU per request**. Not 10 ms of wall clock —
waiting on `fetch()` costs nothing, so the fan-out to five indexes is free no
matter how slow they are. What costs is parsing what comes back.

So the pipeline is ordered against the obvious: build cheap rows, merge, filter,
sort, cut to the page, **then** parse release names and build magnets. Running
the name parser over every row collected to return fifty of them would spend most
of the budget on rows nobody sees. Do not "simplify" that into parsing everything
up front.

The predecessor of this file was Python, running under Pyodide, and a deployed
Worker measured **15.9 ms per request** against that 10 ms ceiling — which is why
its row cap was halved to 50. Nearly all of that was the interpreter. Measured on
this file with the network answering from memory, five engines, a category filter
on (the expensive shape, because it keeps the whole candidate set):

| rows per engine | CPU per request |
|---|---|
| 100 | 4.5 ms |
| 50 | 3.4 ms |

`node worker/tools/bench.mjs 100 300` reproduces it. That is Node's V8 on an
ordinary Linux container rather than Cloudflare's machines, so treat it as the
shape of the cost rather than the bill.

The bill, from the first Worker deployed out of this file, as reported by the
Cloudflare dashboard's own CPU Time metric over its first handful of requests:
**1.65 ms per request**, against the free plan's 10 ms. Comfortably under the
estimate, because Cloudflare's machines are faster than the container the
estimate came from — but read it for what it is, a small number of early
requests rather than a busy day of five-engine searches returning full pages.
Your own number comes from `wrangler tail --format=pretty`, which prints CPU
time per request.

The default cap is back to **100** on the strength of that. If you ever see
`Error 1102 — Worker exceeded resource limits`, that is the CPU limit: lower
`UTSI_MAX_ROWS_PER_ENGINE` or drop an engine. Cloudflare tolerates the occasional
overrun and only terminates a Worker that goes over consistently.

The other free-plan limits are not close to binding: 100,000 requests a day, 50
outbound subrequests per search against the five this makes, 128 MB of memory,
and a 3 MB bundle against the 110 KB this file weighs.

### What is deliberately not here

- **No row cache and no circuit breaker.** Both are per-process state, and a
  Worker has no process you can reason about — isolates appear and vanish per
  request. A breaker would open against an isolate about to be thrown away.
  Cloudflare's Cache API is the right home if it is ever needed, and it is a
  no-op on `workers.dev` anyway.
- **No rate limiting.** Same reason: an in-memory counter counts one isolate. The
  key is the gate. Cloudflare has rate-limiting rules at the edge, which is where
  it belongs.
- **No browser page.** An address and a key are the product.
- **No request logging.** Cloudflare's `observability` is not enabled by this
  file. With it on, every request — including the `?q=` you searched for — is
  written into the Worker's own logs, where it sits for days and is readable from
  the dashboard. The local server keeps no such record and neither does this.
  Cloudflare still sees the traffic; it is the network. What this avoids is the
  second, durable copy.
- **No minification.** People paste this into their own account and some of them
  will read it first. A minified blob is exactly what a careful reader refuses.

---

## How we know it is the same API

`worker/tests/golden/search.json` holds the TSP responses the **Python** Worker
produced across 23 scenarios — every fixture, every engine, every filter, every
sort, both merge orders, engines that fail, and the paging edges. The JavaScript
port matched them byte for byte, and `worker/tests/worker.test.mjs` re-checks it
on every CI run.

The full method, including the two things deliberately normalised before
comparing and the one deliberate difference, is in
[`worker/tests/parity/README.md`](../worker/tests/parity/README.md).

---

## Working on it

```sh
node --test worker/tests/worker.test.mjs   # the whole suite, no network
node worker/tools/build.mjs                # site/ — artifact, hash, page
node worker/tools/check-page.mjs           # the setup page, in a real browser
node worker/tools/bench.mjs 100 300        # CPU per request
node worker/tools/playground-link.mjs worker/src/worker.js   # a deploy link
```

There is no build step for the Worker itself. `site/worker.js` is a byte-for-byte
copy of `worker/src/worker.js`, which is why the SHA-256 the setup page publishes
is the hash of a file you can read on GitHub. To run it locally against
Cloudflare's real runtime:

```sh
npx wrangler@4 dev worker/src/worker.js --var UTSI_API_KEY:$(openssl rand -hex 16)
```

CI publishes the page from `.github/workflows/pages.yml` on every push to `main`.

---

## Two honest warnings

**This has not been deployed from this repository yet.** The pipeline is tested
end to end under Node, the setup page is checked in a real browser at five sizes,
and the output is pinned against the previous implementation — but no
JavaScript Worker built from this file has been observed running on Cloudflare's
runtime, because the environment it was written in cannot reach Cloudflare.
`npx wrangler dev` closes that gap in about two minutes and is worth doing before
you trust it.

**Cloudflare can close your account.** A torrent metasearch is not obviously
against their terms — it indexes nothing and hosts nothing — but it is your
account on their free tier, and they do not owe you an appeal. Do not put
anything you would miss on the same account.
