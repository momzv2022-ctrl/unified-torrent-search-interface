# TGP — feed-driven engines for the Worker

**Status:** requirements, ready for implementation.
**Audience:** the engineer or coding agent implementing this.
**Scope:** the Cloudflare Worker (`worker/src/worker.js`), a new signed feed, and
the CI that builds and signs it. The Python server is unchanged.

---

## 1. Why

A deployed Worker is a photocopy of one moment. Engine addresses and parsers are
frozen at paste time, and the deployment lives in someone else's Cloudflare
account where we can never reach it again.

The decay this project has actually observed is **address death**, not parser
rot:

- `yts.mx` — registration deleted November 2025.
- `torrents-csv .ml` — lapsed, parked, and a for-sale page answers HTTP 200,
  which is worse than no fallback because it looks reachable.
- `bt4g` — stopped answering and was removed in `7ee2735`.

`UTSI_ENGINE_URLS` already exists as the repair, but it requires a
non-technical user to find and edit a variable in the Cloudflare dashboard.
They will not. Their search quietly gets worse forever.

**Goal:** a signed public feed the Worker reads, so engine addresses and
definitions update without a re-paste — with no ability to execute code in the
user's account, and no ability to break a deployment that cannot reach the feed.

---

## 2. The two contracts

| | direction | what it is |
|---|---|---|
| **TSP** | egress | The protocol the Worker *emits* (`spec/tsp-openapi.yaml`). Unchanged by this work. |
| **TGP** | ingress | A manifest schema the Worker *reads* to learn how to talk to a source. New. |

TGP is **not** a protocol — no two parties speak it over the wire. It is a
signed configuration format. Say so in the docs; contributors will otherwise
conflate it with TSP.

`kind` is the discriminant of a tagged union. Each kind is a variant with a
typed payload and exactly one handler in the Worker.

---

## 3. Non-goals — hard prohibitions

These are not preferences. A patch that violates any of them should be rejected.

1. **No dynamic code execution.** No `eval`, no `new Function`, no QuickJS/WASM
   JS engine, no Worker Loader / `@cloudflare/codemode`. `eval` and
   `new Function` are blocked by the Workers runtime anyway; the `unsafe_eval`
   binding is local-only and undeployable; Worker Loader is paid-plan and beta.
   All three would also end paste-one-file deployment.
2. **The feed never carries executable code.** Data only, schema-validated.
3. **The feed never carries, sets, or alters a secret.** `UTSI_API_KEY`,
   `UTSI_UPSTREAM_URL`, `UTSI_UPSTREAM_APIKEY`, `UTSI_FALLBACK_URL`,
   `UTSI_FALLBACK_APIKEY`, `UTSI_TORZNAB_*` remain environment-only. A feed
   entry must never become a destination that receives an operator's key.
4. **The expression language never gains conditionals, loops, arithmetic
   (beyond a fixed unit multiplier), regex, or user-defined functions.** When a
   source needs any of those, it becomes `kind: tsp` behind a bridge instead.
5. **A feed failure is never a search failure.** Unreachable, unverifiable,
   expired, or malformed — all degrade to cached or seed configuration.
6. **The Worker must remain a single file, pasteable into the Cloudflare
   dashboard, deployable on the Workers free plan, with no build step beyond
   the existing copy in `worker/tools/build.mjs`.**

Out of scope for this work (but must not be designed out): the bridge itself.
`kind: tsp` must be supported so bridges can be routed to later.

---

## 4. Architecture

```
  builder repo (CI, nightly)
      │  rebuild descriptors → replay against fixtures → sign
      ▼
  feed.json + feed.json.sig        ← published to N mirrors
      │
      │  fetched hourly, verified against a pinned root key,
      │  cached, last-known-good retained
      ▼
  Worker (user's account)          ← pasted once, never again
      │  kind → handler → coerce → TSP rows
      ▼
  client
```

Sources reachable per kind:

| kind | payload | covers |
|---|---|---|
| `tsp` | url | bridges, the project's own Python server, other deployments, anyone's index |
| `torznab` | url | Jackett / Prowlarr → hundreds of community-maintained indexers |
| `json` | url template, rows path, field map | the direct-fetch majority |
| `rss` | url template, item path, namespace map | nyaa and RSS-shaped feeds |

Four handlers. Evidence that four is enough — the shapes in
`worker/tests/fixtures/`:

