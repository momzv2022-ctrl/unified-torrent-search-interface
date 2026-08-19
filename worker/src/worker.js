/**
 * Unified Torrent Search Interface — a metasearch client for public torrent
 * indexes, as one Cloudflare Worker.
 *
 * It searches indexes that publish a structured API, merges what comes back
 * into one list, and returns metadata and `magnet:` URIs. It hosts nothing,
 * stores nothing, transfers no content, and is not a BitTorrent client — the
 * magnet links it returns are handed to whatever torrent app you already have.
 *
 * This is the whole program. One file, no dependencies, no build step: what
 * you are reading is exactly what runs. Read it before you deploy it — you are
 * about to put it in your own Cloudflare account, and a program you cannot read
 * is one you have to take on trust.
 *
 * Layout, top to bottom:
 *
 *   1. your key            — the one line you are expected to edit
 *   2. configuration       — every UTSI_* setting, and what it defaults to
 *   3. small tools         — encoding, dates, numbers, HTML entities, XML
 *   4. release names       — the six TSP fields that live inside a name
 *   5. categories          — classifying a release from its name
 *   6. engines             — descriptors (engines as data), and the signed
 *                            feed that keeps them current after you paste
 *   7. the TSP pipeline    — merge, filter, sort, page, emit
 *   8. routes              — auth, /healthz, /api/v1/engines, /api/v1/search
 *   9. entry               — the runtime's twelve lines
 *
 * https://github.com/momzv2022-ctrl/unified-torrent-search-interface
 * MIT licensed. No warranty. Laws differ where you are, and complying with
 * them — and with the terms of the sites this queries — is your responsibility.
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. YOUR KEY
// ═══════════════════════════════════════════════════════════════════════════

// Your API key goes here, between the quotes. The setup page fills this in for
// you before you copy; if you are reading a copy from GitHub it is empty.
//
// While it is empty this Worker refuses every request rather than serving
// without one. That is on purpose: the moment you press Deploy the URL is live
// and public, and an open search proxy is found within hours.
//
// You can also set UTSI_API_KEY under Settings → Variables and Secrets in the
// Cloudflare dashboard, which wins over this line — that is how you rotate the
// key without pasting the file again.
const API_KEY = "";

// Bumped when the behaviour changes. `/healthz` reports it, and compares it
// with the version the project publishes, so a Worker can tell you it is old.
const VERSION = "0.4.2";

// Where `/healthz` looks for "is there a newer version". Reached from
// `/healthz` only, never from a search, and never fatal: if it does not answer
// the update field is simply absent. `UTSI_UPDATE_CHECK=0` turns it off.
const UPDATE_FEED = "https://momzv2022-ctrl.github.io/unified-torrent-search-interface/version.json";

// Where the setup page lives. A deployed Worker knows its own address and the
// setup page does not — that is the whole gap this constant closes: the page
// served at `/` links back here with `#addr=<this host>` on the end, so the
// page that minted the key can put the two halves together without anyone
// transcribing a hostname. The address rides in the fragment, which browsers
// never send to a server, so it reaches that page and nowhere else.
const SETUP_PAGE = "https://momzv2022-ctrl.github.io/unified-torrent-search-interface/";

// The one origin this Worker answers cross-origin requests from without being
// configured to. It is the setup page above, and it is here so that page can
// run a real search against your Worker right after you deploy it and show you
// the result, rather than asking you to take "it works" on faith.
//
// Narrow on purpose. It is an origin, so scheme and host and nothing else, and
// a `github.io` origin belongs to one account. A caller from it still needs the
// key, which only you have. UTSI_CORS_ORIGINS adds more; nothing removes this
// one short of editing the line.
const SETUP_ORIGIN = new URL(SETUP_PAGE).origin;

// Where the engine feed lives (see "THE FEED" below). The feed is how a pasted
// Worker keeps its engine addresses and definitions current without ever being
// pasted again: it is fetched hourly off the search path, verified against the
// root keys pinned below, and a Worker that cannot fetch or verify it simply
// keeps the engine definitions compiled into this file. UTSI_FEED_URL points it
// elsewhere; UTSI_FEED=0 turns it off entirely.
const DEFAULT_FEED_URL = "https://momzv2022-ctrl.github.io/unified-torrent-search-interface/feed.json";

/**
 * The Ed25519 public keys this Worker trusts to anchor the feed, base64, raw
 * 32-byte keys. Two on purpose: a pasted file's pinned key can never be changed
 * for deployments that already exist, so the spare is the recovery path that
 * does not require every user to re-paste.
 *
 * The matching private keys are generated offline by the project maintainer
 * (`node worker/tools/feed.mjs keygen`) and never touch CI. While this list is
 * empty the feed is dark and the Worker runs from its compiled-in engines,
 * exactly as it did before the feed existed.
 */
const TGP_ROOT_KEYS = ["LZlXuSYk5LoZ5c2xBLYgJeqfP+e3DgLHTNikvUMQMms=", "qKGFB8cTPzuxiVZevH4Nt0p/j0Wsk1uQNN5BBfm6luY="];

// ═══════════════════════════════════════════════════════════════════════════
// 2. CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Engines to fan out to, in priority order, when UTSI_ENGINES says nothing.
 *
 * Order matters, and the first entry matters most. The fan-out itself is
 * parallel, but rows are merged in this order, so when two engines report the
 * same infohash the earlier one supplies the fields that survive — its
 * category, its description link, its release name. Put the index you trust
 * first.
 *
 * `upstream` leads and needs no announcing: set UTSI_UPSTREAM_URL and it
 * becomes the primary index, leave it unset and it drops out silently.
 *
 * Behind it, public indexes chosen to miss different things: knaben is a
 * meta-index over dozens of trackers the other adapters cannot reach,
 * torrents-csv is a DHT crawl, yts is films only but clean, nyaa is East Asian
 * media nothing else here covers. Each costs one subrequest against an
 * allowance of fifty per request, and `/api/v1/engines?probe=1` says which of
 * them answer from *your* Worker — trim this list from that, not from guesses.
 */
const DEFAULT_ENGINES = [
  "upstream", "knaben", "piratebay", "torrentscsv", "animetosho", "eztvx", "yts",
];

/**
 * Which engines can answer a question about anything, and which only about
 * their own corner.
 *
 * This exists because of the one failure `/healthz` used to miss: it said `ok`
 * whenever *any* engine answered, so a deployment with every broad index down
 * still looked healthy — yts was up, so films worked — while a book, a disk
 * image or a game returned nothing. `broad` means ask it anything; `narrow`
 * means one subject on purpose. Narrow is not worth less, it is just not a
 * substitute.
 */
const ENGINE_BREADTH = {
  upstream: "broad",
  fallback: "broad",
  knaben: "broad",
  piratebay: "broad",
  torrentscsv: "broad",
  torznab: "broad",
  yts: "narrow",
  nyaa: "narrow",
  animetosho: "narrow",
  eztvx: "narrow",
};

/**
 * Where each engine lives, best address first.
 *
 * These sites change domain the way other sites change a logo, and a copy of
 * this file pasted into someone's own account never picks up a fix here. So
 * every engine carries an ordered list rather than one address: the first host
 * that answers wins, and a domain that moves costs a few hundred milliseconds
 * instead of being a dead engine forever.
 *
 * The lists came from the project's own plugin registry (`registry.json`,
 * refreshed nightly from the qBittorrent search-plugins wiki, which tracks
 * these moves), from each site's own published API documentation, and from
 * addresses this project has measured answering. They are a starting point,
 * not a guarantee — anything here can be dead by the time you read it.
 *
 * UTSI_ENGINE_URLS overrides the whole list for an engine and is settable from
 * the Cloudflare dashboard with no re-paste. It stays the documented repair for
 * a move nobody predicted.
 */
const ENGINE_ORIGINS = {
  // The API host, not the site. `.org` is what their docs give; `.eu` has
  // answered historically and is kept as the fallback.
  knaben: ["https://api.knaben.org", "https://api.knaben.eu"],
  // One address: no second one is measured, and a guessed proxy would mean
  // sending real queries somewhere nobody checked.
  piratebay: ["https://apibay.org"],
  // `.ml` was removed: it lapsed, a parker took it, and a for-sale page answers
  // HTTP 200 — worse than no fallback, since it looks reachable.
  torrentscsv: ["https://torrents-csv.com"],
  // yts.mx is gone: its registration was deleted in November 2025, which is what
  // the HTTP 530 two deployments measured really was — Cloudflare wrapping a
  // 1016 Origin DNS Error, not a bot challenge. Reports say yts.bz now redirects
  // on again; that domain is deliberately unlisted, because the evidence tying
  // it to the same operators is thin and this list is where a hijacked domain
  // would do real damage.
  yts: ["https://yts.bz", "https://yts.lt"],
  // One address on purpose: the mirrors that sat here belong to other people,
  // and Nyaa's own position is that unofficial mirrors have served miners and
  // ransomware. A dead engine beats taking magnet links from one.
  nyaa: ["https://nyaa.si"],
  // The API host, not the site: animetosho.org serves the pages, this serves the
  // JSON. One address, because the project has measured no second one.
  animetosho: ["https://feed.animetosho.org"],
  // One address. The site has used several over the years and the others now
  // redirect here, so listing them would be this host by a longer route.
  eztvx: ["https://eztvx.to"],
};

/**
 * What `/api/v1/engines` reports without running anything. Naming an index
 * factually is what an engine list is for; nothing here borrows a site's
 * branding.
 */
const ENGINE_SITES = {
  upstream: "(your own TSP index)",
  fallback: "(an index of your own; set UTSI_FALLBACK_URL)",
  knaben: "https://knaben.org",
  piratebay: "https://apibay.org",
  torrentscsv: "https://torrents-csv.com",
  yts: "https://yts.bz",
  nyaa: "https://nyaa.si",
  animetosho: "https://animetosho.org",
  eztvx: "https://eztvx.to",
  torznab: "(your own Jackett, Prowlarr or NZBHydra)",
};

/**
 * Engines that cannot run until something is configured, and the setting that
 * configures them. Selecting one without it would be a silent no-op on every
 * request, so it is dropped from the roster and said out loud instead.
 */
const ENGINE_REQUIREMENTS = { upstream: "UTSI_UPSTREAM_URL", torznab: "UTSI_TORZNAB_URL" };

/** What a rejected engine is told to do about it. */
const REQUIREMENT_HELP = { upstream: "UTSI_UPSTREAM_URL is not an https:// address" };

/**
 * Never part of the roster. `fallback` is reached by one path only — the one in
 * `search()` that runs when everything found nothing — so putting it in
 * UTSI_ENGINES would quietly turn a last resort into every request.
 */
const NOT_SELECTABLE = ["fallback"];

/** A Torznab base URL pointing at "all indexers" fans out on the far side. */
const MAX_ENGINES = 12;

/**
 * Shorter than this and the key is guessable against a URL that answers 100,000
 * times a day. The local server warns and serves anyway; here it refuses,
 * because a `workers.dev` URL is public the moment it exists.
 */
const MIN_KEY_LENGTH = 16;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** TSP's `cat` enum, minus the empty string that means "no filter". */
const TSP_CATEGORIES = ["video", "audio", "software", "archive", "document", "image"];

/** TSP's `res` enum. */
const RESOLUTIONS = ["2160p", "1080p", "720p", "480p"];

const SORTS = ["", "seeders", "size", "recent"];

/**
 * TSP category → generic queries that stand in for an empty one, best first.
 *
 * An empty `q` means "browse the whole index" in TSP, and a metasearch has no
 * index to browse, so it asks the sites something generic instead. *Which*
 * generic thing has to depend on the category, because both halves of the
 * pipeline reject a mismatch: browsing `cat=audio` for "1080p" asks each site
 * for the few music torrents that mention a video resolution, and
 * `classifyName` throws out whatever did come back.
 */
const BROWSE_TERMS = {
  video: ["2160p", "1080p", "x265"],
  audio: ["flac", "mp3", "discography"],
  software: ["x64", "iso", "repack"],
  document: ["epub", "pdf", "ebook"],
  image: ["wallpapers", "imageset", "photos"],
  archive: ["rar", "zip", "7z"],
};

/** How long one browse query stands before the next takes over. */
const BROWSE_ROTATION_S = 3600;

/** Guard against a `.torrent` that is really a disk image. */
const TORRENT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Public trackers used when building a magnet. Same list the official
 * qBittorrent plugins for these sites embed.
 */
const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://open.demonii.com:1337/announce",
];

/** Paths someone might paste along with their origin. Longest first. */
const API_SUFFIXES = ["/api/v1/search", "/api/v1", "/api"];

const USER_AGENT =
  "utsi-worker/" + VERSION + " (+https://github.com/momzv2022-ctrl/unified-torrent-search-interface)";

// --- reading `env` ---------------------------------------------------------
//
// Worker `vars` and secrets arrive as ordinary properties on `env`, so every
// value is a string or missing. These four turn that into the same defaults the
// local server uses.

