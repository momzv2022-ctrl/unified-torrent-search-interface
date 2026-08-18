# TGP — the signed engine feed, as implemented

The requirements are in [`tgp-requirements.md`](tgp-requirements.md). This
document is what was actually built, where it deliberately differs, and how to
switch the feed on. Audience: the maintainer operating it, and anyone reviewing
`worker/src/worker.js` section 6.

TGP is **not a protocol** — no two parties speak it over the wire. It is a
signed configuration format the Worker *reads*. TSP, unchanged by any of this,
remains the protocol the Worker *emits*.

---

## What it does

A deployed Worker is a photocopy of one moment, pasted into a Cloudflare
account this project can never reach again. The decay actually observed is
address death — yts.mx deleted, torrents-csv.ml parked and answering HTTP 200
with a for-sale page, bt4g gone silent. TGP makes the repair automatic:

- Every public JSON/RSS engine in the Worker is a **descriptor** — data, not
  code: where to ask, where the rows are, which of their fields feeds which TSP
  field. The compiled-in set (`SEED_DESCRIPTORS`) reproduces the old adapters
  byte for byte; the golden tests hold that line.
- The Worker fetches `feed.json` from GitHub Pages roughly hourly, off the
  search critical path, verifies it against **root keys pinned in the file**,
  and adopts its descriptors. New address, renamed field, new engine, engine
  marked dead — all without a re-paste.
- Every failure — unreachable, unverifiable, expired, rolled back, malformed —
  degrades to the last verified feed in the colo cache, then to the compiled-in
  seed. **A feed failure is never a search failure.**

Precedence, highest wins: operator environment (`UTSI_ENGINES`,
`UTSI_ENGINE_URLS`, all secrets) → verified feed → compiled-in seed.
`/healthz` reports which layer configured each engine (`config: env|feed|seed`)
and a `feed` block with serial, expiry, verification state and the last error.
`UTSI_FEED=0` turns the whole thing off; `UTSI_FEED_URL` points it elsewhere.

## Trust model

Two levels, because a pasted file's pinned key can never be rotated for
deployments that already exist:

| key | where it lives | signs |
|---|---|---|
| root (× 2, one spare) | offline, never in the repo or CI | `keyring.json` |
| subkey | `TGP_FEED_KEY` repository Actions secret | `feed.json`, nightly |

The Worker pins only the two root public keys (`TGP_ROOT_KEYS` in
`worker.js`). Everything else is discovered and verified: keyring signature
against any pinned root, subkey validity window, feed signature against the
subkey, `tgp_version`, `expires_at`, monotonic `serial`. Signatures are
detached Ed25519 over the **exact bytes** of each file, so the feed stays
readable in a browser and diffable in git.

Rollback protection is honest rather than absolute: the Cache API is per-colo
and evictable, so a cold colo has no memory of the highest serial. The
14-day `expires_at` is what actually bounds the replay window.

What the feed can never do: execute anything (data only, schema-validated,
limits enforced before evaluation), carry or receive a secret (feed engines
are public engines — no `Authorization`, no `X-API-Key`, ever), or name the
reserved engines that hold operator credentials (`upstream`, `fallback`,
`torznab`).

## The descriptor schema

Common fields: `name` (`^[a-z0-9][a-z0-9_-]{0,31}$`), `kind`
(`tsp | torznab | json | rss` — unknown kinds are skipped and reported, which
is the forward-compatibility story), `breadth` (`broad|narrow`), `enabled`
(`false` = stop asking a dead engine), `origins` (ordered, `https://` only),
`site`, `note`.

`json`/`rss` add: `request` (`method`, `path`, `query`, `body` for POST,
`limit_cap`), `rows`, `rows_required`, `provenance`, `namespaces` (rss), and
`fields` — TSP target → expression:

| form | meaning |
|---|---|
| `"a.b"` | one path (dot keys, `^.` steps to the parent scope, numeric segments index arrays) |
| `["a", "b.c"]` | alternation — first present value wins; unparseable is absent and falls through |
| `{"from": ..., "unit": "kib\|mib\|gib"}` | the number is in that unit |
| `{"from": ..., "nonzero": true}` | this site sends `0` for "not recorded" |
| `{"from": ..., "map": {...}, "prefix": 1}` | finite lookup table — category digits |
| `{"from": ..., "template": "https://...{value}"}` | build one URL from one row value |
| `{"const": "video"}` | the same value for every row |