```
piratebay     [ {...} ]                                    rows: ""
animetosho    [ {...} ]                                    rows: ""
knaben        { hits: [...] }                              rows: "hits"
torrentscsv   { torrents: [...] }                          rows: "torrents"
eztvx         { torrents: [...] }                          rows: "torrents"
yts           { data: { movies: [ { torrents: [...] } ] } } rows: nested
```

Five of six need only a rows path and a field map. The variation between them
is pure renaming (`name`/`title`/`filename`, `hash`/`info_hash`/`infohash`,
`size`/`size_bytes`/`bytes`/`total_size`) and representation
(`eztvx.size_bytes` is a string, `torrentscsv.size_bytes` is an integer, apibay
serves everything as strings).

---

## 5. The feed

### 5.1 Published files

| file | contents |
|---|---|
| `feed.json` | the payload, human-readable, formatted for diffing |
| `feed.json.sig` | detached signature: base64 Ed25519 over the **exact bytes** of `feed.json` |
| `keyring.json` | the signing subkeys currently valid |
| `keyring.json.sig` | detached signature over `keyring.json`, made by the offline **root** key |

Detached signatures over exact bytes, rather than an enveloped/base64 payload,
so the feed stays readable in a browser and diffable in git — the same
reasoning as publishing `worker.js.sha256` next to a file anyone can read.

### 5.2 Envelope

```json
{
  "tgp_version": 1,
  "serial": 137,
  "issued_at": "2026-08-17T04:00:00Z",
  "expires_at": "2026-08-31T04:00:00Z",
  "moved_to": null,
  "mirrors": [
    "https://feed.example.org/feed.json",
    "https://momzv2022-ctrl.github.io/unified-torrent-search-interface/feed.json"
  ],
  "engines": [ /* descriptors, section 6 */ ]
}
```

- `serial` — monotonically increasing. Anti-rollback.
- `expires_at` — bounded replay window. Recommended 14 days; the feed is
  rebuilt nightly, so this is fourteen chances to notice a stuck pipeline.
- `moved_to` — a URL, or `null`. When non-null, `/healthz` reports that the
  project has moved. This is the broadcast channel that survives the code host
  disappearing.
- `mirrors` — where else this exact feed is published. The Worker may try these
  in order when its configured URL fails.

### 5.3 Trust model

Two levels, because a pasted file's pinned key can never be changed for
deployments that already exist.

- **Root key** — Ed25519, generated and kept offline, never on a networked
  machine or in CI. Its public key is a `const` in `worker.js`. Pin **two**:
  `ROOT_KEYS = [current, spare]`, so a root compromise has a recovery path that
  does not require every user to re-paste.
- **Subkeys** — Ed25519, live in CI secrets, sign `feed.json`. Listed in
  `keyring.json` with `not_before` / `not_after`. Rotate freely.

The Worker pins only root public keys. Everything else is discovered and
verified.

### 5.4 Verification — the algorithm

Ordered. Any failure at any step means the feed is rejected and section 5.5
applies. Failures are recorded for `/healthz` and never thrown to a search.

1. Fetch `keyring.json` and `keyring.json.sig`.
2. Verify the keyring signature against **any** pinned root key. Reject if none
   verifies.
3. Fetch `feed.json` and `feed.json.sig`.
4. Find the subkey named in the signature file's `key_id`; reject if it is not
   in the keyring, or if `now` is outside its `not_before`/`not_after`.
5. Verify `feed.json.sig` over the exact bytes of `feed.json`.
6. Parse. Reject if `tgp_version` is greater than the Worker supports.
7. Reject if `expires_at` is in the past.
8. Reject if `serial` is lower than the highest serial previously accepted.
9. Validate every descriptor against the schema (section 6). **Invalid
   descriptors are dropped individually; the rest of the feed is still
   accepted.** One malformed entry must not blank an entire deployment.
10. Drop descriptors whose `kind` the Worker does not recognise. Record their
    names for `/healthz`. Do not error.

Rollback protection at step 8 is best-effort: the Cache API is per-colo and
evictable, so a cold colo has no memory of the highest serial. `expires_at`
is what bounds the replay window; document this honestly rather than claiming
a guarantee the storage cannot give.

Use `crypto.subtle` with `Ed25519`. If a compatibility problem appears, fall
back to ECDSA P-256 rather than shipping a userland signature implementation.