function envText(env, name, fallback = "") {
  const value = env && env[name];
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function envInt(env, name, fallback, low, high) {
  const text = envText(env, name, String(fallback));
  if (!/^[+-]?\d+$/.test(text)) return fallback;
  return Math.max(low, Math.min(Number(text), high));
}

function envFlag(env, name, fallback) {
  const raw = envText(env, name, fallback ? "1" : "0").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envList(env, name, fallback = []) {
  const raw = envText(env, name);
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** `a=one,b=two` into an object. Malformed entries are dropped, not fatal. */
function envMap(env, name) {
  const pairs = {};
  for (const item of envList(env, name)) {
    const at = item.indexOf("=");
    if (at <= 0) continue;
    const key = item.slice(0, at).trim();
    const value = item.slice(at + 1).trim().replace(/\/+$/, "");
    if (key && value) pairs[key] = value;
  }
  return pairs;
}

/**
 * A bare `https://host` origin, or `""` when there is not one.
 *
 * Anything that is not a URL reads as "no upstream" rather than as an error —
 * `none`, `n/a`, a blank, whatever was typed. A pasted `.../api/v1/search` is
 * accepted and trimmed: it is the URL that was in front of them when they went
 * looking for the address.
 */
function envOrigin(env, name) {
  let raw = envText(env, name).replace(/\/+$/, "");
  const lower = raw.toLowerCase();
  if (!lower.startsWith("https://") && !lower.startsWith("http://")) return "";
  for (const suffix of API_SUFFIXES) {
    if (raw.toLowerCase().endsWith(suffix)) {
      raw = raw.slice(0, -suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  return raw;
}

/**
 * Read Worker `env` into the settings the rest of this file uses, dropping
 * engine ids we cannot run.
 *
 * Order is preserved exactly as UTSI_ENGINES gives it, because the merge
 * consumes engines in that order and the first one to report a given release is
 * the one whose metadata survives.
 */
function readSettings(env) {
  const chosen = envText(env, "UTSI_ENGINES");
  const asked = envList(env, "UTSI_ENGINES", defaultRoster());

  // Resolved rather than raw: UTSI_UPSTREAM_URL=none has to read the same as
  // leaving it unset.
  const resolved = {
    UTSI_UPSTREAM_URL: envOrigin(env, "UTSI_UPSTREAM_URL"),
    UTSI_TORZNAB_URL: envText(env, "UTSI_TORZNAB_URL"),
  };

  const engines = [];
  const rejected = {};
  for (const engineId of [...new Set(asked)]) {
    if (NOT_SELECTABLE.includes(engineId)) {
      rejected[engineId] = "not a fan-out engine; it is the empty-result fallback";
      continue;
    }
    if (!(engineId in ENGINES) && !feedDescriptorFor(engineId)) {
      rejected[engineId] = "no such engine";
      continue;
    }
    const requires = ENGINE_REQUIREMENTS[engineId];
    if (requires && !(resolved[requires] ?? envText(env, requires))) {
      // Only worth reporting when it was asked for by name. Silence on a
      // default deploy, where nobody asked for anything.
      if (chosen) rejected[engineId] = REQUIREMENT_HELP[engineId] || `${requires} is not set`;
      continue;
    }
    engines.push(engineId);
    if (engines.length >= MAX_ENGINES) break;
  }

  // The same placeholder rule: an upstream key of "none" is no key.
  let upstreamApikey = envText(env, "UTSI_UPSTREAM_APIKEY");
  if (["none", "n/a", "-"].includes(upstreamApikey.toLowerCase())) upstreamApikey = "";

  const apiKey = envText(env, "UTSI_API_KEY") || String(API_KEY || "").trim();

  return {
    apiKey,
    allowAnonymous: envFlag(env, "UTSI_ALLOW_ANONYMOUS", false),
    engines,
    rejectedEngines: rejected,

    // Another TSP index — in practice a `./start.sh` instance of this project on
    // a machine of your own. Both are secrets: the key obviously, the URL
    // because it is the address of a private server.
    upstreamUrl: resolved.UTSI_UPSTREAM_URL,
    upstreamApikey,

    // The last resort, reached only when the engines above found nothing at
    // all. No address ships with this project: it stays dark until
    // UTSI_FALLBACK_URL points it at an index of your own.
    fallback: envFlag(env, "UTSI_FALLBACK", true),
    fallbackUrl: envOrigin(env, "UTSI_FALLBACK_URL"),
    fallbackApikey: envText(env, "UTSI_FALLBACK_APIKEY"),

    torznabUrl: envText(env, "UTSI_TORZNAB_URL"),
    torznabApikey: envText(env, "UTSI_TORZNAB_APIKEY"),

    // `engine id -> origin`, overriding the whole baked-in list for that engine.
    engineUrls: envMap(env, "UTSI_ENGINE_URLS"),

    /**
     * Rows kept from one engine before merging. Every row past this costs CPU
     * and cannot change the top of a seed-sorted page, so the cap is nearly free
     * in result quality and is the main lever on CPU time.
     *
     * A hundred, back up from the fifty the Python Worker shipped. That fifty
     * was evidence-led: a deployed Pyodide Worker reported 15.9 ms of CPU
     * against a free-plan ceiling of 10, and halving the rows roughly halved the
     * bill. Nearly all of that was the interpreter — the actual work is five
     * `fetch` calls and some JSON reshaping. Measured on this file, with the
     * network answering instantly from memory so that every microsecond counted
     * is work this Worker does (`node worker/tools/bench.mjs 100 300`):
     *
     *     five engines, 100 rows each = 500 rows collected, 50 returned,
     *     with a category filter on, which is the expensive shape because it
     *     keeps the whole candidate set instead of shrinking the window
     *
     *       100 rows/engine → 4.5 ms of CPU per request
     *        50 rows/engine → 3.4 ms
     *
     * Node 22's V8 on an ordinary Linux container, not Cloudflare's machines, so
     * treat it as the shape of the cost rather than the bill.
     *
     * The bill, from the first Worker deployed out of this file — reported by
     * the Cloudflare dashboard's own CPU Time metric, over its first handful of
     * requests:
     *
     *     1.65 ms per request, against the free plan's 10 ms
     *
     * Comfortably faster than the estimate above, which is the direction that
     * costs nobody anything: Cloudflare's machines beat the container this was
     * measured on. Read it for what it is, though — a small number of early
     * requests, not a busy day of five-engine searches returning full pages. Your
     * own number comes from `wrangler tail --format=pretty`, which prints CPU
     * time per request. If you move to the paid plan the ceiling is 30 s and none
     * of this matters.
     */
    maxRowsPerEngine: envInt(env, "UTSI_MAX_ROWS_PER_ENGINE", 100, 10, 500),

    /**
     * `.torrent` fetches allowed per request, for rows that arrive without an
     * infohash. Only Torznab produces those. Zero by default.
     */
    maxResolve: envInt(env, "UTSI_MAX_RESOLVE", 0, 0, 16),

    // Wall clock, not CPU. Waiting on `fetch()` is free under the CPU limit, so
    // these exist to bound how long a client waits, nothing else.
    // Both down from 8 and 20, and both from measurement. Across four probes of a
    // deployed Worker every engine that answered at all answered within 1.4s —
    // knaben 329-503ms, piratebay 21-55ms, torrents-csv 346-609ms, animetosho
    // 789-1254ms, eztvx 308-345ms. A budget above that is not buying results, it
    // is buying the right to wait on something that will never answer. Set
    // UTSI_REQUEST_DEADLINE_S=2 for the tighter target; nothing here needs 20s.
    engineTimeoutS: envInt(env, "UTSI_ENGINE_TIMEOUT_S", 5, 1, 60),
    // Three seconds when this Worker is talking to public indexes, and twenty
    // when it is fronting an `upstream` of your own — because that is not a site,
    // it is another metasearch running its own fan-out behind its own deadline,
    // and cutting it off at three would be cutting off the whole answer.
    //
    // Three, not the twenty this carried, because of what the engines do: across
    // four probes every index that answered answered within 1.4s. A larger budget
    // bought no results, only the right to wait on something that never answers —
    // one probe had yts take 5,535ms and return nothing, with every other engine
    // finished inside 805ms.
    requestDeadlineS: envInt(
      env, "UTSI_REQUEST_DEADLINE_S", resolved.UTSI_UPSTREAM_URL ? 20 : 3, 1, 120,
    ),
    // `upstream` gets its own, longer budget: it is not a site, it is another
    // metasearch running its own fan-out behind its own eight-second deadline.
    upstreamTimeoutS: envInt(env, "UTSI_UPSTREAM_TIMEOUT_S", 15, 1, 60),

    // What an empty `q` means. TSP calls it "browse the whole index", and a
    // metasearch has no index to browse — so `browse` stands a generic query in
    // its place and `empty` answers with no rows. Never a 400 either way.
    emptyQueryMode:
      envText(env, "UTSI_EMPTY_QUERY_MODE", "browse").toLowerCase() === "empty" ? "empty" : "browse",
    browseQueries: envList(env, "UTSI_BROWSE_QUERIES", BROWSE_TERMS.video),

    // Named origins only, by design. A wildcard would let any page spend
    // someone else's instance. One name is compiled in: the setup page, so it
    // can run a real search against a Worker the moment it is deployed and show
    // the answer. See SETUP_ORIGIN.
    corsOrigins: [SETUP_ORIGIN, ...envList(env, "UTSI_CORS_ORIGINS")],
    banner: envFlag(env, "UTSI_BANNER", true),
    updateCheck: envFlag(env, "UTSI_UPDATE_CHECK", true),

    // The signed engine feed. Never on the search critical path, and never a
    // failure a client sees: unusable means the compiled-in engines serve.
    feed: envFlag(env, "UTSI_FEED", true),
    feedUrl: envText(env, "UTSI_FEED_URL", DEFAULT_FEED_URL),
  };
}

/** `""`, `"missing"` or `"short"` — which is not the same complaint. */
function keyProblem(settings) {
  if (!settings.apiKey) return "missing";
  return settings.apiKey.length < MIN_KEY_LENGTH ? "short" : "";
}

/** Whether this Worker is safe to serve traffic. No usable key ⇒ it is not. */
function isConfigured(settings) {
  return settings.allowAnonymous || keyProblem(settings) === "";
}

/** The wall-clock budget for one engine, in seconds. */
function timeoutFor(settings, engineId) {
  return engineId === "upstream" ? settings.upstreamTimeoutS : settings.engineTimeoutS;
}

/**
 * Where to reach *engineId*, best first, and where each address came from.
 *
 * Highest wins, per layer: an explicit UTSI_ENGINE_URLS entry replaces every
 * list rather than joining it — it is the repair for a move nobody predicted,
 * and a repair that still tried three dead addresses first would be a slower
 * dead engine. Below that, the verified feed's addresses beat the compiled-in
 * ones, which is the whole point of the feed: an address that died after this
 * file was pasted is repaired by the next feed refresh, not by a re-paste.
 */
function originsFor(engineId, settings) {
  const override = settings.engineUrls[engineId];
  if (override) return [{ url: override, from: "UTSI_ENGINE_URLS" }];
  const fed = feedDescriptorFor(engineId);
  if (fed && Array.isArray(fed.origins) && fed.origins.length) {
    return fed.origins.map((url) => ({ url, from: "feed" }));
  }
  const seeded = ENGINE_ORIGINS[engineId] || [];
  return seeded.map((url) => ({ url, from: "built-in" }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. SMALL TOOLS
// ═══════════════════════════════════════════════════════════════════════════

// --- percent-encoding ------------------------------------------------------
//
// `encodeURIComponent` leaves `!'()*` alone; the rest of the world's
// URL-encoders do not. Encoding them keeps magnet links and query strings
// byte-identical to what the local server produces, which is what lets a client
// dedupe rows across the two.

function quote(text) {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function quotePlus(text) {
  return quote(text).replace(/%20/g, "+");
}

/** `{a: "1", b: "x y"}` into `a=1&b=x+y`, in insertion order. */
function urlencode(params) {
  return Object.entries(params)
    .map(([key, value]) => quotePlus(key) + "=" + quotePlus(value))
    .join("&");
}

// --- numbers and dates -----------------------------------------------------

/**
 * These APIs share nova3's habit of sending numbers as strings.
 *
 * Anything that is not a plain integer is "no value", not zero: a missing
 * seeder count and a count of nought are different facts, and TSP omits the
 * first rather than lying with the second.
 */
function intOrNone(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  const number = Number(text);
  // Beyond 2^53 a JavaScript number is no longer the integer it was given, and
  // no real file size is. Refusing beats silently rounding.
  if (!Number.isSafeInteger(number) || number < 0) return null;
  return number;
}

/** Unix seconds into `2019-01-01T00:00:00Z`, or null if that is not a date. */
function isoFromUnix(seconds) {
  const ms = seconds * 1000;
  if (!Number.isFinite(ms) || ms < 0 || ms > 253402300799000) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A first-seen stamp from an engine, in seconds or milliseconds. */
function firstSeen(value) {
  let stamp = intOrNone(value);
  if (!stamp) return null;
  if (stamp > 4102444800) stamp = Math.floor(stamp / 1000); // 2100-01-01Z: it is milliseconds
  return isoFromUnix(stamp);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** The named zones RFC 822 allows, in minutes east of UTC. */
const NAMED_ZONES = {
  ut: 0, utc: 0, gmt: 0, z: 0,
  est: -300, edt: -240, cst: -360, cdt: -300,
  mst: -420, mdt: -360, pst: -480, pdt: -420,
};

const RFC822 =
  /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:([+-]\d{4})|([A-Za-z]{1,3}))?\s*$/;

/**
 * RFC 822, which is what Torznab and nyaa feeds use, into ISO-8601.
 *
 * A feed saying `-0000` means "UTC, offset unknown" and is read as UTC — nyaa
 * stamps every item that way — but a real `+0000` and a named `GMT` are kept as
 * offsets, so the two round-trip differently and the output matches what the
 * local server emits for the same feed.
 */
function pubDate(raw) {
  if (!raw) return null;
  const match = RFC822.exec(String(raw).trim());
  if (!match) return null;

  const [, dayText, monthText, yearText, hourText, minuteText, secondText, offsetText, zoneText] =
    match;
  const month = MONTHS[monthText.toLowerCase()];
  if (!month) return null;

  let year = Number(yearText);
  if (yearText.length === 2) year += year < 68 ? 2000 : 1900; // RFC 2822 §4.3
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText ? Number(secondText) : 0;
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;

  let offset = 0;
  let naive = false;
  if (offsetText) {
    offset = Number(offsetText.slice(1, 3)) * 60 + Number(offsetText.slice(3, 5));
    if (offsetText[0] === "-") offset = -offset;
    // `-0000` is the spelling for "UTC, and the real zone is unknown".
    naive = offsetText === "-0000";
  } else if (zoneText) {
    const named = NAMED_ZONES[zoneText.toLowerCase()];
    if (named === undefined) return null;
    offset = named;
  } else {
    naive = true;
  }

  const stamp = `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  if (naive) return stamp + "Z";
  if (offset === 0) return stamp + "Z";
  const sign = offset < 0 ? "-" : "+";
  const size = Math.abs(offset);
  return `${stamp}${sign}${pad2(Math.floor(size / 60))}:${pad2(size % 60)}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function pad4(n) {
  return String(n).padStart(4, "0");
}

// --- HTML entities ---------------------------------------------------------
//
// Sites that serve their index as JSON often serve it HTML-escaped anyway,
// because the same rows go to their own web page. Left alone that reaches the
// client as literal `&amp;`, ends up in the magnet's display name, and quietly
// breaks deduplication against the same release from an engine that unescaped
// it.
//
// The full HTML5 table is 2231 entries and would be most of this file. What is
// here is HTML 4.01 plus the punctuation that turns up in release names, which
// covers everything seen in the wild; an unrecognised entity is left exactly as
// it was, which is what a browser does with an invalid one anyway.

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  iexcl: "¡", cent: "¢", pound: "£", curren: "¤", yen: "¥", brvbar: "¦", sect: "§",
  uml: "¨", copy: "©", ordf: "ª", laquo: "«", not: "¬", shy: "\u00ad", reg: "®",
  macr: "¯", deg: "°", plusmn: "±", sup2: "²", sup3: "³", acute: "´", micro: "µ",
  para: "¶", middot: "·", cedil: "¸", sup1: "¹", ordm: "º", raquo: "»", frac14: "¼",
  frac12: "½", frac34: "¾", iquest: "¿", times: "×", divide: "÷",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ",
  Ccedil: "Ç", Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í",
  Icirc: "Î", Iuml: "Ï", ETH: "Ð", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô",
  Otilde: "Õ", Ouml: "Ö", Oslash: "Ø", Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü",
  Yacute: "Ý", THORN: "Þ", szlig: "ß",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ",
  ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í",
  icirc: "î", iuml: "ï", eth: "ð", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô",
  otilde: "õ", ouml: "ö", oslash: "ø", ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü",
  yacute: "ý", thorn: "þ", yuml: "ÿ",
  OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ", circ: "ˆ",
  tilde: "˜", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", zwnj: "\u200c",
  zwj: "\u200d", lrm: "\u200e", rlm: "\u200f",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”",
  bdquo: "„", dagger: "†", Dagger: "‡", bull: "•", hellip: "…", permil: "‰",
  prime: "′", Prime: "″", lsaquo: "‹", rsaquo: "›", oline: "‾", frasl: "⁄",
  euro: "€", trade: "™", larr: "←", uarr: "↑", rarr: "→", darr: "↓", harr: "↔",
  minus: "−", lowast: "∗", radic: "√", infin: "∞", ne: "≠", le: "≤", ge: "≥",
  loz: "◊", spades: "♠", clubs: "♣", hearts: "♥", diams: "♦",
};

/**
 * The entities a browser accepts without their closing semicolon, and therefore
 * the ones `&amp` has to decode as `&`. Everything else needs the semicolon,
 * which is why `&notit;` decodes to `¬it;` and not to something surprising.
 */
const LEGACY_ENTITIES = new Set([
  "amp", "lt", "gt", "quot", "nbsp", "copy", "reg", "deg", "para", "sect", "micro",
  "middot", "not", "shy", "times", "divide", "pound", "cent", "yen", "curren", "acute",
  "cedil", "macr", "uml", "ordf", "ordm", "laquo", "raquo", "iexcl", "iquest", "sup1",
  "sup2", "sup3", "frac14", "frac12", "frac34", "plusmn", "brvbar", "szlig",
]);

/**
 * Windows-1252 in numeric-reference clothing. `&#146;` is not a control
 * character, it is a right single quote from a document that thought it was
 * cp1252, and every browser decodes it that way.
 */
const CP1252 = {
  128: "€", 130: "‚", 131: "ƒ", 132: "„", 133: "…", 134: "†", 135: "‡", 136: "ˆ",
  137: "‰", 138: "Š", 139: "‹", 140: "Œ", 142: "Ž", 145: "‘", 146: "’", 147: "“",
  148: "”", 149: "•", 150: "–", 151: "—", 152: "˜", 153: "™", 154: "š", 155: "›",
  156: "œ", 158: "ž", 159: "Ÿ",
};

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

function htmlUnescape(text) {
  // The overwhelming majority of names contain no `&` at all, and this check is
  // what keeps decoding off the CPU bill for them.
  if (text.indexOf("&") === -1) return text;
  return text.replace(CHARREF, (whole, body) => {
    if (body[0] === "#") {
      const digits = body.replace(/;$/, "");
      const code = digits[1] === "x" || digits[1] === "X"
        ? parseInt(digits.slice(2), 16)
        : parseInt(digits.slice(1), 10);
      if (!Number.isFinite(code)) return whole;
      if (code === 0) return "\ufffd";
      if (CP1252[code]) return CP1252[code];
      if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return "\ufffd";
      return String.fromCodePoint(code);
    }
    // Longest match wins, exactly as a browser resolves them: `&notit;` is
    // `&not` followed by the literal text `it;`.
    const bare = body.replace(/;$/, "");
    if (body.endsWith(";") && ENTITIES[bare] !== undefined) return ENTITIES[bare];
    for (let length = bare.length; length > 1; length -= 1) {
      const candidate = bare.slice(0, length);
      if (ENTITIES[candidate] !== undefined && LEGACY_ENTITIES.has(candidate)) {
        return ENTITIES[candidate] + body.slice(length);
      }
    }
    return whole;
  });
}

/** A release name as a client should see it. */
function cleanName(value) {
  return htmlUnescape(String(value ?? "")).trim();
}

// --- feeds -----------------------------------------------------------------
//
// Workers have no DOMParser, and two engines answer in XML: nyaa's RSS and
// Torznab. Both are machine-generated and flat — a list of `<item>` elements
// whose children are leaves — so a scanner for exactly that shape is about
// eighty lines. A general XML library would be several thousand and would make
// this file unreadable, which defeats the point of shipping source.
//
// The one thing this does properly is namespaces: nyaa hangs the infohash and
// the swarm counts off its own namespace, and a feed is free to bind that to
// any prefix it likes, so the prefix is resolved from the document rather than
// assumed.

class FeedError extends Error {}

const OPEN_TAG = /<([A-Za-z_][A-Za-z0-9_.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTRIBUTE = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The prefix bound to *uri* in this document, or *fallback* if none is. */
function namespacePrefix(xml, uri, fallback) {
  const declaration = new RegExp(
    `xmlns:([A-Za-z_][A-Za-z0-9_.-]*)\\s*=\\s*["']${uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
  ).exec(xml);
  return declaration ? declaration[1] : fallback;
}

/** Every `<item>…</item>` block in the document, as raw inner text. */
function feedItems(xml) {
  if (!/^\s*(?:\ufeff)?</.test(xml)) throw new FeedError("not XML: no element found");
  // A bot challenge is an HTTP 200 with a page of HTML in it. Without this the
  // scanner simply finds no <item>, and the engine reports "answered with no
  // rows" \u2014 which is what an unpopular query looks like too. Being blocked and
  // being unlucky then read identically, and only one of them is worth acting on.
  if (!/<(?:rss|feed|channel)[\s>]/i.test(xml)) throw new FeedError("not a feed");
  const blocks = [];
  const open = /<item(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/g;
  let match;
  while ((match = open.exec(xml))) {
    const close = xml.indexOf("</item>", open.lastIndex);
    if (close === -1) break;
    blocks.push(xml.slice(open.lastIndex, close));
    open.lastIndex = close + 7;
  }
  return blocks;
}

/** The direct children of one item block, in document order. */
function feedChildren(block) {
  const children = [];
  OPEN_TAG.lastIndex = 0;
  let match;
  while ((match = OPEN_TAG.exec(block))) {
    const [, name, attributes, selfClosing] = match;
    if (selfClosing) {
      children.push({ name, attributes, text: "" });
      continue;
    }
    const close = block.indexOf(`</${name}>`, OPEN_TAG.lastIndex);
    if (close === -1) continue;
    children.push({ name, attributes, text: block.slice(OPEN_TAG.lastIndex, close) });
    OPEN_TAG.lastIndex = close + name.length + 3;
  }
  return children;
}

/** The text of the first child called *name*, XML-decoded. */
function childText(children, name) {
  const found = children.find((child) => child.name === name);
  return found ? xmlText(found.text) : null;
}

function attributesOf(element) {
  const found = {};
  ATTRIBUTE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE.exec(element.attributes || ""))) {
    found[match[1]] = xmlText(match[2] ?? match[3] ?? "");
  }
  return found;
}

/** CDATA out, the five XML entities and numeric references in. */
function xmlText(raw) {
  let text = raw;
  if (text.indexOf("<![CDATA[") !== -1) {
    text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  }
  if (text.indexOf("&") === -1) return text;
  return text.replace(/&(amp|lt|gt|quot|apos|#[0-9]+|#[xX][0-9a-fA-F]+);/g, (whole, body) => {
    switch (body) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: {
        const code = body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code > 0x10ffff) return whole;
        if (code >= 0xd800 && code <= 0xdfff) return whole;
        return String.fromCodePoint(code);
      }
    }
  });
}

// --- magnets and infohashes ------------------------------------------------

const HEX40 = /^[0-9a-fA-F]{40}$/;
const BASE32_32 = /^[A-Za-z2-7]{32}$/;
const BTIH = /urn:btih:([0-9A-Za-z]{32,40})/i;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * A lowercase 40-character hex infohash, or null.
 *
 * Accepts hex and base32, the two encodings BEP-9 magnets use in the wild.
 */
function normalizeInfohash(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (HEX40.test(value)) return value.toLowerCase();
  if (!BASE32_32.test(value)) return null;

  let bits = 0;
  let accumulator = 0;
  let hex = "";
  for (const character of value.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) return null;
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((accumulator >> bits) & 0xff).toString(16).padStart(2, "0");
      accumulator &= (1 << bits) - 1;
    }
  }
  return hex.length === 40 ? hex : null;
}

function infohashFromMagnet(magnet) {
  if (!magnet) return null;
  const match = BTIH.exec(magnet);
  return match ? normalizeInfohash(match[1]) : null;
}

/** The tracker tail never changes, so it is encoded once rather than per row. */
const TRACKER_SUFFIX = DEFAULT_TRACKERS.map((tracker) => "&tr=" + quote(tracker)).join("");

function magnetFor(infohash, name) {
  if (name) return `magnet:?xt=urn:btih:${infohash}&dn=${quote(name)}${TRACKER_SUFFIX}`;
  return `magnet:?xt=urn:btih:${infohash}${TRACKER_SUFFIX}`;
}

// --- bencode ---------------------------------------------------------------
//
// Just enough to read a `.torrent`, for the one case that needs it: a Torznab
// indexer that hands back a file rather than a magnet. Off unless
// UTSI_MAX_RESOLVE says otherwise.

function bdecode(data, index, depth = 0) {
  if (depth > 32) throw new Error("nesting too deep");
  if (index >= data.length) throw new Error("truncated");
  const marker = data[index];

  if (marker === 0x69) {
    // "i" — an integer, terminated by "e"
    const end = data.indexOf(0x65, index);
    if (end === -1) throw new Error("unterminated integer");
    return [Number(latin1(data, index + 1, end)), end + 1];
  }
  if (marker === 0x6c) {
    // "l" — a list
    const items = [];
    index += 1;
    while (data[index] !== 0x65) {
      const [value, next] = bdecode(data, index, depth + 1);
      items.push(value);
      index = next;
    }
    return [items, index + 1];
  }
  if (marker === 0x64) {
    // "d" — a dictionary, keys are byte strings
    const mapping = new Map();
    index += 1;
    while (data[index] !== 0x65) {
      const [key, afterKey] = bdecode(data, index, depth + 1);
      const [value, afterValue] = bdecode(data, afterKey, depth + 1);
      if (key instanceof Uint8Array) mapping.set(latin1(key, 0, key.length), value);
      index = afterValue;
    }
    return [mapping, index + 1];
  }
  if (marker >= 0x30 && marker <= 0x39) {
    // a byte string, "<length>:<bytes>"
    const colon = data.indexOf(0x3a, index);
    if (colon === -1) throw new Error("unterminated string");
    const length = Number(latin1(data, index, colon));
    const start = colon + 1;
    const end = start + length;
    if (!Number.isSafeInteger(length) || length < 0 || end > data.length) {
      throw new Error("bad string length");
    }
    return [data.subarray(start, end), end];
  }
  throw new Error(`unexpected byte ${marker} at ${index}`);
}

function latin1(bytes, start, end) {
  let out = "";
  for (let index = start; index < end; index += 1) out += String.fromCharCode(bytes[index]);
  return out;
}

function utf8(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Read a `.torrent`: v1 infohash, display name, total size, file count.
 *
 * The infohash is `sha1(bencode(info dict))`, taken over the *original* bytes of
 * the info dict rather than a re-encoding, so a file that round-trips
 * imperfectly still hashes correctly.
 */
async function parseTorrent(data) {
  if (!data.length || data[0] !== 0x64) return null;

  let index = 1;
  let infoSpan = null;
  const root = new Map();
  try {
    while (data[index] !== 0x65) {
      const [key, afterKey] = bdecode(data, index);
      const start = afterKey;
      const [value, afterValue] = bdecode(data, afterKey);
      if (key instanceof Uint8Array) {
        const name = latin1(key, 0, key.length);
        root.set(name, value);
        if (name === "info") infoSpan = [start, afterValue];
      }
      index = afterValue;
    }
  } catch {
    return null;
  }

  const info = root.get("info");
  if (!infoSpan || !(info instanceof Map)) return null;

  const digest = await crypto.subtle.digest("SHA-1", data.subarray(infoSpan[0], infoSpan[1]));
  const infohash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  let size = null;
  let files = null;
  const length = info.get("length");
  if (typeof length === "number") {
    size = length;
    files = 1;
  } else {
    const entries = info.get("files");
    if (Array.isArray(entries)) {
      const sizes = entries
        .filter((entry) => entry instanceof Map && typeof entry.get("length") === "number")
        .map((entry) => entry.get("length"));
      if (sizes.length) {
        size = sizes.reduce((total, one) => total + one, 0);
        files = entries.length;
      }
    }
  }

  const name = info.get("name");
  return {
    infohash,
    name: name instanceof Uint8Array ? utf8(name) : null,
    sizeBytes: size,
    files,
  };
}

// --- timing ----------------------------------------------------------------

const TIMED_OUT = Symbol("timed out");

/**
 * *promise*, or TIMED_OUT once *ms* have passed.
 *
 * The work behind a lost race is not cancelled here — every `fetch` this Worker
 * makes carries its own AbortSignal with the same budget, so the socket closes
 * at the same moment and nothing is left running.
 */
function raceTimeout(promise, ms) {
  let timer;
  const alarm = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, alarm]).finally(() => clearTimeout(timer));
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. RELEASE NAMES
// ═══════════════════════════════════════════════════════════════════════════
//
// No index supplies `year`, `resolution`, `codec`, `source`, `season` or
// `episode`. The release name is the only place they exist, so this section is
// the sole source for those six fields, and every value is normalised to a
// stable token: a client filtering on `res=1080p` matches whether the name said
// `1080p`, `FHD` or `1920x1080`.

/** The six fields, in the order they are emitted. */
const META_FIELDS = ["year", "resolution", "codec", "source", "season", "episode"];

/**
 * A word character, as a regular expression sees it *in Python*: letters,
 * numbers and underscore from every script, not just ASCII.
 *
 * JavaScript's own `\b` and `\w` stop at ASCII, so `\bx264\b` matches inside a
 * Japanese title where Python's would not. Every pattern below is written with
 * `\b` and compiled through `pattern()`, which expands it into a boundary that
 * behaves the way the local server's does — so both implementations classify
 * the same name the same way.
 */
const WORD = "[\\p{L}\\p{N}_]";
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

function pattern(source, flags = "") {
  return new RegExp(source.split("\\b").join(BOUNDARY), flags + "u");
}

/** Separator characters TSP calls out, plus the bracketing scene names use. */
const SEPARATORS = /[._\-+()[\]{},]+/gu;

const RESOLUTION_PATTERNS = [
  ["2160p", pattern("\\b(2160p|4k|uhd|3840\\s?x\\s?2160)\\b", "i")],
  ["1080p", pattern("\\b(1080[pi]|fhd|1920\\s?x\\s?1080)\\b", "i")],
  ["720p", pattern("\\b(720p|hd\\s?ready|1280\\s?x\\s?720)\\b", "i")],
  ["480p", pattern("\\b(480[pi]|sd|640\\s?x\\s?480|854\\s?x\\s?480)\\b", "i")],
];

const CODEC_PATTERNS = [
  ["x265", pattern("\\b(x265|h\\s?265|hevc)\\b", "i")],
  ["x264", pattern("\\b(x264|h\\s?264|avc)\\b", "i")],
  ["av1", pattern("\\bav1\\b", "i")],
  ["vp9", pattern("\\bvp9\\b", "i")],
  ["xvid", pattern("\\bxvid\\b", "i")],
  ["divx", pattern("\\bdivx\\b", "i")],
  ["mpeg2", pattern("\\b(mpeg\\s?2|mpeg2video)\\b", "i")],
];

// Longest/most specific first: "bdremux" must win over "bdrip", "web-dl" over
// "web".
const SOURCE_PATTERNS = [
  ["remux", pattern("\\b(remux|bd\\s?remux|bdmux)\\b", "i")],
  ["bluray", pattern("\\b(blu\\s?ray|bluray|bd\\s?rip|bdrip|br\\s?rip|brrip|bd\\s?25|bd\\s?50)\\b", "i")],
  ["web-dl", pattern("\\b(web\\s?dl|webdl)\\b", "i")],
  ["webrip", pattern("\\b(web\\s?rip|webrip|web)\\b", "i")],
  ["hdtv", pattern("\\b(hd\\s?tv|hdtv|pdtv|dsr)\\b", "i")],
  ["dvd", pattern("\\b(dvd\\s?rip|dvdrip|dvd\\s?r|dvd5|dvd9|dvd)\\b", "i")],
  ["hdrip", pattern("\\b(hd\\s?rip|hdrip)\\b", "i")],
  ["screener", pattern("\\b(dvd\\s?scr|screener|scr)\\b", "i")],
  ["telesync", pattern("\\b(telesync|hd\\s?ts|ts)\\b", "i")],
  ["cam", pattern("\\b(cam\\s?rip|camrip|hd\\s?cam|cam)\\b", "i")],
];

const YEAR = pattern("\\b(19[0-9]{2}|20[0-9]{2})\\b", "g");

const SEASON_EPISODE = pattern("\\bs\\s?(\\d{1,2})\\s?e\\s?(\\d{1,3})(?:\\s?-\\s?e?\\d{1,3})?\\b", "i");
const SEASON_X_EPISODE = pattern("\\b(\\d{1,2})x(\\d{2,3})\\b");
const SEASON_ONLY = pattern("\\b(?:season|series)\\s?(\\d{1,2})\\b|\\bs\\s?(\\d{1,2})\\b(?!\\s?e\\d)", "i");
const EPISODE_ONLY = pattern("\\b(?:episode|ep)\\s?(\\d{1,3})\\b", "i");

/**
 * A year is only a *release* year if it precedes one of these markers; that is
 * what separates `2012.2009.1080p` (a film called "2012", released 2009) from a
 * title that merely contains a number.
 */
const QUALITY_MARKER = pattern(
  "\\b(2160p|1080[pi]|720p|480[pi]|4k|uhd|x26[45]|h\\s?26[45]|hevc|avc|xvid|divx|av1" +
    "|blu\\s?ray|bluray|bd\\s?rip|bdrip|br\\s?rip|web\\s?dl|webdl|web\\s?rip|webrip|hd\\s?tv|hdtv" +
    "|dvd\\s?rip|dvdrip|remux|complete|multi|proper|repack|extended|unrated|imax)\\b",
  "i",
);

/** Turn scene punctuation into spaces so the word boundaries behave. */
function normalizeSeparators(name) {
  return name.replace(SEPARATORS, " ");
}

/**
 * The canonical token whose pattern matches earliest in *text*.
 *
 * Scanning by position rather than by rule order keeps `WEB-DL` from losing to a
 * stray `TS` later in the name, while the ordering within equal positions still
 * favours the more specific rule.
 */
function firstMatch(text, patterns) {
  let bestAt = -1;
  let bestToken = "";
  for (const [token, regexp] of patterns) {
    const match = regexp.exec(text);
    if (match && (bestAt === -1 || match.index < bestAt)) {
      bestAt = match.index;
      bestToken = token;
    }
  }
  return bestToken;
}

function pickYear(text) {
  const horizon = new Date().getUTCFullYear() + 1;
  const plausible = [];
  YEAR.lastIndex = 0;
  let match;
  while ((match = YEAR.exec(text))) {
    const value = Number(match[1]);
    if (value >= 1900 && value <= horizon) {
      plausible.push({ value: match[1], start: match.index, end: match.index + match[1].length });
    }
  }
  if (!plausible.length) return "";
  if (plausible.length === 1) return plausible[0].value;

  const marker = QUALITY_MARKER.exec(text);
  if (marker) {
    const before = plausible.filter((candidate) => candidate.end <= marker.index);
    if (before.length) return before[before.length - 1].value;
  }
  return plausible[plausible.length - 1].value;
}

function pickSeasonEpisode(text) {
  const paired = SEASON_EPISODE.exec(text) || SEASON_X_EPISODE.exec(text);
  if (paired) return [pad2(Number(paired[1])), pad2(Number(paired[2]))];

  let season = "";
  const seasonMatch = SEASON_ONLY.exec(text);
  if (seasonMatch) {
    const raw = seasonMatch[1] || seasonMatch[2];
    if (raw) season = pad2(Number(raw));
  }

  let episode = "";
  const episodeMatch = EPISODE_ONLY.exec(text);
  if (episodeMatch) episode = pad2(Number(episodeMatch[1]));

  return [season, episode];
}

/** The six TSP metadata fields a release name can carry. Absent ones omitted. */
function parseName(name) {
  if (!name) return {};
  const text = normalizeSeparators(name);
  const [season, episode] = pickSeasonEpisode(text);
  const found = {
    year: pickYear(text),
    resolution: firstMatch(text, RESOLUTION_PATTERNS),
    codec: firstMatch(text, CODEC_PATTERNS),
    source: firstMatch(text, SOURCE_PATTERNS),
    season,
    episode,
  };
  const meta = {};
  for (const field of META_FIELDS) if (found[field]) meta[field] = found[field];
  return meta;
}

/**
 * TSP's query rules: `.`, `_` and `-` are separators.
 *
 * Word order is irrelevant to TSP, so this only collapses separators and
 * whitespace; the index decides how to match the terms.
 */
function normalizeQuery(query) {
  return normalizeSeparators(query).split(/\s+/u).filter(Boolean).join(" ");
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════

const EXTENSION = /\.([a-z0-9]{2,5})$/iu;

const EXTENSION_CATEGORY = {
  mkv: "video", mp4: "video", avi: "video", mov: "video", m4v: "video",
  wmv: "video", mpg: "video", mpeg: "video", flv: "video", webm: "video",
  mp3: "audio", flac: "audio", wav: "audio", aac: "audio", ogg: "audio",
  m4a: "audio", opus: "audio", alac: "audio", wma: "audio", ape: "audio",
  pdf: "document", epub: "document", mobi: "document", azw3: "document",
  djvu: "document", cbr: "document", cbz: "document", chm: "document",
  jpg: "image", jpeg: "image", png: "image", gif: "image", bmp: "image",
  tiff: "image", webp: "image", psd: "image", svg: "image",
  exe: "software", msi: "software", dmg: "software", apk: "software",
  deb: "software", rpm: "software", pkg: "software", appimage: "software",
  rar: "archive", zip: "archive", "7z": "archive", tar: "archive",
  gz: "archive", bz2: "archive", xz: "archive", tgz: "archive",
};

/**
 * Ordered rules: the first family with a hit wins. Video markers come first
 * because scene video names are the most distinctive, and because a game or an
 * application essentially never carries a resolution or an SxxEyy tag.
 */
const CLASSIFY_RULES = [
  [
    "video",
    pattern(
      "\\b(" +
        "2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?|dolby[. _-]?vision" +
        "|x26[45]|h[. _-]?26[45]|hevc|avc|xvid|divx|av1" +
        "|blu[. _-]?ray|bd(?:rip|remux|mux)|br[. _-]?rip|web[. _-]?(?:dl|rip)" +
        "|hd(?:tv|rip|cam)|dvd(?:rip|scr|r)?|remux|telesync|cam[. _-]?rip" +
        "|s\\d{1,2}[. _-]?e\\d{1,3}|\\d{1,2}x\\d{2}|season[. _-]?\\d{1,2}" +
        "|complete[. _-]series|episode[. _-]?\\d{1,3}" +
        "|dts(?:[. _-]?hd)?|ddp?\\d[. _-]?\\d|aac\\d[. _-]?\\d|truehd|atmos" +
        ")\\b",
      "i",
    ),
  ],
  [
    "audio",
    pattern(
      "\\b(" +
        "flac|mp3|aac|alac|ogg|opus|wav|ape|dsd" +
        "|\\d{2,3}\\s?kbps|v0|v2|cbr|vbr" +
        "|discography|anthology|album|ep|single|soundtrack|ost|bootleg" +
        "|audiobook|audio[. _-]?book|vinyl|cd[. _-]?(?:rip|q|da)|web[. _-]?flac" +
        ")\\b",
      "i",
    ),
  ],
  [
    "software",
    pattern(
      "\\b(" +
        "x64|x86|win(?:32|64|dows)?|macos|osx|linux|ubuntu|debian|fedora|arch" +
        "|v\\d+(?:\\.\\d+)+|build[. _-]?\\d+|portable|multilingual|activated" +
        "|crack(?:ed|fix)?|keygen|patch|repack|pre[. _-]?activated|iso" +
        "|fitgirl|dodi|codex|plaza|skidrow|reloaded|empress|razor1911|tenoke" +
        "|gog|steam|denuvo|update[. _-]?only|dlc" +
        ")\\b",
      "i",
    ),
  ],
  [
    "document",
    pattern(
      "\\b(" +
        "ebook|e[. _-]?book|epub|pdf|mobi|azw3|retail|magazine|comics?|manga" +
        "|\\d(?:st|nd|rd|th)[. _-]?edition|textbook|novel|paperback" +
        ")\\b",
      "i",
    ),
  ],
  [
    "image",
    pattern(
      "\\b(wallpapers?|imageset|image[. _-]?pack|photos?|pics|pictures|artwork" +
        "|hi[. _-]?res[. _-]?scans)\\b",
      "i",
    ),
  ],
  ["archive", pattern("\\b(rar|zip|7z|tar|tgz|gz|bz2|xz)\\b", "i")],
];

/**
 * Best-effort TSP category for a release name, or null if unreadable.
 *
 * Null means "no idea", which is not the same as "no". Every rule here keys off
 * a technical marker — a resolution, a codec, a format — and a great many real
 * releases carry none: "Big Buck Bunny", a bare title and a year, most of what a
 * DHT crawl returns. Callers filtering by category must keep those, because
 * dropping them makes a filter delete correct answers rather than narrow them.
 */
function classifyName(name) {
  if (!name) return null;
  const extension = EXTENSION.exec(name.trim());
  if (extension) {
    const category = EXTENSION_CATEGORY[extension[1].toLowerCase()];
    if (category) return category;
  }
  for (const [category, regexp] of CLASSIFY_RULES) {
    if (regexp.test(name)) return category;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. ENGINES
// ═══════════════════════════════════════════════════════════════════════════
//
// No third-party code runs in this Worker. That is not a stylistic choice, it is
// forced: a Worker has no subprocesses and no resource limits, so the sandbox
// that makes it acceptable to run a hundred strangers' scripts on your own
// machine does not exist here. Running them in-process would mean handing them
// the same isolate that holds your API key. The alternative is what this section
// does — a short adapter per index, written here, reviewable in one sitting.
//
// That costs coverage. Sites behind bot protection treat data-centre addresses
// as suspicious, so the HTML-scraping plugins that make up most of the project's
// registry answer poorly from a rented address and not at all from some. What
// survives at the edge is what these adapters use: indexes with a real
// structured API, plus knaben, a meta-index that has already crawled the sites
// this Worker cannot. Whether any of them answers from *your* Worker is an
// empirical question with a built-in answer — `/api/v1/engines?probe=1`.
//
// `upstream` is the exception, and it is the one that gets the breadth back: it
// is not a site but another TSP index, in practice a `./start.sh` instance of
// this project running the hundred plugins from an address the sites will
// actually talk to.
//
// Each adapter is `async (http, query, settings) -> Row[]` and swallows nothing:
// a thrown error is caught by the fan-out and reported as an engine failure,
// which is more useful than an empty list.
//
// One rule with no exceptions: **public indexes receive no credentials.**
// `getJson` sends no authorization of any kind. Only `upstream` and `fallback`
// (an `X-API-Key` header) and `torznab` (a query parameter) carry a key, and
// each of those points at a server the deployer runs themselves.

class EngineError extends Error {
  name = "EngineError";
}

/**
 * Ask each of *engineId*'s addresses in turn and return the first answer.
 *
 * "Answer" means a 200. A transport failure or any other status moves to the
 * next address, because that is what a moved domain looks like from here — DNS
 * that does not resolve, a connection refused, or a 5xx from a host that used to
 * be the site. A 200 that then fails to parse is *not* retried: the site is
 * alive and the adapter is wrong, and asking a mirror the same question would
 * only be wrong twice.
 *
 * Each attempt gets the engine's full budget rather than a slice of it, so the
 * healthy first-address case is never slower than having no fallback at all. The
 * fan-out's own per-engine timeout is what bounds the pathological case.
 */
async function askOrigins(engineId, settings, attempt) {
  const origins = originsFor(engineId, settings);
  if (!origins.length) throw new EngineError(`no address for ${engineId}`);

  // The *first* address's complaint is the one reported, not the last. It is the
  // address the operator chose or the project recommends, so "HTTP 403" from it
  // is the fact worth acting on; that three mirrors also declined is a detail.
  let firstError = null;
  for (const origin of origins) {
    try {
      const result = await attempt(origin.url);
      LIVENESS.origin(engineId, origin);
      return result;
    } catch (thrown) {
      // Normalised first: a transport failure is not thrown by this file, and
      // before it was translated it slipped past the test below and cost the
      // engine every address after this one.
      const failure = asEngineError(thrown);
      if (!(failure instanceof UnreachableError)) {
        LIVENESS.origin(engineId, origin);
        throw failure;
      }
      firstError = firstError || failure;
    }
  }
  const complaint = firstError ? firstError.message : "no address answered";
  throw new EngineError(
    origins.length > 1 ? `${complaint} (${origins.length} addresses tried)` : complaint,
  );
}

/** A host that did not answer at all, or answered with something that is not a 200. */
class UnreachableError extends EngineError {
  name = "UnreachableError";
}

/**
 * A host saying "not so often" — alive, working, and declining *this* caller.
 *
 * Subclasses UnreachableError so a second address is still tried, since a mirror
 * is counted separately. What it changes is the reporting: a 429 and a 503 need
 * opposite repairs. Down is fixed by waiting or by another address; throttled is
 * fixed by asking less, and changing address cannot help. Knaben published a
 * temporary one-request-per-two-seconds limit after a 25-million-request day,
 * and a Worker fanning out on every search is the shape of caller that meets it.
 */
class RateLimitedError extends UnreachableError {
  name = "RateLimitedError";
}

/** The right complaint for a status that is not 200. */
function statusError(status) {
  return status === 429 ? new RateLimitedError("rate limited (HTTP 429)") : new UnreachableError(`HTTP ${status}`);
}

/**
 * Whatever was thrown, as one of this file's errors.
 *
 * `fetch()` does not always reject with something we made: a name that no longer
 * resolves arrives as a bare `TypeError`, and the abort signal firing as a
 * `TimeoutError`. Neither is an `UnreachableError`, so until they were translated
 * here they slipped past `askOrigins`'s filter and were re-thrown, leaving the
 * second address untried in exactly the case the list exists for — a deleted
 * domain is that case.
 *
 * A dead host and a live host answering 500 both mean "ask the next address".
 * Only an `EngineError` proper — the site answered, the adapter could not read it
 * — stays as it is, since asking a mirror would only be wrong twice.
 */
function asEngineError(thrown) {
  if (thrown instanceof EngineError) return thrown;
  const name = thrown && thrown.name ? String(thrown.name) : "Error";
  const detail = thrown && thrown.message ? String(thrown.message) : String(thrown);
  // `AbortError` is what older runtimes call it; Workers and Node 22 say
  // `TimeoutError` for the same event.
  if (name === "TimeoutError" || name === "AbortError") {
    return new UnreachableError("no answer before the timeout");
  }
  return new UnreachableError(`${name}: ${detail}`);
}

/** GET *url* and parse JSON, or say precisely which of those failed. */
async function getJson(http, url, settings, engineId, headers = null) {
  const [status, body] = await http.text(url, {
    timeout: timeoutFor(settings, engineId),
    headers,
  });
  if (status !== 200) throw statusError(status);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new EngineError(`not JSON: ${error.message}`);
  }
}

// --- another TSP index, usually your own ------------------------------------

/**
 * Turn 401/403 from an upstream index into the thing to go and check.
 *
 * The two are not the same complaint, and this project answers them precisely:
 * 401 means no `X-API-Key` header arrived at all, 403 means one arrived and did
 * not match. Reporting a bare "HTTP 401" throws that away and leaves three
 * unrelated causes looking identical.
 */
function upstreamAuthError(status, sentAKey) {
  if (status === 403) {
    return (
      "your index rejected the key — UTSI_UPSTREAM_APIKEY does not match what it " +
      "expects. It prints the key on start and keeps it in .utsi/api-key; a fresh " +
      "state directory means a fresh key."
    );
  }
  if (!sentAKey) {
    return (
      "your index requires a key and UTSI_UPSTREAM_APIKEY is not set. Add it as a " +
      "secret, or run that index with UTSI_ALLOW_ANONYMOUS=1 if it is not reachable " +
      "from anywhere else."
    );
  }
  return (
    "this Worker sent a key and your index saw none, which is a header going missing " +
    "between them rather than a wrong key — something in front of it is dropping " +
    "X-API-Key, or UTSI_UPSTREAM_APIKEY is set to an empty value."
  );
}

/**
 * Ask a TSP index and pass its rows straight through.
 *
 * Shared by `upstream` and `fallback`, which differ in where they point and when
 * they are called, not in what comes back.
 *
 * The filters travel with the query rather than being applied here: the far side
 * can cut before it counts against `maxRowsPerEngine`, so `cat=video` on a
 * hundred-row cap returns a hundred video rows instead of a hundred mixed ones —
 * more relevant results *and* less CPU, which is the rare pairing.
 */
async function tspIndex(http, query, settings, engineId, origin, apikey) {
  const params = { q: query.terms, limit: String(Math.min(settings.maxRowsPerEngine, 200)) };
  // Not `sort`: this Worker re-sorts the merged set anyway. Not `offset`: paging
  // happens locally, over every engine at once.
  for (const [name, value] of [
    ["cat", query.cat],
    ["year", query.year],
    ["res", query.res],
    ["min_seeders", query.minSeeders ? String(query.minSeeders) : ""],
  ]) {
    if (value) params[name] = value;
  }

  const url = `${origin}/api/v1/search?${urlencode(params)}`;
  const [status, body] = await http.text(url, {
    timeout: timeoutFor(settings, engineId),
    headers: apikey ? { "X-API-Key": apikey } : null,
  });
  if (status === 401 || status === 403) throw new EngineError(upstreamAuthError(status, !!apikey));
  // Your own index can throttle you too — Prowlarr does — and it is worth
  // naming, since it is the one failure here that is not about the address.
  if (status !== 200) throw status === 429 ? statusError(status) : new EngineError(`HTTP ${status}`);

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new EngineError(`not JSON: ${error.message}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new EngineError("expected a TSP search result object");
  }

  const rows = [];
  for (const item of (payload.torrents || []).slice(0, settings.maxRowsPerEngine)) {
    if (!item || typeof item !== "object") continue;
    const magnet = String(item.magnet || "");
    const infohash = normalizeInfohash(String(item.infohash || "")) || infohashFromMagnet(magnet);
    const name = cleanName(item.name);
    if (!infohash || !name) continue;

    // The far side ran the same name parser this file carries, so its six
    // name-derived fields are the ones we would have computed. Seeding them
    // skips the most expensive step in the pipeline. When it sends none — an
    // older build, or a name with nothing in it — this stays null and the row is
    // parsed locally like any other.
    const meta = {};
    for (const field of META_FIELDS) if (item[field]) meta[field] = String(item[field]);

    // `sources` names the plugins that found it over there. Prefixing keeps that
    // provenance without it being mistaken for one of ours.
    const sources = (item.sources || []).filter(Boolean).map((source) => `${engineId}/${source}`);

    rows.push({
      name,
      engineId,
      infohash,
      torrentUrl: String(item.torrent_url || "") || null,
      sizeBytes: intOrNone(item.size_bytes),
      files: intOrNone(item.files),
      seeders: intOrNone(item.seeders),
      leechers: intOrNone(item.leechers),
      category: String(item.category || "") || null,
      firstSeen: String(item.first_seen || "") || null,
      descriptionUrl: String(item.description_url || "") || null,
      sources: sources.length ? sources : [engineId],
      meta: Object.keys(meta).length ? meta : null,
    });
  }
  return rows;
}

/**
 * Ask another TSP index and pass its rows straight through.
 *
 * This is the engine that gets the breadth back. A `./start.sh` instance reaches
 * the sites from an address they will answer — a home connection, or a machine
 * with UTSI_SOCKS_PROXY set so requests leave through one — and runs the hundred
 * plugins inside the sandbox a Worker cannot provide. The Worker in front of it
 * is then a fixed, always-up URL that survives that machine going to sleep,
 * because whatever else is configured still answers.
 */
async function upstream(http, query, settings) {
  if (!settings.upstreamUrl) throw new EngineError("UTSI_UPSTREAM_URL is not set");
  return tspIndex(http, query, settings, "upstream", settings.upstreamUrl, settings.upstreamApikey);
}

/**
 * The last resort: one more index, asked only when everything found nothing.
 *
 * Never part of the fan-out. `search()` reaches it on one condition — every
 * engine that did run came back with nothing — so an ordinary search never
 * touches it and the address it points at carries only the queries the chosen
 * engines could not answer.
 *
 * No address ships with this project. It stays dark until UTSI_FALLBACK_URL
 * points it at an index of your own, typically one too slow, too far or too
 * rate-limited to sit in the fan-out proper. It failing is not an error, just
 * the same empty answer arriving a moment later.
 */
async function fallback(http, query, settings) {
  if (!settings.fallbackUrl) throw new EngineError("UTSI_FALLBACK_URL is not set");
  return tspIndex(http, query, settings, "fallback", settings.fallbackUrl, settings.fallbackApikey);
}

// --- YTS ---------------------------------------------------------------------

/**
 * Films only, but every row is a clean release with a real infohash.
 *
 * One film carries several torrents, so the release name is rebuilt from the
 * fields the API splits apart — `parseName()` then reads resolution and source
 * back out of it exactly as it would for any other name.
 */
async function yts(http, query, settings) {
  const limit = Math.min(settings.maxRowsPerEngine, 50);
  const payload = await askOrigins("yts", settings, (origin) =>
    getJson(
      http,
      `${origin}/api/v2/list_movies.json?query_term=${quotePlus(query.terms)}&limit=${limit}`,
      settings,
      "yts",
    ),
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new EngineError("expected a JSON object");
  }

  const data = payload.data;
  const movies = data && typeof data === "object" ? data.movies : null;
  // The API omits `movies` entirely when nothing matched, rather than sending an
  // empty list.
  if (!movies || !movies.length) return [];

  const rows = [];
  for (const movie of movies) {
    if (!movie || typeof movie !== "object" || rows.length >= settings.maxRowsPerEngine) break;
    const title = cleanName(movie.title_long || movie.title);
    const page = String(movie.url || "").trim() || null;
    for (const torrent of movie.torrents || []) {
      if (!torrent || typeof torrent !== "object" || rows.length >= settings.maxRowsPerEngine) break;
      const infohash = normalizeInfohash(String(torrent.hash || ""));
      if (!infohash || !title) continue;
      const parts = [
        title,
        String(torrent.quality || "").trim(),
        String(torrent.type || "").trim(),
        String(torrent.video_codec || "").trim(),
        "YTS",
      ].filter(Boolean);
      rows.push({
        name: parts.join(" "),
        engineId: "yts",
        infohash,
        torrentUrl: null,
        sizeBytes: intOrNone(torrent.size_bytes),
        files: null,
        seeders: intOrNone(torrent.seeds),
        leechers: intOrNone(torrent.peers),
        category: "video",
        firstSeen: firstSeen(torrent.date_uploaded_unix),
        descriptionUrl: page,
        sources: ["yts"],
        meta: null,
      });
    }
  }
  return rows;
}

// --- apibay's "found nothing" sentinel ---------------------------------------

/**
 * apibay's "found nothing" is one row of zeroes, not an empty list: a single
 * hit named "No results returned" with forty zeroes for an infohash. Taken at
 * face value it is a torrent, and would be handed to a client as a magnet
 * pointing at nothing. Generalised into a row invariant for every descriptor
 * engine: an all-zero infohash is never a torrent, whoever sends it.
 */
const EMPTY_INFOHASH = "0000000000000000000000000000000000000000";

// --- sizes that arrive as text -----------------------------------------------

const NYAA_NS = "https://nyaa.si/xmlns/nyaa";

/** Some feeds report size as text — "1.4 GiB" — so the units come back to bytes. */
const SIZE_UNITS = {
  b: 1, bytes: 1,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4,
};

function humanSize(value) {
  const parts = String(value ?? "").trim().split(/\s+/u).filter(Boolean);
  if (parts.length !== 2) return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(parts[0])) return null;
  const number = Number(parts[0]);
  const unit = SIZE_UNITS[parts[1].toLowerCase()];
  return unit && number >= 0 ? Math.trunc(number * unit) : null;
}

// --- Torznab (Jackett, Prowlarr, NZBHydra) -----------------------------------

const TORZNAB_NS = "http://torznab.com/schemas/2015/feed";

/**
 * Torznab reports `peers` as seeders *plus* leechers, so subtract. Some indexers
 * send `leechers` directly instead; prefer the explicit one.
 */
function torznabLeechers(attrs, seeders) {
  const explicit = intOrNone(attrs.leechers);
  if (explicit !== null) return explicit;
  const peers = intOrNone(attrs.peers);
  if (peers === null) return null;
  return seeders !== null ? Math.max(0, peers - seeders) : peers;
}

/**
 * Read a Torznab `<rss>` feed into rows.
 *
 * Split out from the fetch so the shape can be tested without a Jackett. Rows
 * with neither a magnet nor an infohash attribute keep their `.torrent` URL and
 * are resolved later, if UTSI_MAX_RESOLVE allows it; TSP requires a magnet on
 * every row, so anything still unresolved at the end is dropped.
 */
function parseTorznab(xml, limit, engineId = "torznab") {
  let blocks;
  try {
    blocks = feedItems(xml);
  } catch (error) {
    throw new EngineError(`not XML: ${error.message}`);
  }
  const prefix = namespacePrefix(xml, TORZNAB_NS, "torznab");

  const rows = [];
  for (const block of blocks) {
    if (rows.length >= limit) break;
    const children = feedChildren(block);
    const name = cleanName(childText(children, "title"));
    if (!name) continue;

    const attrs = {};
    for (const child of children) {
      if (child.name !== `${prefix}:attr`) continue;
      const found = attributesOf(child);
      if (found.name) attrs[found.name.toLowerCase()] = found.value || "";
    }

    let magnet = attrs.magneturl || "";
    const link = (childText(children, "link") || "").trim();
    if (!magnet && link.toLowerCase().startsWith("magnet:")) magnet = link;

    const infohash = normalizeInfohash(attrs.infohash || "") || infohashFromMagnet(magnet);
    const torrentUrl = magnet ? null : link || null;
    if (!infohash && !torrentUrl) continue;

    const seeders = intOrNone(attrs.seeders);
    rows.push({
      name,
      engineId,
      infohash,
      torrentUrl,
      // `||` rather than `??` on purpose, and the local server agrees: a size of
      // zero is an indexer saying nothing useful, not a zero-byte torrent.
      sizeBytes: intOrNone(childText(children, "size")) || intOrNone(attrs.size),
      files: intOrNone(attrs.files),
      seeders,
      leechers: torznabLeechers(attrs, seeders),
      category: null,
      firstSeen: pubDate(childText(children, "pubDate")),
      descriptionUrl: (childText(children, "comments") || "").trim() || null,
      sources: [engineId],
      meta: null,
    });
  }
  return rows;
}

/**
 * Whatever the caller's own Jackett, Prowlarr or NZBHydra is indexing.
 *
 * Like `upstream`, the indexers run at an address of the caller's own and this
 * Worker only reads the feed. Reach for it when what you run is a Jackett rather
 * than an instance of this project. Its base URL is not in ENGINE_ORIGINS and
 * never will be: it is your address, and guessing a fallback for it would mean
 * sending your queries and your key somewhere you did not name.
 */
async function torznab(http, query, settings) {
  if (!settings.torznabUrl) throw new EngineError("UTSI_TORZNAB_URL is not set");

  const params = {
    t: "search",
    q: query.terms,
    limit: String(Math.min(settings.maxRowsPerEngine, 100)),
  };
  if (settings.torznabApikey) params.apikey = settings.torznabApikey;
  const joiner = settings.torznabUrl.includes("?") ? "&" : "?";

  const [status, body] = await http.text(`${settings.torznabUrl}${joiner}${urlencode(params)}`, {
    timeout: timeoutFor(settings, "torznab"),
  });
  if (status !== 200) throw status === 429 ? statusError(status) : new EngineError(`HTTP ${status}`);
  return parseTorznab(body, settings.maxRowsPerEngine);
}

// --- TGP: engines as data ----------------------------------------------------
//
// Every public JSON and RSS index above used to be a hand-written adapter, and
// a deployed copy of this file froze all of them at paste time. They are now
// *descriptors* — data, not code: where to ask, where the rows are, and which
// field of theirs feeds which TSP field. The compiled-in set below reproduces
// the old adapters byte for byte (the golden tests hold that line), and the
// same schema is what the signed feed carries, which is how a pasted Worker
// learns a new address or a renamed field without being pasted again.
//
// The expression language is deliberately not a language: JSON forms only.
//
//   "a.b"                          one path into the row
//   ["a", "b.c"]                   alternation — first value present wins
//   {"from": "a", ...}             a path with one annotation:
//       "unit": "kib|mib|gib"        the number is in that unit, not bytes
//       "nonzero": true              this site sends 0 for "not recorded"
//       "map": {...}, "prefix": 1    a finite lookup table (categories)
//       "template": "https://...{value}"  build a URL from one row value
//   {"const": "video"}             the same value for every row
//
// Paths are dot-separated keys; `^.` steps to the parent scope inside nested
// rows; `[]` in a `rows` path (at most twice) walks into an array. There are no
// conditionals, no loops, no arithmetic beyond `unit`, no regex, and no way to
// reference another field — a source that needs any of those goes behind a
// `kind: tsp` bridge instead of growing the language.
//
// The descriptor says only *where* a value is, never *how* to convert it: the
// TSP row schema fixes each target's type, and the coercions route through the
// same helpers the adapters used, which is what keeps the output identical.
// Every coercion is total — it returns a value or "absent", never throws, never
// invents a default — and absent survives to the wire as an omitted key, never
// as 0 or null. A missing seeder count and a count of nought are different
// facts, and conflating them would sink every row of an engine that stopped
// reporting seeders to the bottom of every sorted page.

const TGP_VERSION = 1;
const TGP_KINDS = new Set(["tsp", "torznab", "json", "rss"]);
const TGP_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TGP_UNITS = { kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };
const TGP_TARGETS = new Set([
  "name", "infohash", "magnet", "size_bytes", "files", "seeders", "leechers",
  "category", "first_seen", "torrent_url", "description_url",
]);

/**
 * Engine names the feed may never supply. Each is an engine that carries an
 * operator's credential or points at an operator's own machine, and a feed
 * entry must never become a destination that receives either.
 */
const RESERVED_ENGINE_NAMES = new Set(["upstream", "fallback", "torznab"]);

/** `""`, null, undefined and a missing key are all the same fact: no value. */
function isAbsent(value) {
  return value === null || value === undefined || value === "";
}

/**
 * Walk *path* down a scope chain (innermost first). `^.` steps outward one
 * scope; only own properties are followed, so a hostile key like `constructor`
 * finds nothing rather than a function.
 */
function resolvePath(scopes, path) {
  let depth = 0;
  let rest = path;
  while (rest.startsWith("^.")) {
    depth += 1;
    rest = rest.slice(2);
  }
  let value = scopes[depth];
  if (value === undefined) return undefined;
  if (rest === "") return value;
  for (const segment of rest.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

/** One field expression, whatever JSON form it was written in, normalised. */
function readExpr(expr) {
  if (typeof expr === "string") return { alternatives: [expr] };
  if (Array.isArray(expr)) return { alternatives: expr };
  if (expr && typeof expr === "object") {
    if (expr.const !== undefined) return { alternatives: [], constant: String(expr.const) };
    const from = expr.from;
    return {
      alternatives: typeof from === "string" ? [from] : Array.isArray(from) ? from : [],
      unit: expr.unit,
      nonzero: !!expr.nonzero,
      map: expr.map,
      prefix: expr.prefix,
      template: expr.template,
    };
  }
  return { alternatives: [] };
}

/**
 * Coerce one raw value to its TSP target type, or absent. Total by
 * construction: every branch routes through a helper that already answers
 * "no value" rather than throwing, returning NaN, or inventing a default.
 */
function coerceValue(target, value, spec) {
  switch (target) {
    case "name": {
      return cleanName(value) || null;
    }
    case "infohash": {
      const text = String(value).trim();
      return normalizeInfohash(text) || infohashFromMagnet(text);
    }
    case "size_bytes":
    case "files":
    case "seeders":
    case "leechers": {
      if (spec.unit) {
        const text = String(value).trim();
        if (!/^(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
        const bytes = Math.trunc(Number(text) * (TGP_UNITS[spec.unit] || 1));
        return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
      }
      let number = intOrNone(value);
      if (number === null && target === "size_bytes") number = humanSize(value);
      // Some sites send 0 for "not recorded", and no real torrent is zero
      // bytes or zero files. A swarm of zero, though, is a fact worth keeping,
      // so the descriptor has to say so per field rather than a rule guessing.
      if (number === 0 && spec.nonzero) return null;
      return number;
    }
    case "first_seen": {
      // Three spellings in the wild, told apart by shape: an ISO string is
      // passed through as the site wrote it, an integer is Unix seconds or
      // milliseconds (`firstSeen` tells those apart by magnitude), and an
      // RFC 822 date is what RSS feeds use. Anything else is no date — never
      // the epoch.
      const text = String(value ?? "").trim();
      if (text.length >= 10 && text[4] === "-" && text[7] === "-") return text;
      const stamp = firstSeen(value);
      if (stamp) return stamp;
      return pubDate(text);
    }
    case "magnet":
    case "torrent_url":
    case "description_url":
    case "category": {
      return String(value).trim() || null;
    }
    default:
      return null;
  }
}

/** Evaluate one field: alternation, then per-form handling, then coercion. */
function evalField(target, spec, scopes) {
  if (spec.constant !== undefined) return spec.constant;
  for (const path of spec.alternatives) {
    if (typeof path !== "string") continue;
    const raw = resolvePath(scopes, path);
    if (isAbsent(raw)) continue;
    let value;
    if (spec.map) {
      const whole = String(raw).trim();
      const key = spec.prefix ? whole.slice(0, spec.prefix) : whole;
      value = Object.prototype.hasOwnProperty.call(spec.map, key) ? spec.map[key] : null;
    } else if (spec.template) {
      const token = String(raw).trim();
      value = token ? spec.template.split("{value}").join(quote(token)) : null;
    } else {
      value = coerceValue(target, raw, spec);
    }
    if (!isAbsent(value)) return value;
  }
  return null;
}

/**
 * One row through a descriptor's field map, or null when the row invariants do
 * not hold: a name, and an infohash (or a magnet to recover one from) that is
 * not apibay's forty zeroes. TSP requires a magnet on every row, so a row that
 * cannot yield one is dropped and counted rather than emitted broken.
 */
function descriptorRow(descriptor, fields, scopes) {
  const get = (target) => (fields[target] ? evalField(target, fields[target], scopes) : null);

  const name = get("name");
  let infohash = get("infohash");
  if (!infohash) infohash = infohashFromMagnet(String(get("magnet") ?? ""));
  if (!name || !infohash || infohash === EMPTY_INFOHASH) return null;

  // Which index behind a meta-index had it — knaben says `1337x` — kept as
  // provenance the way `upstream` keeps its plugins' names.
  let sources = [descriptor.name];
  if (descriptor.provenance) {
    const tracker = String(resolvePath(scopes, descriptor.provenance) ?? "").trim();
    if (tracker) sources = [`${descriptor.name}/${tracker}`];
  }

  return {
    name,
    engineId: descriptor.name,
    infohash,
    torrentUrl: get("torrent_url"),
    sizeBytes: get("size_bytes"),
    files: get("files"),
    seeders: get("seeders"),
    leechers: get("leechers"),
    category: get("category"),
    firstSeen: get("first_seen"),
    descriptionUrl: get("description_url"),
    sources,
    meta: null,
  };
}

/**
 * Rows seen and rows emitted, per engine, from the last request this isolate
 * ran. The ratio between them is drift detection for free: when a site renames
 * a field, the fetch still returns 200 and the JSON still parses, but every row
 * fails the invariants and the engine emits nothing — which used to read as
 * healthy. A collapsed emit ratio is the alarm `/healthz` raises instead.
 */
const ROW_STATS = new Map();

/** The four placeholders a request template may use. Nothing else substitutes. */
function templateValues(descriptor, query, settings) {
  const request = descriptor.request || {};
  const cap = Number.isInteger(request.limit_cap) ? request.limit_cap : 100;
  return {
    q: query.terms,
    limit: Math.min(settings.maxRowsPerEngine, cap),
    offset: 0,
    category: query.cat || "",
  };
}

function fillTemplate(text, values, encode) {
  return text.replace(/\{(q|limit|offset|category)\}/g, (whole, key) => encode(String(values[key])));
}

/** A POST body template, placeholders filled. `"{limit}"` alone stays a number. */
function fillBody(node, values) {
  if (typeof node === "string") {
    if (node === "{limit}") return values.limit;
    if (node === "{offset}") return values.offset;
    return fillTemplate(node, values, (text) => text);
  }
  if (Array.isArray(node)) return node.map((item) => fillBody(item, values));
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = fillBody(value, values);
    return out;
  }
  return node;
}

/** The request a `json` or `rss` descriptor describes, asked of one origin. */
async function descriptorFetch(descriptor, http, query, settings, origin) {
  const request = descriptor.request || {};
  const values = templateValues(descriptor, query, settings);
  let url = origin + fillTemplate(request.path || "/", values, quote);
  const params = {};
  for (const [key, value] of Object.entries(request.query || {})) {
    params[key] = fillTemplate(String(value), values, (text) => text);
  }
  if (Object.keys(params).length) url += `?${urlencode(params)}`;

  const options = { timeout: timeoutFor(settings, descriptor.name) };
  if ((request.method || "GET") === "POST") {
    options.method = "POST";
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(fillBody(request.body || {}, values));
  }
  const [status, body] = await http.text(url, options);
  if (status !== 200) throw statusError(status);
  return body;
}

/**
 * The row scopes a `rows` path selects. Without `[]` the path must name the
 * array of rows; with it (at most twice — yts's `data.movies[].torrents[]` is
 * the only nested shape seen) each element becomes a scope whose parents stay
 * reachable through `^.`. Returns null when the path found no array at all.
 */
function descriptorScopes(rowsPath, payload) {
  if (rowsPath.indexOf("[]") === -1) {
    const rows = rowsPath === "" ? payload : resolvePath([payload], rowsPath);
    return Array.isArray(rows) ? rows.map((row) => [row, payload]) : null;
  }
  const parts = rowsPath.replace(/\[\]$/, "").split("[]");
  let chains = [[payload]];
  for (let index = 0; index < parts.length; index += 1) {
    const path = parts[index].replace(/^\./, "");
    const next = [];
    for (const chain of chains) {
      const value = path === "" ? chain[0] : resolvePath(chain, path);
      if (!Array.isArray(value)) continue;
      for (const element of value) next.push([element, ...chain]);
    }
    chains = next;
  }
  return chains;
}

/** `kind: json` — a JSON API described by a URL template, a rows path and a field map. */
async function jsonEngine(descriptor, http, query, settings) {
  const text = await askOrigins(descriptor.name, settings, (origin) =>
    descriptorFetch(descriptor, http, query, settings, origin),
  );
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new EngineError(`not JSON: ${error.message}`);
  }

  if (descriptor.rows === "") {
    if (!Array.isArray(payload)) throw new EngineError("expected a JSON array");
  } else if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    // Their API answers with an object. An array is somebody else's API, or a
    // captive portal, and guessing at it would invent torrents.
    throw new EngineError(
      descriptor.rows_required
        ? `expected a JSON object with ${descriptor.rows}`
        : "expected a JSON object",
    );
  }

  let scopes = descriptorScopes(descriptor.rows, payload);
  if (scopes === null) {
    // Some APIs omit the rows key entirely when nothing matched; others always
    // send it, and its absence means the response is not theirs.
    if (descriptor.rows_required) {
      throw new EngineError(`expected a JSON object with ${descriptor.rows}`);
    }
    scopes = [];
  }

  const stats = { seen: 0, emitted: 0 };
  const fields = {};
  for (const [target, expr] of Object.entries(descriptor.fields || {})) {
    fields[target] = readExpr(expr);
  }
  const rows = [];
  for (const chain of scopes) {
    if (rows.length >= settings.maxRowsPerEngine) break;
    if (!chain[0] || typeof chain[0] !== "object") continue;
    stats.seen += 1;
    const row = descriptorRow(descriptor, fields, chain);
    if (row) rows.push(row);
  }
  stats.emitted = rows.length;
  ROW_STATS.set(descriptor.name, stats);
  return rows;
}

/** `kind: rss` — like `json`, but rows are `<item>` elements in a feed. */
async function rssEngine(descriptor, http, query, settings) {
  const text = await askOrigins(descriptor.name, settings, (origin) =>
    descriptorFetch(descriptor, http, query, settings, origin),
  );
  let blocks;
  try {
    blocks = feedItems(text);
  } catch (error) {
    throw new EngineError(`not XML: ${error.message}`);
  }

  // A feed binds a namespace to whatever prefix it likes, so the descriptor's
  // alias is resolved against the document rather than assumed.
  const aliases = {};
  for (const [alias, uri] of Object.entries(descriptor.namespaces || {})) {
    aliases[namespacePrefix(text, String(uri), alias)] = alias;
  }

  const stats = { seen: 0, emitted: 0 };
  const fields = {};
  for (const [target, expr] of Object.entries(descriptor.fields || {})) {
    fields[target] = readExpr(expr);
  }
  const rows = [];
  for (const block of blocks) {
    if (rows.length >= settings.maxRowsPerEngine) break;
    stats.seen += 1;
    const item = Object.create(null);
    for (const child of feedChildren(block)) {
      const colon = child.name.indexOf(":");
      let key = child.name;
      if (colon !== -1) {
        const alias = aliases[child.name.slice(0, colon)];
        if (!alias) continue;
        key = `${alias}:${child.name.slice(colon + 1)}`;
      }
      if (item[key] === undefined) item[key] = xmlText(child.text);
    }
    const row = descriptorRow(descriptor, fields, [item]);
    if (row) rows.push(row);
  }
  stats.emitted = rows.length;
  ROW_STATS.set(descriptor.name, stats);
  return rows;
}

/**
 * `kind: tsp` — another TSP index, reached over the same path `upstream` uses
 * but with one deliberate difference: **no credential, ever.** A feed-supplied
 * TSP endpoint is a public engine; only `upstream` and `fallback`, which the
 * operator configured themselves, carry the operator's key.
 */
async function tspEngine(descriptor, http, query, settings) {
  return askOrigins(descriptor.name, settings, (origin) =>
    tspIndex(http, query, settings, descriptor.name, origin, ""),
  );
}

/** `kind: torznab` — a public Torznab endpoint. Same no-credential rule as `tsp`. */
async function torznabEngine(descriptor, http, query, settings) {
  const params = {
    t: "search",
    q: query.terms,
    limit: String(Math.min(settings.maxRowsPerEngine, 100)),
  };
  return askOrigins(descriptor.name, settings, async (origin) => {
    const joiner = origin.includes("?") ? "&" : "?";
    const [status, body] = await http.text(`${origin}${joiner}${urlencode(params)}`, {
      timeout: timeoutFor(settings, descriptor.name),
    });
    if (status !== 200) throw statusError(status);
    return parseTorznab(body, settings.maxRowsPerEngine, descriptor.name);
  });
}

/** `kind` is the discriminant of a tagged union: one handler per kind. */
function runDescriptor(descriptor, http, query, settings) {
  switch (descriptor.kind) {
    case "json":
      return jsonEngine(descriptor, http, query, settings);
    case "rss":
      return rssEngine(descriptor, http, query, settings);
    case "tsp":
      return tspEngine(descriptor, http, query, settings);
    case "torznab":
      return torznabEngine(descriptor, http, query, settings);
    default:
      // Unknown kinds are dropped at feed validation; reaching one here means
      // a compiled-in descriptor is wrong, which the tests catch.
      throw new EngineError(`unsupported kind ${descriptor.kind}`);
  }
}

/**
 * The engines this file ships, as the same descriptors the feed carries.
 *
 * These are the seed: the configuration of last resort, compiled in so that a
 * deployment with no feed, an expired feed, or a cold cache still searches.
 * Each carries the decisions its adapter used to record — they are data now,
 * but they are still decisions.
 */
const SEED_DESCRIPTORS = [
  {
    // Knaben Database — dozens of trackers behind one JSON API, and the engine
    // that makes "unified" more than a name at the edge: a meta-index over
    // sites that scrape poorly or not at all from a data-centre address.
    // `search_type` must be `100%` — their fuzzy `score` mode plus a seeders
    // sort discards the score and answers with the whole index. `hide_unsafe`
    // stays on: their flag for malware bait, not a content filter.
    name: "knaben",
    kind: "json",
    breadth: "broad",
    enabled: true,
    origins: ENGINE_ORIGINS.knaben,
    site: "https://knaben.org",
    request: {
      method: "POST",
      path: "/v1",
      body: {
        search_type: "100%",
        search_field: "title",
        query: "{q}",
        order_by: "seeders",
        order_direction: "desc",
        from: 0,
        size: "{limit}",
        hide_unsafe: true,
      },
    },
    rows: "hits",
    rows_required: true,
    provenance: "tracker",
    fields: {
      name: "title",
      infohash: ["hash", "magnetUrl"],
      size_bytes: "bytes",
      seeders: "seeders",
      leechers: "peers",
      // Knaben sends ISO-8601 already; the coercion passes it through as
      // written. No category: their numeric scheme is theirs, not TSP's, and a
      // row without one is classified from its name locally.
      first_seen: "date",
      description_url: "details",
    },
  },
  {
    // apibay — one large site's own JSON API, and the fastest thing here: one
    // GET, a JSON array, no key. Names arrive HTML-escaped for `cleanName` to
    // undo. Categories by leading digit: 100s audio, 200s video, 300s
    // applications, 400s games; the 500s and 600s are left out rather than
    // guessed at, and an uncategorised row is read from its name.
    name: "piratebay",
    kind: "json",
    breadth: "broad",
    enabled: true,
    origins: ENGINE_ORIGINS.piratebay,
    site: "https://apibay.org",
    request: { method: "GET", path: "/q.php", query: { q: "{q}" } },
    rows: "",
    fields: {
      name: "name",
      infohash: "info_hash",
      size_bytes: { from: "size", nonzero: true },
      files: { from: "num_files", nonzero: true },
      seeders: "seeders",
      leechers: "leechers",
      category: { from: "category", prefix: 1, map: { 1: "audio", 2: "video", 3: "software", 4: "software" } },
      first_seen: "added",
      // The description lives on the site, not on the API host.
      description_url: { template: "https://thepiratebay.org/description.php?id={value}", from: "id" },
    },
  },
  {
    // torrents-csv — a static, DHT-derived index. No categories, so names
    // carry the load. An `upstream` instance already searches this same source
    // from a better address; without one it is half the answer, since a
    // curated site and a DHT crawl miss different things.
    name: "torrentscsv",
    kind: "json",
    breadth: "broad",
    enabled: true,
    origins: ENGINE_ORIGINS.torrentscsv,
    site: "https://torrents-csv.com",
    request: { method: "GET", path: "/service/search", query: { q: "{q}", size: "{limit}" } },
    rows: "torrents",
    fields: {
      name: "name",
      infohash: "infohash",
      size_bytes: "size_bytes",
      seeders: "seeders",
      leechers: "leechers",
      first_seen: "created_unix",
    },
  },
  {
    // AnimeTosho — an aggregator over Nyaa and Tokyo Toshokan that answers in
    // JSON, measured answering a deployed Worker in the same request where
    // nyaa came back 429. The magnet is in the listing, so one request is the
    // whole cost. No category field is read: theirs is anime-specific.
    name: "animetosho",
    kind: "json",
    breadth: "narrow",
    enabled: true,
    origins: ENGINE_ORIGINS.animetosho,
    site: "https://animetosho.org",
    request: { method: "GET", path: "/json", query: { q: "{q}" } },
    rows: "",
    fields: {
      name: "title",
      infohash: "magnet_uri",
      size_bytes: "total_size",
      seeders: "seeders",
      leechers: "leechers",
      first_seen: "timestamp",
      description_url: "link",
    },
  },
  {
    // EZTV — television episodes from the site's own JSON API. The `Keywords`
    // path, not `imdb_id`: the latter needs an OMDb key, and this file sends
    // no third-party credentials and asks the deployer for none. Every row is
    // an episode, so the category is known without reading the name.
    name: "eztvx",
    kind: "json",
    breadth: "narrow",
    enabled: true,
    origins: ENGINE_ORIGINS.eztvx,
    site: "https://eztvx.to",
    request: {
      method: "GET",
      path: "/api/get-torrents",
      query: { limit: "{limit}", page: "1", Keywords: "{q}" },
    },
    rows: "torrents",
    fields: {
      name: "title",
      infohash: ["hash", "magnet_url"],
      size_bytes: { from: "size_bytes", nonzero: true },
      seeders: "seeds",
      leechers: "peers",
      category: { const: "video" },
      first_seen: "date_released_unix",
      description_url: "episode_url",
    },
  },
  {
    // Nyaa — an RSS feed of East Asian media, which nothing else here covers.
    // The infohash and swarm counts hang off the site's own XML namespace, so
    // no HTML is parsed. Categories by the digit before the underscore in
    // `1_2`: 1 is animation and 4 is live action — both video; 3 is literature.
    name: "nyaa",
    kind: "rss",
    breadth: "narrow",
    enabled: true,
    origins: ENGINE_ORIGINS.nyaa,
    site: "https://nyaa.si",
    request: { method: "GET", path: "/", query: { page: "rss", q: "{q}" } },
    namespaces: { nyaa: NYAA_NS },
    fields: {
      name: "title",
      infohash: "nyaa:infoHash",
      size_bytes: "nyaa:size",
      seeders: "nyaa:seeders",
      leechers: "nyaa:leechers",
      category: {
        from: "nyaa:categoryId",
        prefix: 1,
        map: { 1: "video", 2: "audio", 3: "document", 4: "video", 5: "image", 6: "software" },
      },
      first_seen: "pubDate",
      torrent_url: "link",
      description_url: "guid",
    },
  },
];

const SEED_BY_NAME = new Map(SEED_DESCRIPTORS.map((descriptor) => [descriptor.name, descriptor]));

/**
 * The descriptor currently driving *name*: the verified feed's when it has
 * one, the compiled-in seed's otherwise. Operator environment variables still
 * outrank both — UTSI_ENGINE_URLS is applied in `originsFor`, above the feed.
 */
function activeDescriptor(name) {
  return feedDescriptorFor(name) || SEED_BY_NAME.get(name);
}

/** A seed engine's callable, resolving its descriptor at call time. */
function descriptorEngine(name) {
  return (http, query, settings) => runDescriptor(activeDescriptor(name), http, query, settings);
}

const ENGINES = {
  upstream,
  fallback,
  knaben: descriptorEngine("knaben"),
  piratebay: descriptorEngine("piratebay"),
  torrentscsv: descriptorEngine("torrentscsv"),
  // yts stays a hand-written adapter on purpose: its release name is assembled
  // from four fields, and the expression language will not grow concatenation
  // to absorb one narrow engine (see the language's prohibitions above). The
  // feed can still move its addresses via `origins`.
  yts,
  nyaa: descriptorEngine("nyaa"),
  animetosho: descriptorEngine("animetosho"),
  eztvx: descriptorEngine("eztvx"),
  torznab,
};
const KNOWN_ENGINES = Object.keys(ENGINES);

/** The callable for *engineId*, wherever it is defined — or null. */
function engineFor(engineId) {
  if (ENGINES[engineId]) return ENGINES[engineId];
  const fed = feedDescriptorFor(engineId);
  if (fed) return (http, query, settings) => runDescriptor(fed, http, query, settings);
  return null;
}

// --- THE FEED ----------------------------------------------------------------
//
// A deployed Worker is a photocopy of one moment, pasted into an account this
// project can never reach again. The decay actually observed is address death —
// yts.mx deleted, torrents-csv.ml parked, bt4g gone silent — and the repair
// used to be a human finding UTSI_ENGINE_URLS in a dashboard. The feed is that
// repair made automatic: a signed public file carrying the descriptors above,
// fetched hourly, verified against the root keys pinned at the top of this
// file, and never trusted with more than data.
//
// The trust chain has two levels because a pasted file's pinned key can never
// be rotated for deployments that already exist. An offline *root* key signs
// `keyring.json`, which lists the *subkeys* CI signs the nightly feed with;
// the Worker pins only root public keys and discovers everything else. Every
// failure — unreachable, unverifiable, expired, rolled back, malformed —
// degrades to the last verified feed in this colo's cache, and failing that to
// the seed compiled in above. A feed failure is never a search failure, and
// the feed is never fetched on the search critical path.
//
// What the feed can never do: execute anything (data only, schema-validated),
// carry or receive a secret (feed engines are public engines), or name the
// engines that hold an operator's credential (`upstream`, `fallback`,
// `torznab` are reserved). Rollback protection is honest rather than absolute:
// the Cache API is per-colo and evictable, so a cold colo has no memory of the
// highest serial, and `expires_at` is what actually bounds the replay window.

const FEED_REFRESH_MS = 3600 * 1000;
const FEED_FETCH_TIMEOUT_S = 10;
const FEED_CACHE_KEY = "https://tgp-feed.utsi.internal/last-known-good";

/** What this isolate knows about the feed. Best-effort, like LIVENESS. */
const FEED = {
  engines: null, // Map(name -> descriptor) once a feed has verified
  serial: 0,
  issuedAt: "",
  expiresAt: "",
  movedTo: null,
  mirrors: [],
  source: "",
  fromCache: false,
  verifiedAt: 0,
  attemptedAt: 0,
  highestSerial: 0,
  error: "",
  unsupportedKinds: [],
  invalidDescriptors: [],
  refreshing: null,
};

function resetFeed() {
  FEED.engines = null;
  FEED.serial = 0;
  FEED.issuedAt = "";
  FEED.expiresAt = "";
  FEED.movedTo = null;
  FEED.mirrors = [];
  FEED.source = "";
  FEED.fromCache = false;
  FEED.verifiedAt = 0;
  FEED.attemptedAt = 0;
  FEED.highestSerial = 0;
  FEED.error = "";
  FEED.unsupportedKinds = [];
  FEED.invalidDescriptors = [];
  FEED.refreshing = null;
}

/** The feed's descriptor for *name*, when one is loaded and usable. */
function feedDescriptorFor(name) {
  return FEED.engines ? FEED.engines.get(name) || null : null;
}

/**
 * The fan-out roster when UTSI_ENGINES says nothing: the compiled-in default,
 * minus engines the feed has marked dead, plus feed engines this file has
 * never heard of — appended last, so a new engine can never displace the
 * operator's implicit priorities. An explicit UTSI_ENGINES outranks all of it.
 */
function defaultRoster() {
  if (!FEED.engines) return DEFAULT_ENGINES;
  const roster = DEFAULT_ENGINES.filter((engineId) => {
    const fed = FEED.engines.get(engineId);
    return !fed || fed.enabled !== false;
  });
  for (const descriptor of FEED.engines.values()) {
    if (descriptor.enabled === false) continue;
    if (!roster.includes(descriptor.name) && !(descriptor.name in ENGINES)) {
      roster.push(descriptor.name);
    }
  }
  return roster;
}

// --- feed validation ---------------------------------------------------------
//
// Enforced before anything is evaluated, on limits small enough that nothing
// pathological fits: a descriptor is a field map, not a program, and the
// validator is what keeps it one.

const TGP_LIMITS = {
  descriptors: 64,
  fields: 40,
  alternatives: 8,
  segments: 8,
  pathLength: 64,
  origins: 8,
  mirrors: 8,
};

const TGP_ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~/-]*)?$/;

/** Why *path* is not a legal expression path, or "". */
function pathProblem(path) {
  if (typeof path !== "string" || !path) return "empty path";
  if (path.length > TGP_LIMITS.pathLength) return "path too long";
  const bare = path.replace(/^(\^\.)+/, "");
  if (bare.split(".").length > TGP_LIMITS.segments) return "too many segments";
  if (!/^[\^]?[A-Za-z0-9_:.^-]*$/.test(path)) return "path has characters no key uses";
  return "";
}

/** Why *expr* is not a legal field expression for *target*, or "". */
function exprProblem(target, expr) {
  const spec = readExpr(expr);
  if (spec.constant !== undefined) {
    if (spec.constant.length > 64) return "const too long";
    if (target === "category" && !TSP_CATEGORIES.includes(spec.constant)) return "const not a TSP category";
    return "";
  }
  if (!spec.alternatives.length) return "no path";
  if (spec.alternatives.length > TGP_LIMITS.alternatives) return "too many alternatives";
  for (const path of spec.alternatives) {
    const problem = pathProblem(path);
    if (problem) return problem;
  }
  if (spec.unit && !(spec.unit in TGP_UNITS)) return "unknown unit";
  if (spec.unit && target !== "size_bytes") return "unit only annotates size_bytes";
  if (spec.map) {
    if (target !== "category") return "map only annotates category";
    const entries = Object.entries(spec.map);
    if (entries.length > 16) return "map too large";
    for (const [key, value] of entries) {
      if (String(key).length > 32) return "map key too long";
      if (!TSP_CATEGORIES.includes(value)) return "map value not a TSP category";
    }
    if (spec.prefix !== undefined && !(Number.isInteger(spec.prefix) && spec.prefix >= 1 && spec.prefix <= 8)) {
      return "bad prefix";
    }
  }
  if (spec.template !== undefined) {
    if (target !== "description_url" && target !== "torrent_url") {
      return "template only builds description_url or torrent_url";
    }
    if (typeof spec.template !== "string" || spec.template.length > 200) return "template too long";
    if (!spec.template.startsWith("https://")) return "template must be https";
    if (spec.template.split("{value}").length !== 2) return "template needs exactly one {value}";
  }
  return "";
}

/**
 * Why *entry* is not a descriptor this Worker will run, or "". Invalid
 * descriptors are dropped individually — one malformed entry must not blank an
 * entire deployment — and unknown kinds are not invalid, just not for us yet.
 */
function descriptorProblem(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "not an object";
  if (!TGP_NAME.test(String(entry.name || ""))) return "bad name";
  if (RESERVED_ENGINE_NAMES.has(entry.name)) return "reserved name";
  if (entry.breadth !== undefined && !["broad", "narrow"].includes(entry.breadth)) return "bad breadth";
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") return "bad enabled";
  if (entry.site !== undefined && (typeof entry.site !== "string" || entry.site.length > 200)) return "bad site";

  if (!Array.isArray(entry.origins) || !entry.origins.length) return "no origins";
  if (entry.origins.length > TGP_LIMITS.origins) return "too many origins";
  for (const origin of entry.origins) {
    if (typeof origin !== "string" || origin.length > 200 || !TGP_ORIGIN.test(origin)) {
      return "origins must be plain https:// addresses";
    }
  }

  if (entry.kind === "tsp" || entry.kind === "torznab") return "";
  if (entry.kind !== "json" && entry.kind !== "rss") return ""; // unknown kinds are skipped, not invalid

  const request = entry.request || {};
  if (typeof request !== "object" || Array.isArray(request)) return "bad request";
  if (request.method !== undefined && !["GET", "POST"].includes(request.method)) return "bad method";
  if (request.method === "POST" && entry.kind === "rss") return "rss is GET only";
  if (request.path !== undefined) {
    if (typeof request.path !== "string" || request.path.length > 128) return "bad path";
    if (!/^\/[A-Za-z0-9._~/{}-]*$/.test(request.path)) return "bad path";
  }
  if (request.query !== undefined) {
    const params = Object.entries(request.query || {});
    if (params.length > 16) return "too many query parameters";
    for (const [key, value] of params) {
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(key)) return "bad query key";
      if (typeof value !== "string" || value.length > 128) return "bad query value";
    }
  }
  if (request.body !== undefined) {
    if (request.method !== "POST") return "body needs POST";
    if (JSON.stringify(request.body).length > 2048) return "body too large";
  }
  if (request.limit_cap !== undefined) {
    if (!Number.isInteger(request.limit_cap) || request.limit_cap < 1 || request.limit_cap > 500) {
      return "bad limit_cap";
    }
  }

  if (entry.kind === "json") {
    if (typeof entry.rows !== "string" || entry.rows.length > TGP_LIMITS.pathLength) return "bad rows";
    if (entry.rows.split("[]").length > 3) return "rows may traverse at most two arrays";
    if (entry.rows !== "" && pathProblem(entry.rows.replace(/\[\]/g, ""))) return "bad rows";
  }
  if (entry.kind === "rss" && entry.namespaces !== undefined) {
    const spaces = Object.entries(entry.namespaces || {});
    if (spaces.length > 8) return "too many namespaces";
    for (const [alias, uri] of spaces) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,15}$/.test(alias)) return "bad namespace alias";
      if (typeof uri !== "string" || uri.length > 200) return "bad namespace uri";
    }
  }
  if (entry.provenance !== undefined && pathProblem(entry.provenance)) return "bad provenance";
  if (entry.rows_required !== undefined && typeof entry.rows_required !== "boolean") return "bad rows_required";

  const fields = Object.entries(entry.fields || {});
  if (!fields.length) return "no fields";
  if (fields.length > TGP_LIMITS.fields) return "too many fields";
  for (const [target, expr] of fields) {
    if (!TGP_TARGETS.has(target)) return `unknown field ${target}`;
    const problem = exprProblem(target, expr);
    if (problem) return `${target}: ${problem}`;
  }
  return "";
}

// --- feed verification -------------------------------------------------------

function bytesFromBase64(text) {
  const raw = atob(String(text).trim());
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function ed25519Verify(publicKeyB64, signatureB64, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    bytesFromBase64(publicKeyB64),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("Ed25519", key, bytesFromBase64(signatureB64), new TextEncoder().encode(text));
}

/** A detached signature file: `{"key_id": "...", "signature": "<base64>"}`. */
function readSignatureFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return { keyId: String(parsed.key_id || ""), signature: String(parsed.signature || "") };
}

class FeedRejected extends Error {}

/**
 * The verification algorithm, in the order the spec gives it. Any failure
 * rejects the feed — and rejection, everywhere in this file, means "keep what
 * we had", never "break a search".
 *
 * Signatures are detached and taken over the exact bytes of each file, so the
 * feed stays readable in a browser and diffable in git — the same reasoning as
 * publishing `worker.js.sha256` next to a file anyone can read.
 */
async function verifyFeedDocuments(docs, rootKeys, nowMs) {
  const keyringSig = readSignatureFile(docs.keyringSig);
  if (!keyringSig || !keyringSig.signature) throw new FeedRejected("keyring signature file unreadable");

  let keyringOk = false;
  for (const rootKey of rootKeys) {
    try {
      if (await ed25519Verify(rootKey, keyringSig.signature, docs.keyring)) {
        keyringOk = true;
        break;
      }
    } catch {
      // A malformed pinned key or an unsupported algorithm reads as "did not
      // verify", which fails closed into the seed configuration.
    }
  }
  if (!keyringOk) throw new FeedRejected("keyring signature did not verify against a pinned root key");

  let keyring;
  try {
    keyring = JSON.parse(docs.keyring);
  } catch {
    throw new FeedRejected("keyring is not JSON");
  }

  const feedSig = readSignatureFile(docs.feedSig);
  if (!feedSig || !feedSig.signature) throw new FeedRejected("feed signature file unreadable");
  const subkeys = Array.isArray(keyring.subkeys) ? keyring.subkeys : [];
  const subkey = subkeys.find((entry) => entry && entry.key_id === feedSig.keyId);
  if (!subkey) throw new FeedRejected(`signing key ${feedSig.keyId || "(unnamed)"} is not in the keyring`);
  const notBefore = Date.parse(String(subkey.not_before || "")) || 0;
  const notAfter = Date.parse(String(subkey.not_after || "")) || 0;
  if (nowMs < notBefore || (notAfter && nowMs > notAfter)) {
    throw new FeedRejected(`signing key ${feedSig.keyId} is outside its validity window`);
  }

  let feedOk = false;
  try {
    feedOk = await ed25519Verify(String(subkey.public_key || ""), feedSig.signature, docs.feed);
  } catch {
    feedOk = false;
  }
  if (!feedOk) throw new FeedRejected("feed signature did not verify");

  let feed;
  try {
    feed = JSON.parse(docs.feed);
  } catch {
    throw new FeedRejected("feed is not JSON");
  }
  if (!feed || typeof feed !== "object") throw new FeedRejected("feed is not an object");
  if (!Number.isInteger(feed.tgp_version) || feed.tgp_version > TGP_VERSION) {
    throw new FeedRejected(`feed is tgp_version ${feed.tgp_version}; this Worker speaks ${TGP_VERSION}`);
  }
  const expires = Date.parse(String(feed.expires_at || ""));
  if (!expires || expires < nowMs) throw new FeedRejected(`feed expired at ${feed.expires_at}`);
  if (!Number.isSafeInteger(feed.serial) || feed.serial < 0) throw new FeedRejected("feed has no serial");
  if (!Array.isArray(feed.engines)) throw new FeedRejected("feed has no engines");
  if (feed.engines.length > TGP_LIMITS.descriptors) throw new FeedRejected("feed has too many engines");
  return feed;
}

/**
 * Take a verified feed as this isolate's configuration. Invalid descriptors
 * are dropped one by one, reserved names are refused, and kinds this Worker
 * does not recognise are recorded for `/healthz` and skipped — which is what
 * makes the format forward-compatible without a version handshake: a 2026
 * Worker reading a 2029 feed uses what it understands and ignores the rest.
 */
function applyFeed(feed, source, fromCache) {
  const engines = new Map();
  const unsupported = [];
  const invalid = [];
  for (const entry of feed.engines) {
    const name = entry && typeof entry === "object" ? String(entry.name || "(unnamed)") : "(unnamed)";
    const problem = descriptorProblem(entry);
    if (problem) {
      invalid.push(`${name}: ${problem}`);
      continue;
    }
    if (!TGP_KINDS.has(entry.kind)) {
      unsupported.push(`${name}: ${String(entry.kind)}`);
      continue;
    }
    if (!engines.has(entry.name)) engines.set(entry.name, entry);
  }

  FEED.engines = engines;
  FEED.serial = feed.serial;
  FEED.issuedAt = String(feed.issued_at || "");
  FEED.expiresAt = String(feed.expires_at || "");
  FEED.movedTo = typeof feed.moved_to === "string" ? feed.moved_to : null;
  FEED.mirrors = Array.isArray(feed.mirrors)
    ? feed.mirrors.filter((url) => typeof url === "string" && TGP_ORIGIN.test(url)).slice(0, TGP_LIMITS.mirrors)
    : [];
  FEED.source = source;
  FEED.fromCache = fromCache;
  FEED.verifiedAt = Date.now();
  FEED.highestSerial = Math.max(FEED.highestSerial, feed.serial);
  FEED.unsupportedKinds = unsupported;
  FEED.invalidDescriptors = invalid;
  FEED.error = "";
}

// --- feed fetch, cache, refresh ----------------------------------------------

/** The three sibling files that travel with `feed.json`, from one base URL. */
function feedSiblings(feedUrl) {
  const slash = feedUrl.lastIndexOf("/");
  const base = slash === -1 ? feedUrl + "/" : feedUrl.slice(0, slash + 1);
  return {
    feed: feedUrl,
    feedSig: `${feedUrl}.sig`,
    keyring: `${base}keyring.json`,
    keyringSig: `${base}keyring.json.sig`,
  };
}

async function fetchFeedDocuments(http, feedUrl) {
  const urls = feedSiblings(feedUrl);
  const docs = {};
  for (const [which, url] of Object.entries(urls)) {
    const [status, body] = await http.text(url, {
      timeout: FEED_FETCH_TIMEOUT_S,
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (status !== 200) throw new FeedRejected(`HTTP ${status} fetching ${which}`);
    if (!body || body.length > 512 * 1024) throw new FeedRejected(`${which} is empty or oversized`);
    docs[which] = body;
  }
  return docs;
}

/** The Cache API when the runtime has one; tests inject a stand-in. */
function defaultFeedCache() {
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

async function readFeedCache(cache) {
  if (!cache) return null;
  try {
    const hit = await cache.match(FEED_CACHE_KEY);
    if (!hit) return null;
    return await hit.json();
  } catch {
    return null;
  }
}

async function writeFeedCache(cache, record) {
  if (!cache) return;
  try {
    await cache.put(
      FEED_CACHE_KEY,
      new Response(JSON.stringify(record), {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=1209600" },
      }),
    );
  } catch {
    // Cache eviction and cache refusal are the same fact: no memory here.
  }
}

/**
 * Fetch, verify and adopt the feed. Every path out of here leaves the Worker
 * able to search: fresh feed, else the in-memory one, else the last verified
 * copy in this colo's cache, else the compiled-in seed. Failures are recorded
 * for `/healthz` and never thrown to a caller.
 */
async function refreshFeed(http, settings, options = {}) {
  const rootKeys = options.rootKeys || TGP_ROOT_KEYS;
  const cache = "cache" in options ? options.cache : defaultFeedCache();
  const now = options.now || Date.now();
  FEED.attemptedAt = Date.now();
  if (!settings.feed || !rootKeys.length) return false;

  const cached = await readFeedCache(cache);
  if (cached && Number.isSafeInteger(cached.serial)) {
    FEED.highestSerial = Math.max(FEED.highestSerial, cached.serial);
  }

  // The configured URL first, then the mirrors the last good feed named.
  // A mirror serves the same signed bytes, so trying one is asking the same
  // question somewhere else, not trusting anyone new.
  const candidates = [settings.feedUrl, ...FEED.mirrors.filter((url) => url !== settings.feedUrl)];
  let failure = null;
  for (const candidate of candidates) {
    try {
      const docs = await fetchFeedDocuments(http, candidate);
      const feed = await verifyFeedDocuments(docs, rootKeys, now);
      if (feed.serial < FEED.highestSerial) {
        throw new FeedRejected(`feed serial ${feed.serial} is older than ${FEED.highestSerial}`);
      }
      applyFeed(feed, candidate, false);
      await writeFeedCache(cache, { serial: feed.serial, storedAt: now, docs });
      return true;
    } catch (thrown) {
      failure = failure || thrown;
    }
  }

  FEED.error = String((failure && failure.message) || failure || "unreachable").slice(0, 300);

  // Nothing fresh. If this isolate already holds a verified feed, keep it;
  // otherwise re-verify the cached copy — the cache is shared machinery, so
  // its contents are checked exactly like a download, not trusted.
  if (!FEED.engines && cached && cached.docs) {
    try {
      const feed = await verifyFeedDocuments(cached.docs, rootKeys, now);
      const error = FEED.error;
      applyFeed(feed, settings.feedUrl, true);
      FEED.error = error;
    } catch {
      // The cached copy is stale or damaged; the seed configuration serves.
    }
  }
  return false;
}

/** Kick a refresh when the last one is old, without ever blocking a caller. */
function maybeRefreshFeed(http, settings, waitUntil) {
  if (!settings.feed || !TGP_ROOT_KEYS.length) return;
  if (FEED.refreshing) return;
  const freshest = Math.max(FEED.verifiedAt, FEED.attemptedAt);
  if (Date.now() - freshest < FEED_REFRESH_MS) return;
  const task = refreshFeed(http, settings)
    .catch(() => false)
    .finally(() => {
      FEED.refreshing = null;
    });
  FEED.refreshing = task;
  if (waitUntil) waitUntil(task);
}

/** What `/healthz` says about the feed. Honest about staleness and absence. */
function feedReport(settings) {
  const report = {
    enabled: settings.feed,
    url: settings.feedUrl,
    // What is actually serving: a live verified feed, the cached last known
    // good, or the seed compiled into this file — and, when it is the seed,
    // whether that is because the feed failed or because no root key is
    // pinned and the feature has simply never been switched on.
    status: !settings.feed
      ? "disabled"
      : FEED.engines
        ? FEED.fromCache
          ? "cache"
          : "verified"
        : FEED.error
          ? "seed_only"
          : !TGP_ROOT_KEYS.length
            ? "no_root_keys"
            : "seed_only",
  };
  if (FEED.engines) {
    report.serial = FEED.serial;
    report.issued_at = FEED.issuedAt;
    report.expires_at = FEED.expiresAt;
    report.engines = FEED.engines.size;
    report.age_s = Math.max(0, Math.round((Date.now() - FEED.verifiedAt) / 1000));
  }
  if (FEED.movedTo) report.moved_to = FEED.movedTo;
  if (FEED.unsupportedKinds.length) report.unsupported_kinds = [...FEED.unsupportedKinds];
  if (FEED.invalidDescriptors.length) report.invalid_descriptors = [...FEED.invalidDescriptors];
  if (FEED.error) report.error = FEED.error;
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. THE TSP PIPELINE
// ═══════════════════════════════════════════════════════════════════════════
//
// Rows in, TSP JSON out — with the expensive half deferred.
//
// The local server runs the name parser over every row it collects, because it
// has twenty seconds of CPU to spend. A free Worker has ten milliseconds, so
// parsing three hundred rows to return fifty of them would spend most of the
// budget on rows nobody sees.
//
// So the pipeline here is ordered the other way round: build cheap rows, merge,
// filter, sort, cut to the page, and only then parse names and build magnets.
// The output is identical; the work is proportional to what the client asked for
// rather than to what the sites sent back. Do not "simplify" this into parsing
// everything up front — that is the change that puts the CPU bill back.

/**
 * The key a row deduplicates on: its infohash, or failing that its name and
 * size. The `h:`/`n:` prefix is also the sort's final tie-break, which is what
 * makes paging stable across requests.
 */
function dedupeKey(row) {
  if (row.infohash) return `h:${row.infohash}`;
  const slug = [...row.name.toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join("");
  return `n:${slug}:${row.sizeBytes === null ? "?" : row.sizeBytes}`;
}

function maxOrNull(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

/**
 * Collapse duplicates, keeping the best of each field.
 *
 * The longest name wins because it is the most descriptive release string, swarm
 * counts are `max`-ed because a stale engine under-reports, and every
 * contributing engine is recorded. Rows arrive in configured engine order, so
 * the engine listed first supplies the fields the others only fill in.
 */
function merge(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = dedupeKey(row);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, row);
      continue;
    }
    if (row.name.length > existing.name.length) existing.name = row.name;
    existing.seeders = maxOrNull(existing.seeders, row.seeders);
    existing.leechers = maxOrNull(existing.leechers, row.leechers);
    if (existing.sizeBytes === null) existing.sizeBytes = row.sizeBytes;
    if (existing.files === null) existing.files = row.files;
    existing.category = existing.category || row.category;
    existing.descriptionUrl = existing.descriptionUrl || row.descriptionUrl;
    existing.torrentUrl = existing.torrentUrl || row.torrentUrl;
    existing.infohash = existing.infohash || row.infohash;
    existing.sources = existing.sources.concat(row.sources);
    if (row.firstSeen && (existing.firstSeen === null || row.firstSeen < existing.firstSeen)) {
      existing.firstSeen = row.firstSeen;
    }
  }
  return [...merged.values()];
}

/** The parsed name for *row*, computed at most once. */
function parsedMeta(row) {
  if (row.meta === null) row.meta = parseName(row.name);
  return row.meta;
}

/**
 * Every spelling the name parser normalises to a given `res` token. Keep in step
 * with RESOLUTION_PATTERNS; the tests prove they agree.
 */
const RESOLUTION_SPELLINGS = {
  "2160p": ["2160p", "4k", "uhd", "3840"],
  "1080p": ["1080p", "1080i", "fhd", "1920"],
  "720p": ["720p", "hdready", "hd ready", "1280"],
  "480p": ["480p", "480i", "sd", "640x480", "854x480"],
};

/**
 * The TSP query filters, cheapest test first.
 *
 * `year` and `resolution` live inside the release name, which is what the parser
 * is for — and running that over every row is exactly what this section defers.
 * So each is a two-stage test: a substring pre-filter that costs nothing, then
 * the real parse on whatever survived it. The pre-filter can pass a row the real
 * parse then rejects; it cannot drop one the real parse would have kept.
 */
function applyFilters(rows, { category = "", year = "", resolution = "", minSeeders = 0 } = {}) {
  const resTokens = resolution ? RESOLUTION_SPELLINGS[resolution] || [resolution] : [];
  const kept = [];
  for (const row of rows) {
    if (minSeeders && (row.seeders || 0) < minSeeders) continue;
    if (category) {
      // Only a category we can read and that disagrees is grounds to drop. An
      // unreadable name means "no idea" — plenty of real releases are just a
      // title and a year, and a DHT crawl sends no category at all — and
      // treating that as "not video" made the video filter hide rows the
      // unfiltered search had just shown.
      const found = row.category || classifyName(row.name);
      if (found && found !== category) continue;
    }
    if (year && (!row.name.includes(year) || parsedMeta(row).year !== year)) continue;
    if (resTokens.length) {
      const lowered = row.name.toLowerCase();
      if (!resTokens.some((token) => lowered.includes(token))) continue;
      if (parsedMeta(row).resolution !== resolution) continue;
    }
    kept.push(row);
  }
  return kept;
}

/** Order by *sort*, descending, with a total tie-break for stable paging. */
function sortRows(rows, sort) {
  const decorated = rows.map((row) => {
    const key = dedupeKey(row);
    if (sort === "size") return { row, primary: [row.sizeBytes || 0, row.seeders || 0], key };
    if (sort === "recent") return { row, primary: [row.firstSeen || "", row.seeders || 0], key };
    return { row, primary: [row.seeders || 0, row.sizeBytes || 0], key };
  });

  decorated.sort((left, right) => {
    for (let index = 0; index < left.primary.length; index += 1) {
      const a = left.primary[index];
      const b = right.primary[index];
      if (a !== b) return a < b ? 1 : -1; // descending
    }
    if (left.key !== right.key) return left.key < right.key ? 1 : -1;
    return 0;
  });

  return decorated.map((entry) => entry.row);
}

/**
 * The TSP wire row, or null when it has no magnet to offer.
 *
 * This is where the deferred work happens, so it runs once per row the client
 * will actually see. Absent fields are omitted rather than sent as null, exactly
 * as the local server does it — TSP reads an absent numeric as zero.
 */
function toTorrent(row, scrapedAt) {
  if (!row.infohash) return null;

  const torrent = {
    magnet: magnetFor(row.infohash, row.name),
    infohash: row.infohash,
    name: row.name,
  };
  if (row.sizeBytes !== null) torrent.size_bytes = row.sizeBytes;
  if (row.files !== null) torrent.files = row.files;
  const category = row.category || classifyName(row.name);
  if (category) torrent.category = category;
  if (row.seeders !== null) torrent.seeders = row.seeders;
  if (row.leechers !== null) torrent.leechers = row.leechers;
  Object.assign(torrent, parsedMeta(row));
  if (row.firstSeen) torrent.first_seen = row.firstSeen;
  torrent.scraped_at = scrapedAt;
  if (row.torrentUrl) torrent.torrent_url = row.torrentUrl;
  if (row.descriptionUrl) torrent.description_url = row.descriptionUrl;
  if (row.sources.length) torrent.sources = [...new Set(row.sources)].sort();
  return torrent;
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. ROUTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What each engine did, the last time this isolate saw it do anything.
 *
 * A Worker has no durable state and no process: isolates come and go around
 * individual requests. This is therefore best-effort by construction, and it is
 * still the difference between a `/healthz` that says "ok" while every engine
 * returns 403 and one that says which engine is failing and how. Nothing is
 * fetched to fill it in — every entry is a by-product of a request that already
 * happened, so reading `/healthz` costs no outbound traffic and cannot be turned
 * into an amplifier by someone who does not have the key.
 *
 * `/api/v1/engines?probe=1` is the authoritative live answer, and needs the key.
 */
const LIVENESS = {
  engines: new Map(),

  origin(engineId, origin) {
    const entry = this.engines.get(engineId) || {};
    entry.origin = origin.url;
    entry.origin_from = origin.from;
    this.engines.set(engineId, entry);
  },

  outcome(engineId, { ok, rows, error, ms }) {
    const entry = this.engines.get(engineId) || {};
    // `rate_limited` is its own state: the index is working and this deployment
    // is asking too often. Pointing it at a new address — the repair for
    // everything else here — makes a throttle worse, not better.
    entry.last = ok
      ? "ok"
      : error.startsWith("timeout")
        ? "timeout"
        : error.startsWith("rate limited")
          ? "rate_limited"
          : "error";
    entry.rows = rows;
    entry.ms = ms;
    entry.at = Date.now();
    if (error) entry.error = error;
    else delete entry.error;
    this.engines.set(engineId, entry);
  },

  /** What `/healthz` reports, for every engine the deployment could run. */
  report(settings) {
    const report = {};
    for (const engineId of allEngineIds()) {
      if (!isEnabled(engineId, settings)) continue;
      const seen = this.engines.get(engineId) || {};
      const candidates = originsFor(engineId, settings);
      const entry = {
        origin: seen.origin || (candidates[0] ? candidates[0].url : siteFor(engineId)),
        origin_from: seen.origin_from || (candidates[0] ? candidates[0].from : "configured"),
        last: seen.last || "unused",
        // Which layer configured this engine, so an operator override being
        // quietly shadowed — or a feed entry not taking — is visible.
        config: configLayerFor(engineId, settings),
      };
      if (seen.last) {
        entry.rows = seen.rows;
        entry.ms = seen.ms;
        entry.seconds_ago = Math.max(0, Math.round((Date.now() - seen.at) / 1000));
      }
      const stats = ROW_STATS.get(engineId);
      if (stats && stats.seen) {
        entry.rows_seen = stats.seen;
        entry.rows_emitted = stats.emitted;
        entry.drop_ratio = Math.round(((stats.seen - stats.emitted) / stats.seen) * 100) / 100;
      }
      if (seen.error) entry.error = seen.error;
      report[engineId] = entry;
    }
    return report;
  },
};

/**
 * The update check, memoised for an hour.
 *
 * It runs on `/healthz` and nowhere else — never on the search path, where it
 * would add a subrequest to every query. Two layers of caching: Cloudflare's
 * own, asked for with `cf.cacheTtl` so a colo that has already looked answers
 * without leaving the building, and this variable, which survives for as long as
 * the isolate does and is what actually bounds the traffic on a `workers.dev`
 * URL, where the `cf` options are documented not to apply.
 *
 * A Worker that cannot reach the feed simply omits the field. Nothing about
 * searching depends on it, and UTSI_UPDATE_CHECK=0 switches it off entirely —
 * it is the one request this Worker makes that is not on your behalf.
 */
const UPDATE_MEMO = { at: 0, value: null };
const UPDATE_TTL_MS = 3600 * 1000;

async function checkForUpdate(http) {
  if (UPDATE_MEMO.value && Date.now() - UPDATE_MEMO.at < UPDATE_TTL_MS) return UPDATE_MEMO.value;
  try {
    const [status, body] = await http.text(UPDATE_FEED, {
      timeout: 3,
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (status !== 200) return null;
    const published = JSON.parse(body);
    const latest = String(published.version || "").trim();
    if (!latest) return null;
    const value = { latest, available: latest !== VERSION, source: UPDATE_FEED };
    UPDATE_MEMO.at = Date.now();
    UPDATE_MEMO.value = value;
    return value;
  } catch {
    return null;
  }
}

// --- auth --------------------------------------------------------------------

/** Where to go and change the key. The dashboard first: most people never open a terminal. */
const WHERE =
  "Open your Worker in the Cloudflare dashboard, press Edit code, and put your key on the " +
  "API_KEY line at the top of the file. Or set UTSI_API_KEY under Settings > Variables and Secrets.";

function keyComplaint(settings) {
  if (keyProblem(settings) === "short") {
    return [
      "api_key_too_short",
      `UTSI_API_KEY is ${settings.apiKey.length} characters and needs at least ${MIN_KEY_LENGTH}. ` +
        `This URL is public and answers 100,000 times a day, so a short key is a guessable one — ` +
        `four random words is plenty. ${WHERE}`,
    ];
  }
  return [
    "not_configured",
    `This Worker has no API key, so it refuses every request rather than serving without one. ` +
      `${WHERE} Or set UTSI_ALLOW_ANONYMOUS=1 to serve with no key at all, which on a public URL ` +
      `is an open scraper proxy.`,
  ];
}

/**
 * Compare two keys without letting the time taken say how much of one matched.
 *
 * The length is allowed to leak — it always does, over HTTP — but the content is
 * not, which is what stops a caller guessing the key one character at a time.
 */
function timingSafeEqual(presented, expected) {
  let difference = presented.length ^ expected.length;
  const length = Math.max(presented.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (presented.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/**
 * Null when the caller may proceed, otherwise the refusal to send.
 *
 * Both spellings are accepted because TSP clients differ: `X-API-Key` is what
 * the local server documents, `Authorization: Bearer` is what a generic HTTP
 * client reaches for. The key never travels in the query string — it would be in
 * Cloudflare's request logs, and in the referrer of anything the client links
 * onward.
 */
function authorize(settings, headers) {
  if (!isConfigured(settings)) return error(503, ...keyComplaint(settings));
  if (settings.allowAnonymous) return null;

  let presented = headers.get("x-api-key") || "";
  if (!presented) {
    const authorization = headers.get("authorization") || "";
    if (authorization.slice(0, 7).toLowerCase() === "bearer ") {
      presented = authorization.slice(7).trim();
    }
  }
  if (!presented) return error(401, "missing_api_key", "Send the key in the X-API-Key header.");
  if (!timingSafeEqual(presented, settings.apiKey)) {
    return error(403, "invalid_api_key", "The X-API-Key header did not match.");
  }
  return null;
}

// --- replies -----------------------------------------------------------------

function reply(status, body, headers = null, text = null) {
  return { status, body, headers, text };
}

function error(status, name, detail = null, headers = null) {
  const body = { error: name };
  if (detail) body.detail = detail;
  return reply(status, body, headers);
}

// --- query -------------------------------------------------------------------

/** Validate a TSP query string, or say exactly what was wrong with it. */
function readQuery(params) {
  const one = (name) => (params.get(name) || "").trim();

  const cat = one("cat");
  if (cat && !TSP_CATEGORIES.includes(cat)) {
    return error(400, "invalid_cat", `cat must be one of ${TSP_CATEGORIES.join(", ")}`);
  }
  const sort = one("sort");
  if (sort && !SORTS.includes(sort)) {
    return error(400, "invalid_sort", "sort must be one of seeders, size, recent");
  }
  const res = one("res");
  if (res && !RESOLUTIONS.includes(res)) {
    return error(400, "invalid_res", `res must be one of ${RESOLUTIONS.join(", ")}`);
  }
  const year = one("year");
  if (year && !/^\d{4}$/.test(year)) {
    return error(400, "invalid_year", "year must be four digits");
  }

  const number = (name, fallbackValue) => {
    const raw = one(name);
    if (!raw) return fallbackValue;
    return /^[+-]?\d+$/.test(raw) ? Number(raw) : fallbackValue;
  };

  // Clamped rather than rejected: a 422 is not in TSP's retry contract.
  return {
    q: one("q"),
    cat,
    year,
    res,
    minSeeders: Math.max(0, number("min_seeders", 0)),
    sort,
    limit: Math.max(1, Math.min(number("limit", DEFAULT_LIMIT), MAX_LIMIT)),
    offset: Math.max(0, number("offset", 0)),
    terms: "",
  };
}

// --- fan-out -----------------------------------------------------------------

/**
 * An engine's complaint, with the deployer's own secrets taken back out of it.
 *
 * `upstream`, `fallback` and `torznab` point at a server the deployer runs; the
 * address is a secret because it is a private machine, and torznab's key travels
 * in the query string. A transport failure is raised by the runtime, not by this
 * file, and Workers spells it `Fetch API cannot load: <the whole URL>` — which
 * reaches `engine_errors`, and reaches LIVENESS and so `/healthz`, which needs no
 * key at all. Scrubbed here, once, before anything can store or send it.
 */
function redact(message, settings) {
  let text = String(message);
  for (const secret of [
    settings.upstreamUrl, settings.fallbackUrl, settings.torznabUrl,
    settings.upstreamApikey, settings.fallbackApikey, settings.torznabApikey,
  ]) {
    // Short values are not addresses or keys, and blanking them would turn an
    // ordinary message into confetti.
    if (secret && secret.length > 6) text = text.split(secret).join("[redacted]");
  }
  return text;
}

async function runEngine(engineId, http, query, settings, deadline = 0) {
  const started = Date.now();
  // Clamped against the request's own clock, which is what makes the deadline
  // real: unclamped, an engine budget simply outlives a deadline that races each
  // task separately, so nothing enforced the whole-request bound and `partial`
  // was never emitted. Half a second is the floor — below it an engine cannot
  // finish, and a timeout it had no chance to avoid is worse than not asking.
  const remaining = deadline ? Math.max(0.5, (deadline - started) / 1000) : Infinity;
  const budget = Math.min(timeoutFor(settings, engineId), remaining);
  // Whether the request's clock is what stopped this engine, rather than its own
  // budget. The difference is the whole of `partial`: an engine that refused us
  // is reported in `engine_errors` and the answer is complete, an engine we ran
  // out of time for means the client is looking at a subset.
  const cutShort = budget < timeoutFor(settings, engineId);
  let rows = [];
  let outcome;

  try {
    const engine = engineFor(engineId);
    if (!engine) throw new EngineError(`no such engine ${engineId}`);
    const result = await raceTimeout(engine(http, query, settings), budget * 1000);
    if (result === TIMED_OUT) {
      outcome = {
        engineId, ok: false, rows: 0, cut: cutShort,
        error: `timeout after ${Math.round(budget * 10) / 10}s`,
      };
    } else {
      rows = result;
      outcome = { engineId, ok: true, rows: rows.length, error: "" };
    }
  } catch (thrown) {
    const message =
      thrown instanceof EngineError ? String(thrown.message) : `${thrown.name}: ${thrown.message}`;
    outcome = { engineId, ok: false, rows: 0, error: redact(message, settings).slice(0, 300) };
  }

  outcome.elapsedMs = Date.now() - started;
  LIVENESS.outcome(engineId, { ...outcome, ms: outcome.elapsedMs });
  return [rows, outcome];
}

/**
 * Every engine at once; return when they are all done or time is up.
 *
 * They run concurrently but their rows are collected **in configured order**, not
 * in the order they happened to finish. That is what makes the first entry in
 * UTSI_ENGINES the primary one: `merge()` keeps the first row it sees for a given
 * release and fills the gaps from later ones, so whichever engine is listed first
 * supplies the category, the description link and the name that reach the
 * client. Collecting in completion order would hand that decision to whichever
 * site answered quickest, and it would differ every run.
 */
async function fanOut(http, query, settings) {
  if (!settings.engines.length) return [[], [], false];

  // One clock for the whole fan-out, not one per engine. A metasearch is only as
  // fast as its slowest member unless it will leave one behind, and this is where
  // it becomes willing: on a live deployment five engines finished inside 805ms
  // while a sixth took 5,535ms and returned nothing.
  const deadline = Date.now() + settings.requestDeadlineS * 1000;
  const started = settings.engines.map((engineId) =>
    runEngine(engineId, http, query, settings, deadline),
  );
  const finished = await Promise.all(
    started.map((task) => raceTimeout(task, settings.requestDeadlineS * 1000)),
  );

  const rows = [];
  const outcomes = [];
  let timedOut = false;
  for (const result of finished) {
    if (result === TIMED_OUT) {
      timedOut = true;
      continue;
    }
    const [engineRows, outcome] = result;
    // Either spelling of running out of time: the whole task lost its race, or
    // one engine's budget was clipped by the request's clock and it hit it.
    if (outcome.cut) timedOut = true;
    rows.push(...engineRows);
    outcomes.push(outcome);
  }
  return [rows, outcomes, timedOut];
}

// --- link resolution ---------------------------------------------------------

/**
 * Turn `.torrent` URLs into infohashes, for at most `maxResolve` rows.
 *
 * Only Torznab produces rows that need this, and only for indexers that hand
 * back a file rather than a magnet. Off by default: it is an extra fetch per row
 * and a SHA-1 over the file, and a search that does not need it should not pay
 * for the code path being there.
 */
async function resolveLinks(rows, http, settings) {
  const pending = rows
    .filter((row) => !row.infohash && row.torrentUrl)
    .slice(0, settings.maxResolve);
  if (!pending.length) return;

  await Promise.all(
    pending.map(async (row) => {
      let status;
      let data;
      try {
        const result = await raceTimeout(
          http.bytes(row.torrentUrl, { timeout: settings.engineTimeoutS }),
          settings.engineTimeoutS * 1000,
        );
        // A row that will not resolve is dropped later for having no magnet.
        // There is nothing else worth saying about it.
        if (result === TIMED_OUT) return;
        [status, data] = result;
      } catch {
        return;
      }
      if (status !== 200 || !data || !data.length) return;
      const meta = await parseTorrent(data.subarray(0, TORRENT_MAX_BYTES));
      if (!meta) return;
      row.infohash = meta.infohash;
      if (row.sizeBytes === null) row.sizeBytes = meta.sizeBytes;
      if (row.files === null) row.files = meta.files;
    }),
  );
}

// --- the search --------------------------------------------------------------

/**
 * The generic query that stands in for an empty one.
 *
 * Which generic query depends on the category, because the sites are asked for
 * that category too: browsing `cat=audio` for "1080p" asks each site for the
 * music torrents that mention a video resolution, and there are none.
 *
 * The local server keeps a cycle and advances it per request. That cannot work
 * here — isolates are created and discarded around individual requests, so the
 * cycle would restart at unpredictable moments — and it would be the wrong shape
 * anyway: advancing per request means `offset=0` and `offset=50` browse
 * *different* queries, which is not a page two of anything. Rotating on the clock
 * instead is stateless, and holds still long enough to page through.
 */
function browseQuery(settings, category = "") {
  const terms = BROWSE_TERMS[category] || (settings.browseQueries.length ? settings.browseQueries : ["1080p"]);
  return terms[Math.floor(Date.now() / 1000 / BROWSE_ROTATION_S) % terms.length];
}

async function search(query, http, settings) {
  const started = Date.now();
  const took = () => Date.now() - started;

  // Engines read `terms`, never `q`: TSP's separator rules are applied once,
  // here, so every engine is asked the same question.
  query.terms = normalizeQuery(query.q);
  let browsing = "";
  if (!query.terms) {
    // An empty `q` is legal in TSP and means "browse the whole index". A
    // metasearch has no index to browse, so a generic query stands in for one —
    // the same answer the local server gives, and the same setting turns it off.
    if (settings.emptyQueryMode === "empty") {
      return reply(200, {
        query: query.q,
        count: 0,
        limit: query.limit,
        offset: query.offset,
        took_ms: took(),
        torrents: [],
        engines: [],
      });
    }
    browsing = browseQuery(settings, query.cat);
    query.terms = browsing;
  }

  // A small page does not need the full candidate set. Engines answer with their
  // best-seeded matches first, so twice the window — with a floor for the merge
  // collapsing duplicates across engines — fills it, and parsing rows is the
  // request's main CPU cost, so a `limit=5` client should not pay for a hundred
  // rows an engine. Only when nothing filters afterwards: a category, year or
  // seeder filter can throw most candidates away, and then the full set is
  // exactly what is needed.
  if (!(query.cat || query.year || query.res || query.minSeeders)) {
    const window = Math.max(20, (query.offset + query.limit) * 2);
    if (window < settings.maxRowsPerEngine) settings = { ...settings, maxRowsPerEngine: window };
  }

  const [rows, outcomes, timedOut] = await fanOut(http, query, settings);

  const shape = (collected) =>
    sortRows(
      applyFilters(merge(collected), {
        category: query.cat,
        year: query.year,
        resolution: query.res,
        minSeeders: query.minSeeders,
      }),
      query.sort,
    );

  let ordered = shape(rows);

  // Nothing at all, from every engine that ran. Only now is the fallback asked —
  // an ordinary search never reaches this line — and only when UTSI_FALLBACK_URL
  // was pointed at an index of the deployer's own: nothing ships configured, so
  // by default the empty answer simply stands.
  if (settings.fallback && settings.fallbackUrl && !ordered.some((row) => row.infohash)) {
    const [extra, outcome] = await runEngine(
      "fallback", http, query, settings, started + settings.requestDeadlineS * 1000,
    );
    outcomes.push(outcome);
    if (extra.length) ordered = shape(rows.concat(extra));
  }

  // Resolve only inside the window the client can see, then re-merge: an
  // infohash discovered here can collapse a row against one that already had
  // theirs.
  if (settings.maxResolve) {
    await resolveLinks(ordered.slice(0, query.offset + query.limit), http, settings);
    ordered = sortRows(merge(ordered), query.sort);
  }

  const final = ordered.filter((row) => row.infohash);
  const scrapedAt = nowIso();
  const page = [];
  for (const row of final.slice(query.offset, query.offset + query.limit)) {
    const torrent = toTorrent(row, scrapedAt);
    if (torrent !== null) page.push(torrent);
  }

  const body = {
    query: query.q,
    count: final.length,
    limit: query.limit,
    offset: query.offset,
    took_ms: took(),
    torrents: page,
    engines: outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.engineId),
  };
  if (browsing) {
    // Not TSP. Without it, an empty search comes back full of rows with nothing
    // to explain why, and the honest answer — "you asked for everything, so it
    // picked something" — is not guessable from the rows.
    body.browse_query = browsing;
  }
  if (timedOut) body.partial = true;

  const failures = {};
  for (const outcome of outcomes) if (!outcome.ok) failures[outcome.engineId] = outcome.error;
  if (Object.keys(failures).length) {
    // Not TSP either, and clients ignore unknown fields. It is here because with
    // observability off — which is the default, so searches are not written into
    // a log — an empty result set is otherwise indistinguishable from a site
    // returning 403 to Cloudflare's addresses.
    body.engine_errors = failures;
  }
  return reply(200, body);
}

// --- which engines actually work, from here ----------------------------------

/** `fallback` is never in the roster; it runs when it has an address. */
function isEnabled(engineId, settings) {
  if (engineId === "fallback") return settings.fallback && !!settings.fallbackUrl;
  return settings.engines.includes(engineId);
}

/** Every engine this deployment could name: compiled in, plus the feed's own. */
function allEngineIds() {
  if (!FEED.engines) return KNOWN_ENGINES;
  const ids = [...KNOWN_ENGINES];
  for (const name of FEED.engines.keys()) if (!ids.includes(name)) ids.push(name);
  return ids;
}

/** `broad` or `narrow`, wherever the engine came from. Unclassified is narrow. */
function breadthFor(engineId) {
  const fed = feedDescriptorFor(engineId);
  if (fed && fed.breadth) return fed.breadth;
  const seeded = SEED_BY_NAME.get(engineId);
  return ENGINE_BREADTH[engineId] || (seeded && seeded.breadth) || "narrow";
}

/** What `/api/v1/engines` names an engine, wherever it came from. */
function siteFor(engineId) {
  if (ENGINE_SITES[engineId]) return ENGINE_SITES[engineId];
  const descriptor = feedDescriptorFor(engineId) || SEED_BY_NAME.get(engineId);
  return descriptor && descriptor.site ? descriptor.site : "";
}

/**
 * Which layer configures *engineId*. Highest wins, and `/healthz` says which
 * one won so an operator override never silently loses to feed content.
 */
function configLayerFor(engineId, settings) {
  if (settings.engineUrls[engineId]) return "env";
  if (["upstream", "fallback", "torznab"].includes(engineId)) return "env";
  if (feedDescriptorFor(engineId)) return "feed";
  return "seed";
}

/**
 * Run every known engine once and report what happened.
 *
 * The measurement that matters is this one. A daily job elsewhere can tell us
 * whether an adapter still parses what a site returns — that is a code question
 * with one answer for everybody — but it cannot tell you whether that site will
 * talk to *your* Worker. Cloudflare's addresses are not GitHub's, and being
 * refused is per-network. So the answer to "which engines should I turn on" has
 * to come from the deployment asking.
 *
 * Every engine is tried, including the ones UTSI_ENGINES leaves out, since the
 * point is to find out what is available rather than to confirm what is on. Rows
 * are capped hard: this is a diagnostic, and one that says "yes, ten rows came
 * back" is as useful as one that fetches a hundred.
 */
async function probe(http, settings) {
  const budget = { ...settings, maxRowsPerEngine: 10 };
  const query = { q: "", terms: browseQuery(settings), cat: "", year: "", res: "", minSeeders: 0 };

  const results = await Promise.all(
    allEngineIds().map(async (engineId) => {
      const [rows, outcome] = await runEngine(engineId, http, query, budget);
      const result = {
        id: engineId,
        url: siteFor(engineId),
        enabled: isEnabled(engineId, settings),
        ok: outcome.ok,
        rows: rows.length,
        ms: outcome.elapsedMs,
      };
      if (outcome.error) result.error = outcome.error;
      // Answered, parsed, and had nothing to say. Not a failure, but not a
      // working engine either, and the difference is worth naming.
      else if (outcome.ok && !rows.length) result.error = "answered with no rows";
      return result;
    }),
  );

  return [
    {
      query: query.terms,
      // The fallback is deliberately absent: it is not a value UTSI_ENGINES
      // accepts, and pasting it there would be rejected.
      usable: results
        .filter((row) => row.ok && row.rows && row.id !== "fallback")
        .map((row) => row.id)
        .join(","),
    },
    ...results,
  ];
}

// --- routing -----------------------------------------------------------------

const BANNER = `Unified Torrent Search Interface

  GET /api/v1/search?q=...   send the key as the X-API-Key header
  GET /api/v1/engines        which engines this instance runs
  GET /healthz               liveness, no key needed

https://github.com/momzv2022-ctrl/unified-torrent-search-interface
`;

/** Escape for HTML text and double-quoted attributes. */
function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/**
 * The one page this Worker serves, and the reason it serves any.
 *
 * A Worker knows its own address; the setup page that minted the key does not,
 * and cannot — Cloudflare invents the account part and lengthens the name. So
 * for a long time the last step of setup was "read the address off Cloudflare's
 * screen and type it back into the other tab", which is the step people got
 * wrong. This page removes it: it is the address, and it carries a link back to
 * the setup page with the address in the fragment.
 *
 * **It never shows the key.** Anyone who can reach this page can read every word
 * on it, and every `*.workers.dev` hostname appears in public certificate
 * transparency logs within minutes of being created. So the address — which is
 * not a secret, since the key is what guards the API — is here, and the key
 * stays where it already is: in this Worker's code, and in the browser that made
 * it.
 */
function landingPage(host) {
  const url = escapeHtml(host);
  const back = escapeHtml(SETUP_PAGE + "#url=" + encodeURIComponent(host));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<title>Your search is live</title>
<style>
:root { --bg:#fff; --ink:#111; --muted:#666; --line:#e5e5e5; --soft:#fafafa; --code:#f6f6f6;
  /* Cloudflare's orange at 38% lightness, so white on it clears WCAG AA. The
     same orange marks the thing to press on the setup page, and this page has
     exactly one thing to press. */
  --accent:#ba5a08; }
* { box-sizing:border-box; }
body { margin:0; padding:2rem 1.15rem 5rem; background:var(--bg); color:var(--ink);
  font:17px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  overflow-wrap:break-word; -webkit-font-smoothing:antialiased; }
main { max-width:34rem; margin:0 auto; }
h1 { font-size:1.6rem; line-height:1.2; letter-spacing:-.022em; margin:0 0 .5rem; font-weight:700; }
h2 { font-size:1rem; margin:2rem 0 .3rem; font-weight:650; letter-spacing:-.008em; }
p { margin:.7rem 0; }
a { color:var(--ink); text-underline-offset:2px; }
.lede { color:var(--muted); margin-bottom:1.4rem; }
.note { color:var(--muted); font-size:.935rem; }
.card { border:1px solid var(--line); border-radius:10px; padding:1rem; margin:1.1rem 0; }
label { display:block; font-size:.82rem; font-weight:650; letter-spacing:.01em;
  text-transform:uppercase; color:var(--muted); margin-bottom:.3rem; }
.value { font:500 .98rem/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--code); border:1px solid var(--line); border-radius:8px; padding:.7rem .75rem;
  user-select:all; -webkit-user-select:all; margin-bottom:.9rem; }
a.btn, button { display:flex; align-items:center; justify-content:center; width:100%;
  min-height:3.15rem; padding:.8rem 1rem; font:inherit; font-weight:600; letter-spacing:-.005em;
  text-align:center; text-decoration:none; border:1px solid var(--accent); border-radius:8px;
  background:var(--accent); color:#fff; cursor:pointer; font-size:1.05rem; }
button.ghost { background:var(--bg); color:var(--ink); border-color:var(--line); margin-top:.5rem; }
a.btn:active, button:active { transform:translateY(1px); }
code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.9em;
  background:var(--code); padding:.1em .32em; border-radius:4px; }
.status { min-height:1.35rem; margin-top:.5rem; font-size:.9rem; font-weight:600; text-align:center; }
footer { margin-top:2.8rem; padding-top:1.2rem; border-top:1px solid var(--line);
  color:var(--muted); font-size:.89rem; }
</style>
</head>
<body>
<main>

<h1>Your search is live</h1>
<p class="lede">
  <strong>One tap left. Press Finish setup below.</strong> That is the only
  thing this page is for: it hands your URL back to the page that made your key,
  so you get both together, ready to copy.
</p>

<div class="card">
  <label>Your URL</label>
  <div class="value" id="url">${url}</div>
  <a class="btn" href="${back}">Finish setup &nearr;</a>
  <button class="ghost" id="copy" type="button">Copy the URL</button>
  <div class="status" id="status" role="status" aria-live="polite"></div>
  <p class="note" style="margin-bottom:0">
    Finish setup opens the page you started on, with this URL already in it, so
    it can show you the URL and the key together and let you test them. The URL
    travels after the <code>#</code>, which your browser never sends to a server.
  </p>
</div>

<h2>If that page no longer has your key</h2>
<p class="note">
  It is not lost. Open this Worker in the Cloudflare dashboard, press
  <strong>Edit code</strong>, and read the line near the top that starts
  <code>const API_KEY</code>. You can also replace it from Settings, Variables
  and Secrets, as <code>UTSI_API_KEY</code>, which wins over the line in the file.
</p>

<h2>Two more URLs worth knowing</h2>
<p class="note">
  <a href="/healthz">/healthz</a> says which indexes are answering and what
  broke. It needs no key.<br>
  <code>/api/v1/search?q=&hellip;</code> is the search itself, with your key in
  an <code>X-API-Key</code> header.
</p>

<footer>
  Unified Torrent Search Interface ${VERSION} &middot;
  <a href="https://github.com/momzv2022-ctrl/unified-torrent-search-interface" rel="noopener">source and documentation</a>
  <p style="margin:.5rem 0 0">
    This URL is yours alone. There is no public instance of this and no list of
    other people's. MIT licence, no warranty, no liability.
  </p>
</footer>

</main>
<script>
document.getElementById("copy").addEventListener("click", function () {
  var status = document.getElementById("status");
  var text = location.protocol + "//" + location.host;
  function done() { status.textContent = "URL copied."; setTimeout(function () { status.textContent = ""; }, 4000); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { status.textContent = "Could not copy. Select it by hand."; });
    return;
  }
  status.textContent = "Could not copy. Select it by hand.";
});
</script>
</body>
</html>
`;
}

/** Named origins only. A wildcard would let any page spend this instance. */
function corsHeaders(settings, origin) {
  if (!origin || !settings.corsOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "X-API-Key, Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

async function healthz(http, settings) {
  const configured = isConfigured(settings);
  const liveness = LIVENESS.report(settings);
  const entries = Object.entries(liveness);
  const observed = entries.filter(([, entry]) => entry.last !== "unused");
  const answering = observed.filter(([, entry]) => entry.last === "ok");
  const isBroad = (engineId) => breadthFor(engineId) === "broad";
  const broadAnswering = answering.filter(([engineId]) => isBroad(engineId));

  // `broad` — a general index is up, so any search has a chance. `narrow` — only
  // single-subject engines answered: films and anime work, a book or a disk
  // image finds nothing. `none` — everything tried failed. `unknown` — this
  // isolate has not run a search yet.
  const coverage = !observed.length
    ? "unknown"
    : broadAnswering.length
      ? "broad"
      : answering.length
        ? "narrow"
        : "none";

  // Losing every broad engine while a narrow one survives is the failure the old
  // check called "ok". It counts as degraded only when broad engines are
  // switched on at all: a roster narrow because the operator chose it is fine.
  const shortOfCoverage = settings.engines.some(isBroad) && !broadAnswering.length;

  const body = {
    // "ok" only when this Worker can serve *and* nothing it has actually tried
    // came back broken. A Worker whose every engine is returning 403 is not ok,
    // and saying so is the whole reason this endpoint reports per-engine state:
    // nobody is watching a build log in a paste-and-deploy world.
    status:
      !configured
        ? "not_configured"
        : observed.length && (!answering.length || shortOfCoverage)
          ? "degraded"
          : "ok",
    api_key: configured ? "ok" : keyProblem(settings),
    coverage,
    version: VERSION,
    runtime: "cloudflare-worker",
    engines_ready: settings.engines.length,
    engines: [...settings.engines],
    anonymous: settings.allowAnonymous,
    // Per engine: the address in use and where that address came from, and what
    // happened the last time this isolate asked it anything. `unused` means this
    // isolate has not run a search yet — run one, then look again.
    engine_status: liveness,
  };
  if (Object.keys(settings.rejectedEngines).length) {
    // UTSI_ENGINES naming something that cannot run — a typo, or an engine whose
    // URL was never set — would otherwise look identical to it working.
    body.rejected_engines = { ...settings.rejectedEngines };
  }
  // Where the engine configuration is coming from, and why, including the one
  // announcement that survives the code host disappearing: `moved_to`.
  body.feed = feedReport(settings);
  if (settings.updateCheck) {
    const update = await checkForUpdate(http);
    if (update) body.update = update;
  }
  return body;
}

/** Route one request. Everything above this is reachable from tests alone. */
async function handle(method, url, headers, http, settings) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const cors = corsHeaders(settings, headers.get("origin") || "");

  if (method === "OPTIONS") return reply(204, null, cors);
  if (method !== "GET" && method !== "HEAD") {
    return error(405, "method_not_allowed", "This API is read-only.", {
      ...cors,
      Allow: "GET, OPTIONS",
    });
  }

  if (path === "/healthz") return reply(200, await healthz(http, settings), cors);

  // Nothing here is worth a search engine's time, and a list of live instances
  // is the one thing this project does not want to exist.
  if (path === "/robots.txt") return reply(200, null, cors, "User-agent: *\nDisallow: /\n");

  if (path === "/") {
    if (!settings.banner) return error(404, "not_found", "No route here. Try /api/v1/search.", cors);
    // A browser gets the page that closes the setup loop; anything else — curl,
    // a client, a monitor — gets the plain text it has always got.
    const wantsHtml = (headers.get("accept") || "").includes("text/html");
    if (!wantsHtml) return reply(200, null, cors, BANNER);
    return reply(200, null, { ...cors, "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" },
      landingPage(parsed.host));
  }

  if (path === "/api/v1/engines") {
    const refusal = authorize(settings, headers);
    if (refusal) return reply(refusal.status, refusal.body, { ...cors, ...(refusal.headers || {}) });
    if (["1", "true", "yes"].includes((parsed.searchParams.get("probe") || "").trim())) {
      return reply(200, await probe(http, settings), cors);
    }
    return reply(
      200,
      allEngineIds().map((engineId) => ({
        id: engineId,
        name: engineId,
        url: siteFor(engineId),
        source: "worker",
        link_kind: "magnet",
        enabled: isEnabled(engineId, settings),
      })),
      cors,
    );
  }

  if (path === "/api/v1/search") {
    const refusal = authorize(settings, headers);
    if (refusal) return reply(refusal.status, refusal.body, { ...cors, ...(refusal.headers || {}) });
    const query = readQuery(parsed.searchParams);
    if (query.status) return reply(query.status, query.body, cors);
    const answer = await search(query, http, settings);
    return reply(answer.status, answer.body, { ...cors, ...(answer.headers || {}) });
  }

  return error(404, "not_found", "No route here. Try /api/v1/search.", cors);
}

/**
 * A reply as (status, body, headers), ready for any HTTP runtime.
 *
 * The body is null, not `""`, when there is nothing to send: 204 and 304 are
 * "null body" statuses and the `Response` constructor rejects a string body for
 * them.
 */
function render(answer) {
  const headers = { ...(answer.headers || {}) };
  if (answer.text !== null && answer.text !== undefined) {
    if (!("Content-Type" in headers)) headers["Content-Type"] = "text/plain; charset=utf-8";
    return [answer.status, answer.text, headers];
  }
  if (answer.body === null || answer.body === undefined) return [answer.status, null, headers];
  if (!("Content-Type" in headers)) headers["Content-Type"] = "application/json";
  return [answer.status, JSON.stringify(answer.body), headers];
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. ENTRY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `fetch()` reduced to the two shapes the engines need.
 *
 * A site that dislikes the default Worker fingerprint says so with a 403, which
 * surfaces as an engine error rather than a silent zero — so the User-Agent this
 * sends is this project's, honestly, rather than a browser's.
 */
function httpClient(userAgent = USER_AGENT) {
  const send = async (url, { timeout, headers, method = "GET", body = null, accept, cf }) => {
    const options = {
      method,
      headers: { "User-Agent": userAgent, Accept: accept, ...(headers || {}) },
      signal: AbortSignal.timeout(Math.round(timeout * 1000)),
    };
    if (body !== null) options.body = body;
    if (cf) options.cf = cf;
    return fetch(url, options);
  };

  return {
    async text(url, options) {
      const response = await send(url, { accept: "application/json, text/xml, */*", ...options });
      if (response.status !== 200) return [response.status, ""];
      return [response.status, await response.text()];
    },
    async bytes(url, options) {
      const response = await send(url, { accept: "application/x-bittorrent, */*", ...options });
      if (response.status !== 200) return [response.status, new Uint8Array()];
      return [response.status, new Uint8Array(await response.arrayBuffer())];
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const settings = readSettings(env || {});
    const http = httpClient();
    // The feed refresh rides along behind real traffic and never blocks it: a
    // search uses whatever configuration is already resolved, and the refresh
    // finishes after the response has gone.
    maybeRefreshFeed(http, settings, ctx && ctx.waitUntil ? ctx.waitUntil.bind(ctx) : null);
    const answer = await handle(request.method, request.url, request.headers, http, settings);
    const [status, body, headers] = render(answer);
    return new Response(body, { status, headers });
  },

  // A cron trigger, when the deployment has one, keeps the feed fresh without
  // waiting for traffic. Optional on purpose: a paste-one-file deployment has
  // no cron, and the fetch-path refresh above is enough.
  async scheduled(controller, env, ctx) {
    const settings = readSettings(env || {});
    if (!settings.feed || !TGP_ROOT_KEYS.length) return;
    ctx.waitUntil(refreshFeed(httpClient(), settings).catch(() => false));
  },
};

/**
 * The seam the test suite reaches through, and the only thing in this file that
 * is not part of running a search.
 *
 * The Workers runtime imports the default export above and never looks at this.
 * It is here so `worker/tests/worker.test.mjs` can drive the pipeline directly —
 * with the network replaced by a table of fixtures — instead of only through
 * `fetch()`, which is what makes the whole of this file testable without a
 * Worker, a network, or a torrent site anywhere near it.
 */
export const __testing = {
  API_KEY,
  DEFAULT_ENGINES,
  ENGINES,
  ENGINE_BREADTH,
  ENGINE_ORIGINS,
  ENGINE_SITES,
  FEED,
  KNOWN_ENGINES,
  LIVENESS,
  ROW_STATS,
  SEED_DESCRIPTORS,
  UPDATE_MEMO,
  MIN_KEY_LENGTH,
  RESOLUTION_SPELLINGS,
  TGP_ROOT_KEYS,
  TSP_CATEGORIES,
  BROWSE_TERMS,
  VERSION,
  EngineError,
  coerceValue: (target, value, spec = {}) => coerceValue(target, value, spec),
  descriptorProblem,
  evalField,
  feedSiblings,
  maybeRefreshFeed,
  readExpr,
  refreshFeed,
  resetFeed,
  resolvePath,
  runDescriptor,
  verifyFeedDocuments,
  applyFilters,
  browseQuery,
  classifyName,
  dedupeKey,
  fanOut,
  handle,
  htmlUnescape,
  humanSize,
  isEnabled,
  magnetFor,
  merge,
  normalizeInfohash,
  normalizeQuery,
  originsFor,
  parseName,
  parseTorrent,
  parseTorznab,
  probe,
  pubDate,
  quote,
  readQuery,
  readSettings,
  render,
  search,
  sortRows,
  toTorrent,
};