Only `{q}`, `{limit}`, `{offset}`, `{category}` substitute in request
templates. Limits (≤ 8 alternatives, ≤ 8 segments, ≤ 64 chars per path, ≤ 40
fields, ≤ 64 descriptors) are enforced by `descriptorProblem()` — the same
function gates the feed builder and the Worker, so there is exactly one schema.
Conditionals, loops, arithmetic beyond `unit`, regex, concatenation and
cross-field references stay prohibited, permanently; a source that needs them
goes behind a `kind: tsp` bridge.

Coercion is target-typed and total — the descriptor says *where* a value is,
never *how* to convert it, and every conversion routes through the helpers the
adapters used (`intOrNone`, `firstSeen`, `pubDate`, `normalizeInfohash`,
`humanSize`, `cleanName`). Absence is sacred: `""`, `null`, missing and
unparseable are all "no value", absent survives to the wire as an omitted key,
and a row without a name or a usable infohash (or with apibay's forty zeroes)
is dropped and counted. The seen/emitted counts surface in `/healthz` as
`drop_ratio` — a site renaming a field now reads as a collapsed emit ratio
instead of as healthy.

## Deliberate deviations from the requirements doc

- **`map`, `const`, `template` and `nonzero` exist; the requirements allowed
  only `unit`.** Byte-identical golden output was the acceptance bar, and four
  real engines need them: apibay and nyaa map category digits, eztvx and yts
  are constant-category, apibay builds its description URL from a row id and
  reports `0` for sizes it never recorded. All four forms are still data —
  finite lookups and one-hole URL templates, validated and bounded, no closer
  to a language than `unit` is.
- **yts keeps its hand-written adapter.** Its release name is assembled from
  four fields (`title_long + quality + type + codec + "YTS"`), which is string
  concatenation — prohibited. The requirements left this decision open
  (§15.1); the answer here is: the feed carries a yts entry whose `origins`
  are honoured (address death is the decay that actually happened to yts) and
  deployed Workers keep parsing it with the built-in adapter.
- **The seed is every engine, not just the broad three.** The golden tests
  drive every engine through descriptors, so the descriptors all exist anyway;
  shrinking the fail-open configuration to three engines would have made "feed
  unreachable" quietly narrower than "feed never existed", which is a silent
  degradation of exactly the kind this project exists to avoid.
- **The deploy link outgrew Safari.** The feed machinery pushed the one-click
  playground link past Safari's ~80,000-character URL ceiling. The readable
  one-file artifact was not going to be minified to fit; the setup page tells
  Safari users to use copy-and-paste, which reaches the same place. See
  [`deploy-link.md`](deploy-link.md).

## Operating it

Nothing is live until the maintainer makes keys — until then `TGP_ROOT_KEYS`
is empty, deployed Workers report `feed.status: "no_root_keys"`, and
everything behaves exactly as it did before TGP existed.

**One-time activation:**

1. On a trusted machine: `node worker/tools/feed.mjs keygen`. It writes
   `feed/keyring.json` (+ `.sig`) and prints three things: the
   `TGP_ROOT_KEYS` line to paste into `worker/src/worker.js`, the subkey to
   store as the `TGP_FEED_KEY` repository Actions secret, and the two root
   private keys to store offline — password manager, printout, anywhere that
   is not this repository and not CI. They are shown once.
2. Paste the `TGP_ROOT_KEYS` line, commit it together with
   `feed/keyring.json` and `feed/keyring.json.sig`.
3. Add the `TGP_FEED_KEY` secret under Settings → Secrets and variables →
   Actions.
4. Run the `feed` workflow once by hand (or wait for the nightly cron). It
   validates every descriptor with the Worker's own validator, replays each
   one against its recorded fixture (rows must match the compiled-in engines
   exactly), bumps the serial, signs, commits, and the `pages` workflow
   publishes `feed.json` next to `worker.js`.

**Routine operation:** edit `feed/engines.json` — a new address is a one-line
`origins` change — and push. CI replays it, the feed workflow signs it, Pages
publishes it, and every deployment picks it up within its next refresh hour.
If a descriptor change is *meant* to alter behaviour, update the matching seed
descriptor in `worker.js` in the same commit; the replay gate refuses drift
between the two on purpose.

**Key rotation:** subkeys rotate freely — regenerate, re-sign the keyring with
the offline root, update the secret. A root compromise is what the spare root
is for: re-sign the keyring under the spare; only a compromise of *both* roots
requires shipping new pinned keys, which is a breaking release and a re-paste.

**If the pipeline stops** — cron disabled after 60 idle days, runner failures,
an expired subkey — nothing breaks: the feed expires within 14 days, deployed
Workers report `feed.status: "seed_only"` with the reason in `/healthz`, and
searches continue from each Worker's last-known-good or seed configuration.