### 5.5 Fetch, cache, fail-open

- Fetched from `UTSI_FEED_URL`, defaulting to the pinned project URL.
- **Never on the search critical path.** Refresh via `ctx.waitUntil` and/or a
  scheduled handler. A search uses whatever configuration is currently
  resolved.
- Cache with `cf: { cacheTtl: 3600, cacheEverything: true }` plus the Cache API,
  so a zero-binding paste-one-file deployment still works. KV is optional and
  must not be required.
- **Resolution order when the feed is unusable:** last verified feed from cache
  → the seed list compiled into the Worker (section 9.4). Never zero engines.
- `UTSI_FEED=0` disables feed fetching entirely. Seed list only.

### 5.6 Precedence

Highest wins:

1. Operator environment variables (`UTSI_ENGINES`, `UTSI_ENGINE_URLS`, all
   secrets).
2. The verified feed.
3. The compiled-in seed list.

An operator override must never be silently replaced by feed content, and
`/healthz` must show which layer each engine's configuration came from.

---

## 6. Descriptor schema

### 6.1 Common fields

```json
{
  "name": "knaben",
  "kind": "json",
  "breadth": "broad",
  "enabled": true,
  "origins": ["https://api.knaben.org", "https://api.knaben.eu"],
  "site": "https://knaben.org",
  "note": "API host, not the site."
}
```

- `name` — `^[a-z0-9][a-z0-9_-]{0,31}$`. Stable identity; used in `UTSI_ENGINES`,
  `engine_errors`, and `/healthz`.
- `breadth` — `broad` | `narrow`. Feeds the existing health logic: a deployment
  with every broad engine down is unhealthy even if a narrow one answers.
- `origins` — ordered; first host that answers wins. Retains today's behaviour.
- `enabled` — `false` marks a dead engine. The Worker stops asking, which
  reclaims the per-request time budget rather than burning it on a corpse.

### 6.2 `kind: tsp`

```json
{ "name": "community-bridge-1", "kind": "tsp", "origins": ["https://..."] }
```

No parsing. Reuse the existing `tspIndex` path. **Never send an operator's API
key to a feed-supplied TSP endpoint** — those are public engines. Only
`UTSI_UPSTREAM_URL` / `UTSI_FALLBACK_URL`, which the operator configured
themselves, carry credentials.

### 6.3 `kind: torznab`

```json
{ "name": "prowlarr-public", "kind": "torznab", "origins": ["https://..."] }
```

Reuse the existing Torznab XML path. Same credential rule as 6.2.

### 6.4 `kind: json`

```json
{
  "name": "knaben",
  "kind": "json",
  "request": {
    "method": "POST",
    "path": "/",
    "query": {},
    "body": { "search_type": "score", "query": "{q}", "size": "{limit}" }
  },
  "rows": "hits",
  "fields": {
    "name":       "title",
    "infohash":   ["hash", "info_hash", "infohash"],
    "size_bytes": ["bytes", "size_bytes", "size"],
    "seeders":    "seeders",
    "leechers":   ["peers", "leechers"],
    "first_seen": "date",
    "magnet":     "magnet",
    "torrent_url":"torrent_url",
    "category":   "category"
  }
}
```

- `request.path` / `query` / `body` — templates. Only these placeholders are
  substituted: `{q}`, `{limit}`, `{offset}`, `{category}`. Values are
  percent-encoded with the project's existing `quote`/`quotePlus` so magnets
  and query strings stay byte-identical to the Python server's output.
- `rows` — a path to the array of rows. `""` means the response is itself the
  array. `[]` denotes array traversal, permitted **only** here, and at most
  twice: `data.movies[].torrents[]` covers yts, the single nested case.
- `fields` — target TSP field → expression (section 7).

### 6.5 `kind: rss`

As `json`, but `rows` selects `<item>` elements and an optional
`namespaces: { "nyaa": "https://..." }` map resolves prefixed children.
Namespace prefixes must be resolved from the document, not assumed — the
existing `namespacePrefix` helper already does this correctly.

### 6.6 Unknown kinds

Skip the entry. Record the name and kind. Report in `/healthz` as
`unsupported_kinds`. **This is what makes the design forward-compatible without
a version handshake**: a 2026 Worker reading a 2029 feed uses what it
understands and ignores the rest.

Corollary the feed builder should exploit: **list a source twice** under two
kinds — `json` for old Workers, `tsp` for new ones. Both populations keep
working and nothing negotiates anything.

---

## 7. The expression language

Deliberately not a language with a parser. JSON-native forms only.

| form | meaning |
|---|---|
| `"a.b"` | one path |
| `["a", "b.c", "d"]` | alternation — **first non-absent wins** |
| `{"from": ["size"], "unit": "mib"}` | alternation with a unit annotation |

- **Path** — dot-separated object keys. `^.` prefixes one parent scope, for
  nested `rows` (yts needs `"name": "^.title_long"`). Numeric segments index
  arrays.
- **Alternation** solves two problems with one operator: sites naming the same
  field differently, and a site that sometimes omits it. Both reduce to "take
  the first alternative that produced a value."
- **`unit`** — `kib` | `mib` | `gib`. The **only** annotation, and the only
  arithmetic. It exists because units are semantics, not representation: `1234`
  could be bytes or MiB and no runtime inspection recovers which. Everything
  else is inferred (section 8).

Limits, enforced by the validator and by the Worker:

- ≤ 8 alternatives per field.
- ≤ 8 path segments per alternative.
- ≤ 64 characters per path.
- ≤ 40 fields per descriptor, ≤ 64 descriptors per feed.

Prohibited, permanently: conditionals, loops, arithmetic other than `unit`,
regex, string concatenation, references to other fields, and any escape into
host functions.

---

## 8. Coercion and absence

This section is the correctness core. Everything else is plumbing.

### 8.1 The law

Every coercion is total:

```
coerce : (Value, TargetType) -> T | absent
```

It never throws. It never returns `NaN`. It never invents a default.

The project already states this, in `intOrNone`:

> *Anything that is not a plain integer is "no value", not zero: a missing
> seeder count and a count of nought are different facts, and TSP omits the
> first rather than lying with the second.*

Generalise that comment into the rule for every type.

### 8.2 Target types, derived not declared

Because the TSP row schema is known, the descriptor says only **where** a value
is, never **how** to convert it. Reuse the existing helpers:

| TSP field | target | coercion | existing helper |
|---|---|---|---|
| `name` | text | trim, HTML-entity decode | `htmlUnescape`, `cleanName` |
| `size_bytes`, `files`, `seeders`, `leechers`, `dht_peers` | int | strict `^[+-]?\d+$`, reject `> 2^53`, reject negative | `intOrNone` |
| `first_seen`, `scraped_at` | ISO-8601 | int → unix (seconds vs ms by magnitude); string → ISO or RFC-822 | `firstSeen`, `isoFromUnix`, `pubDate` |
| `infohash` | hex40 | 40 hex as-is; 32 base32 decoded; a `magnet:` string → extract `urn:btih:` | `normalizeInfohash`, `infohashFromMagnet` |
| `magnet` | text | pass through, or construct from infohash + name + `DEFAULT_TRACKERS` | existing magnet builder |
| `category`, `year`, `resolution`, `codec`, `source`, `season`, `episode` | text | trim | existing |

Note `firstSeen` already distinguishes seconds from milliseconds by magnitude
(`> 4102444800`), so no `ms` annotation is needed.

**Do not write new coercion functions.** Route the descriptor through the ones
that exist; that is what keeps the golden output byte-identical.

### 8.3 Absence

- **Empty string is absent.** `""` is not a name and not a number. State this
  explicitly — it is the rule implementations silently disagree on.
- `null`, `undefined`, missing key, and unparseable input are all absent.
- Absent alternatives fall through to the next alternative.

Per-field policy once all alternatives are exhausted:

| field | absent means |
|---|---|
| `magnet` (or `infohash` from which it can be built) | **drop the row** — TSP requires `magnet` |
| `name` | **drop the row** |
| every other field | **omit the key** — never `0`, never `null`, never epoch |

The "never 0" rule is load-bearing, not tidiness. If an engine stops reporting
seeders and absent becomes `0`, every one of its rows sinks to the bottom of
every sorted page and the engine appears to be serving dead swarms — a silent
degradation of exactly the kind this project exists to avoid. Absent must
survive to the wire, and the sort must place absent **after** all known values.

### 8.4 Row invariants

After mapping, a row is emitted only if all hold:

1. `name` present and non-empty after trimming.
2. `magnet` present and containing a syntactically valid `urn:btih:`, or an
   `infohash` valid enough to build one from.
3. The infohash is not all zeroes. Generalise the existing
   `APIBAY_EMPTY_INFOHASH` check — apibay's "No results returned" sentinel row
   has forty zeroes and would otherwise be handed to a client as a magnet
   pointing at nothing.

Otherwise drop the row and increment a counter.

### 8.5 Serialization

Omit absent keys. **Do not emit `null`.** `JSON.stringify(NaN)` silently
produces `null`, and `size_bytes: null` invites a client to do arithmetic and
arrive back at `NaN`. Omission forces a client to check.

---

## 9. Worker changes

### 9.1 Removed

The per-engine adapter functions: `knaben`, `piratebay`, `torrentscsv`, `yts`,
`nyaa`, `animetosho`, `eztvx`. Their behaviour is reproduced by descriptors.

### 9.2 Retained unchanged

The XML scanner (`rss` and `torznab` both need it), `normalizeInfohash`,
`infohashFromMagnet`, magnet construction, `DEFAULT_TRACKERS`, the HTML entity
table, `intOrNone` / `isoFromUnix` / `firstSeen` / `pubDate`, merge and dedupe,
category and resolution mapping, the fan-out with its per-engine deadline,
multi-origin retry, auth, `/healthz`, `/api/v1/engines`, `readSettings`.

Realistic size: ~3,200 → ~1,400 lines. The prize is not line count — it is that
**adding an engine becomes a feed edit rather than a release.**

### 9.3 Added

- Feed fetch, signature verification, schema validation, cache, last-known-good.
- Four kind handlers.
- The path resolver and alternation evaluator (small — no parser, JSON forms
  only).
- Target-typed coercion dispatch over the existing helpers.
- Drop-ratio accounting.

### 9.4 The seed list

A compiled-in constant: two or three feed mirror URLs, and descriptors for the
`broad` engines only (`knaben`, `piratebay`, `torrentscsv`). Roughly ten lines
plus their field maps.

Non-negotiable. Without it, "the feed is the single source of truth" means "the
feed is a single point of total failure," and a cold colo with an evicted cache
and an unreachable feed is a brick.

---

## 10. Build pipeline

Extend the existing nightly workflow. New job, or a new stage of `registry`:

1. Rebuild descriptors from source of truth.
2. **Replay each descriptor against its recorded fixture and assert the emitted
   TSP rows match golden output.** `worker/tests/fixtures/*.json` and
   `worker/tests/golden/search.json` already exist and become the descriptor
   test suite. A descriptor that does not reproduce golden output must not
   reach the feed.
3. Validate the whole feed against the TGP schema, including the limits in
   section 7.
4. Bump `serial`, set `issued_at` / `expires_at`.
5. Sign with the CI subkey.
6. Commit and publish to all mirrors.

Add `concurrency: { group: feed, cancel-in-progress: false }` and a
`git pull --rebase` before push — a scheduled commit-back job races itself
otherwise.

Two platform facts to design around: scheduled workflows are best-effort and
routinely delayed, and **GitHub disables scheduled workflows in public repos
after 60 days without repository activity**. The Worker's fail-open behaviour
must be correct for a feed that simply stops being updated, and `expires_at`
plus a `/healthz` staleness warning are what make that visible.

---

## 11. Health and observability

Add to `/healthz`:

- `feed`: source URL, `serial`, `issued_at`, `expires_at`, verification result,
  whether serving from cache, and how stale.
- `moved_to`, when the feed carries it.
- `unsupported_kinds`: names the Worker skipped.
- Per engine: configuration layer (`env` | `feed` | `seed`), and
  `rows_seen` / `rows_emitted` / `drop_ratio`.

The drop ratio is drift detection obtained for free. If knaben renames `hash`,
the fetch still returns 200, the JSON still parses, every row fails the row
invariant, and the engine emits nothing — today that reads as healthy. A
collapsed emit ratio is the alarm.

Surface engine attribution in the search response too, so a UI can say *"5 of 7
engines answered; knaben: timeout; piratebay: HTTP 403."* A blank page is a bug
report. A blank page that names two dead third parties is a shrug.

---

## 12. Security requirements

1. Signature verification before any parsing of feed content beyond what
   verification itself requires.
2. Root public keys pinned as `const` in `worker.js`; two of them; changing
   them is a breaking release.
3. The CI signing subkey is a repository secret. The root key never touches CI.
4. Feed-supplied endpoints are **public engines**: no `Authorization`, no
   `X-API-Key`, no operator credential, ever. Preserve the existing invariant
   that only operator-configured `upstream` / `fallback` / `torznab` carry keys.
5. All descriptor origins must be `https://`. Reject anything else.
6. Enforce every limit in section 7 at parse time, before evaluation.
7. `/healthz` must never disclose an operator's `upstream` or `fallback`
   address or key — the behaviour commit `e5c2062` established.
8. The feed is fetched, never posted to. No search text, no user identifier, no
   deployment identifier leaves the Worker toward the feed host.

---

## 13. Acceptance criteria

1. **`node --test worker/tests/worker.test.mjs` passes with all 27 golden
   scenarios byte-identical to today's output**, with every engine driven by a
   descriptor instead of a hand-written adapter. This is the primary bar.
2. The Python parity suite (`worker/tests/parity/`) still passes.
3. Worker deploys on the **free** Workers plan, still a single file, still
   pasteable via the setup page, still with `const API_KEY = "";` unmodified in
   the published artifact.
4. With `UTSI_FEED=0`, searches work from the seed list alone.
5. With the feed URL pointed at a 404, a truncated file, a bad signature, an
   expired feed, and a rolled-back serial: searches still work; `/healthz`
   reports the specific reason in each case.
6. A feed containing one malformed descriptor and one unknown `kind` loads the
   remaining engines and reports both.
7. A response with `null`, `""`, `"abc"`, and `1e999` in numeric fields
   produces omitted keys — no `NaN`, no `0`, no `null` on the wire.
8. A row with no infohash and no magnet is dropped and counted.
9. An engine whose descriptor no longer matches its live response reports a
   `drop_ratio` near 1.0 rather than reporting healthy.
10. A feed carrying `moved_to` surfaces it in `/healthz`.

---

## 14. Phasing

Each phase is independently shippable. Do not start the next before the
previous is green.

- **P1 — expression + coercion engine.** No feed yet. Convert the existing
  engines to compiled-in descriptors. Golden tests must stay byte-identical.
  This proves the grammar is sufficient before any trust machinery exists.
- **P2 — feed fetch, verification, cache, fail-open, seed list.** Feed served
  from a static file; descriptors identical to P1's.
- **P3 — build pipeline.** Nightly rebuild, fixture replay, signing, mirrors.
- **P4 — observability.** Drop ratios, engine attribution in the UI,
  `moved_to`, staleness warnings.

`kind: tsp` and `kind: torznab` work from P1, since both reuse existing code
paths. That means a bridge can be routed to before any bridge exists.

---

## 15. Decisions left to the implementer

1. **yts nesting.** Either support `[]` twice in `rows` with `^.` parent-scope
   field access, or leave yts out of the feed and behind a bridge. It is the
   only nested case, and it is a `narrow` engine. Cheap either way — pick one
   and document it.
2. **Serial persistence.** Cache API is evictable, so rollback protection is
   best-effort. If a deployment has KV, using it is better. Do not *require*
   KV.
3. **Feed refresh trigger.** `ctx.waitUntil` on a search, a `scheduled` handler,
   or both. Whichever is chosen must keep the fetch off the search critical
   path.
4. **Ed25519 vs P-256.** Prefer Ed25519. Fall back to P-256 if a compatibility
   problem appears; do not ship a userland signature implementation.

---

## Appendix — worked example

`torrentscsv`, from `worker/tests/fixtures/torrentscsv.json`:

```json
{
  "name": "torrentscsv",
  "kind": "json",
  "breadth": "broad",
  "enabled": true,
  "origins": ["https://torrents-csv.com"],
  "site": "https://torrents-csv.com",
  "request": { "method": "GET", "path": "/service/search", "query": { "q": "{q}", "size": "{limit}" } },
  "rows": "torrents",
  "fields": {
    "name":       "name",
    "infohash":   ["infohash", "info_hash"],
    "size_bytes": ["size_bytes", "bytes"],
    "seeders":    "seeders",
    "leechers":   "leechers",
    "files":      "completed",
    "first_seen": "created_unix"
  }
}
```

The response has `size_bytes` as an integer; eztvx serves the same field as a
string; apibay serves everything as strings. None of those differences appear
in the descriptor, because the TSP target type is `int` and `intOrNone` already
handles all three — returning absent, never `NaN`, for anything else.
