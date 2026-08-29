/**
 * Ask every index this project knows about whether it is still there.
 *
 *     node worker/tools/probe-indexes.mjs
 *     node worker/tools/probe-indexes.mjs --json
 *     node worker/tools/probe-indexes.mjs --query "ubuntu 24.04"
 *
 * There is already `/api/v1/engines?probe=1`, and it answers a different
 * question: which of the engines *your Worker runs* are answering *it*. This
 * one runs from wherever you are, and includes indexes the Worker does not
 * carry — so it is the tool for two questions that one cannot answer:
 *
 *   1. Is this index dead, or is it just refusing Cloudflare's addresses?
 *      Run this from home, compare with `?probe=1` from the Worker. Same
 *      question, two networks; a difference is the answer.
 *   2. Is a candidate worth writing an adapter for at all?
 *
 * What it measures is reachability and shape: did the host answer, in the time
 * allowed, with something that parses as the thing its adapter expects, and
 * with rows in it. That is the whole claim. It is not an uptime history and it
 * is not a promise about tomorrow — these sites move, and the point of running
 * it is that the answer keeps changing.
 *
 * Nothing here downloads a file. It sends one search to each host and reads the
 * metadata that comes back, which is what the Worker itself does.
 *
 * Node 18 or newer, and no dependencies — same rule as the rest of `tools/`.
 */

const DEFAULT_QUERY = "big buck bunny";
const TIMEOUT_MS = 12000;

/**
 * Every index, and how to tell a real answer from a plausible-looking one.
 *
 * `check` gets the parsed body and returns a row count. Throwing is how it says
 * "this answered, but not with its own API" — which is the interesting failure,
 * because that is what a parking page, a captive portal and a block page all
 * look like from here. A domain that lapsed and got re-registered by a squatter
 * answers 200 with cheerful HTML; only the shape check catches it.
 *
 * `in_worker` marks the ones `worker/src/worker.js` has an adapter for. The
 * rest are candidates: reachable is necessary for them, not sufficient.
 */
const TARGETS = [
  {
    id: "knaben",
    in_worker: true,
    kind: "meta-index",
    note: "dozens of trackers behind one JSON API; publishes a rate limit under load",
    accept: "application/json, */*",
    url: "https://api.knaben.org/v1",
    method: "POST",
    body: (q) => JSON.stringify({
      search_type: "100%",
      search_field: "title",
      query: q,
      order_by: "seeders",
      order_direction: "desc",
      from: 0,
      size: 5,
      hide_unsafe: true,
    }),
    headers: { "Content-Type": "application/json" },
    check: (body) => {
      const seen = JSON.parse(body);
      if (!seen || !Array.isArray(seen.hits)) throw new Error("no `hits` array");
      return seen.hits.length;
    },
  },
  {
    id: "piratebay",
    in_worker: true,
    kind: "site API",
    note: "off by default in the Worker; this is how you find out whether to switch it on",
    url: (q) => `https://apibay.org/q.php?q=${encodeURIComponent(q)}`,
    check: (body) => {
      const seen = JSON.parse(body);
      if (!Array.isArray(seen)) throw new Error("not a JSON array");
      // Their "nothing found" is one row of zeroes, not an empty list.
      const real = seen.filter((row) => row && row.info_hash && !/^0+$/.test(row.info_hash));
      return real.length;
    },
  },
  {
    id: "bt4g",
    in_worker: false,
    kind: "DHT crawler (RSS)",
    note: "adapter removed after four deployed probes all returned 403; kept here to spot a recovery",
    accept: "application/rss+xml, application/xml, text/xml, */*",
    url: (q) => `https://bt4gprx.com/search?q=${encodeURIComponent(q)}&orderby=seeders&category=all&page=rss`,
    check: (body) => {
      // A challenge page is an HTTP 200 full of HTML, and would otherwise read
      // as a feed with nothing in it.
      if (!/<(?:rss|channel)[\s>]/i.test(body)) throw new Error("not a feed — challenge page?");
      return (body.match(/<item>/gi) || []).length;
    },
  },
  {
    id: "torrentscsv",
    in_worker: true,
    kind: "DHT crawl",
    note: "index freshness is a separate question from whether it answers",
    url: (q) => `https://torrents-csv.com/service/search?q=${encodeURIComponent(q)}&size=5`,
    check: (body) => {
      const seen = JSON.parse(body);
      if (!seen || !Array.isArray(seen.torrents)) throw new Error("no `torrents` array");
      return seen.torrents.length;
    },
  },
  {
    id: "yts",
    in_worker: true,
    kind: "site API (films only)",
    note: "moved twice since Nov 2025; if this fails, the domain is the first suspect",
    url: (q) => `https://yts.bz/api/v2/list_movies.json?query_term=${encodeURIComponent(q)}&limit=5`,
    check: (body) => {
      const seen = JSON.parse(body);
      if (!seen || typeof seen !== "object" || !seen.data) throw new Error("no `data` object");
      return (seen.data.movies || []).length;
    },
  },
  {
    id: "nyaa",
    in_worker: true,
    kind: "RSS (East Asian media)",
    note: "official domain only; this project will not fall back to its unofficial mirrors",
    accept: "application/rss+xml, application/xml, text/xml, */*",
    url: (q) => `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}`,
    check: (body) => {
      if (!/<rss[\s>]/i.test(body)) throw new Error("not an RSS document");
      return (body.match(/<item>/gi) || []).length;
    },
  },
  {
    id: "animetosho",
    in_worker: true,
    kind: "aggregator (JSON)",
    note: "aggregates Nyaa and Tokyo Toshokan; magnet in the listing, so one request",
    url: (q) => `https://feed.animetosho.org/json?q=${encodeURIComponent(q)}`,
    check: (body) => {
      const seen = JSON.parse(body);
      if (!Array.isArray(seen)) throw new Error("not a JSON array");
      return seen.length;
    },
  },
  {
    id: "eztvx",
    in_worker: true,
    kind: "site API (television)",
    note: "the Keywords path, which needs no third-party key; the imdb path wants an OMDb one",
    url: (q) => `https://eztvx.to/api/get-torrents?limit=10&page=1&Keywords=${encodeURIComponent(q)}`,
    check: (body) => {
      const seen = JSON.parse(body);
      if (!seen || typeof seen !== "object") throw new Error("not a JSON object");
      return (seen.torrents || []).length;
    },
  },
  {
    id: "bitsearch",
    in_worker: false,
    kind: "DHT-native",
    note: "reported to allow only ~200 requests a day per address without a key",
    url: (q) => `https://bitsearch.eu/api/v1/search?q=${encodeURIComponent(q)}&limit=5`,
    check: (body) => {
      const seen = JSON.parse(body);
      const rows = Array.isArray(seen) ? seen : seen && (seen.results || seen.data || seen.torrents);
      if (!Array.isArray(rows)) throw new Error("no results array");
      return rows.length;
    },
  },
  {
    id: "solidtorrents",
    in_worker: false,
    kind: "DHT-native",
    note: "several domains exist; this asks the one current adapters use",
    url: (q) => `https://solidtorrents.to/api/v1/search?q=${encodeURIComponent(q)}`,
    check: (body) => {
      const seen = JSON.parse(body);
      if (!seen || !Array.isArray(seen.results)) throw new Error("no `results` array");
      return seen.results.length;
    },
  },
];

const USER_AGENT =
  "utsi-probe (+https://github.com/momzv2022-ctrl/unified-torrent-search-interface)";

/**
 * What a browser sends. Used only as the *second* attempt, never the first.
 *
 * Some of these sites filter on the User-Agent rather than on the address, and
 * the difference matters enormously to what you should do next: an honest
 * `utsi-probe` getting 403 while this gets 200 means the index is reachable and
 * merely picky, which is a one-line fix. Finding that out is worth one extra
 * request; leading with a disguise would throw the information away.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";

const FEED_ACCEPT = "application/rss+xml, application/xml, text/xml, */*";

async function attempt(target, query, { ua, accept }) {
  const url = typeof target.url === "function" ? target.url(query) : target.url;
  const started = Date.now();
  const control = new AbortController();
  const alarm = setTimeout(() => control.abort(), TIMEOUT_MS);

  try {
    const answer = await fetch(url, {
      method: target.method || "GET",
      headers: { "User-Agent": ua, Accept: accept, ...(target.headers || {}) },
      body: target.body ? target.body(query) : undefined,
      signal: control.signal,
      redirect: "follow",
    });
    const body = await answer.text();
    const ms = Date.now() - started;
    // A redirect that was followed is worth saying out loud: it is usually the
    // first sign that a site has moved and the address here is one move behind.
    const landed = answer.url && new URL(answer.url).host !== new URL(url).host
      ? new URL(answer.url).host
      : "";

    if (answer.status === 429) return { state: "throttled", ms, status: 429, rows: 0, landed, why: "rate limited" };
    if (answer.status !== 200) return { state: "refused", ms, status: answer.status, rows: 0, landed, why: `HTTP ${answer.status}` };

    try {
      const rows = target.check(body);
      if (!rows) return { state: "empty", ms, status: 200, rows: 0, landed, why: "answered, no rows" };
      return { state: "ok", ms, status: 200, rows, landed, why: "" };
    } catch (badShape) {
      return { state: "not-its-api", ms, status: 200, rows: 0, landed, why: badShape.message };
    }
  } catch (failure) {
    const ms = Date.now() - started;
    const why = failure.name === "AbortError" ? `no answer in ${TIMEOUT_MS / 1000}s` : failure.message;
    return { state: failure.name === "AbortError" ? "timeout" : "unreachable", ms, status: 0, rows: 0, landed: "", why };
  } finally {
    // Without this the timer keeps the event loop alive after the answer has
    // arrived, and a probe that finished in 200ms still takes the full timeout
    // to exit.
    clearTimeout(alarm);
  }
}

/**
 * Ask honestly; if refused, ask again as a browser and say whether that helped.
 *
 * The retry only runs for refusals and throttles — the failures a header could
 * plausibly cause. A name that does not resolve, or a connection that hangs
 * until the timeout, is being stopped somewhere no header reaches, and asking
 * again in a costume would only add twelve seconds to the report.
 */
async function probe(target, query) {
  const plain = await attempt(target, query, {
    ua: USER_AGENT,
    accept: target.accept || "*/*",
  });
  if (plain.state !== "refused" && plain.state !== "throttled") return plain;

  const disguised = await attempt(target, query, {
    ua: BROWSER_UA,
    accept: target.accept || FEED_ACCEPT,
  });
  if (disguised.state === "ok" || disguised.state === "empty") {
    return { ...disguised, why: `${plain.why} to us, ${disguised.rows} rows to a browser UA`, picky: true };
  }
  return plain;
}

const MARK = {
  ok: "ok      ",
  empty: "empty   ",
  throttled: "throttled",
  refused: "refused ",
  "not-its-api": "not-its-api",
  timeout: "timeout ",
  unreachable: "no route",
};

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const at = argv.indexOf("--query");
  const query = at >= 0 && argv[at + 1] ? argv[at + 1] : DEFAULT_QUERY;

  const results = await Promise.all(
    TARGETS.map(async (target) => ({ ...target, url: undefined, body: undefined, check: undefined, ...(await probe(target, query)) })),
  );

  if (asJson) {
    const clean = results.map(({ id, in_worker, kind, note, state, status, ms, rows, landed, why, picky }) => ({
      id, in_worker, kind, note, state, status, ms, rows, landed, why, picky: !!picky,
    }));
    process.stdout.write(JSON.stringify(clean, null, 2) + "\n");
    return;
  }

  console.log(`\nAsked each index for "${query}", from this machine, just now.\n`);
  console.log("  engine        in worker  result       ms     rows  detail");
  console.log("  " + "-".repeat(74));
  for (const r of results) {
    const detail = [r.landed && `→ ${r.landed}`, r.why].filter(Boolean).join("  ");
    console.log(
      "  %s %s  %s %s %s  %s",
      r.id.padEnd(13),
      (r.in_worker ? "yes" : "no ").padEnd(9),
      MARK[r.state].padEnd(12),
      String(r.ms).padStart(5),
      String(r.rows).padStart(5),
      detail,
    );
  }

  const working = results.filter((r) => r.state === "ok" && r.in_worker).map((r) => r.id);
  console.log("\n  Answering here, and this Worker has an adapter for them:");
  console.log("    UTSI_ENGINES = " + (working.join(",") || "(none — see the detail column)"));

  const candidates = results.filter((r) => r.state === "ok" && !r.in_worker).map((r) => r.id);
  if (candidates.length) {
    console.log("\n  Answering here, but no adapter exists: " + candidates.join(", "));
    console.log("  Reachable is the easy half. Check the rate limit and the licence before");
    console.log("  deciding one is worth carrying.");
  }

  // A site being filtered by the network between you and it looks nothing like
  // a site being down, and the two have completely different answers. Saying so
  // is the difference between "these indexes are dead" — which people conclude,
  // and then repeat — and "my connection will not carry me there".
  const filtered = results.filter((r) => r.state === "unreachable" || r.state === "timeout");
  if (filtered.length) {
    console.log("\n  Stopped before an answer: " + filtered.map((r) => r.id).join(", "));
    console.log("  This is what network-level filtering looks like, and the shape says which:");
    console.log("    no route  — the name never resolved.   DNS blocking. Try a DoH resolver.");
    console.log("    timeout   — connected, then nothing.   SNI filtering; a resolver will not");
    console.log("                                           help, an encrypted tunnel will.");
    console.log("  Neither means the index is dead. A deployed Worker is on a different network");
    console.log("  and is not subject to your ISP at all, which is the point of running both.");
  }

  const picky = results.filter((r) => r.picky);
  if (picky.length) {
    console.log("\n  Refused us but served a browser User-Agent: " + picky.map((r) => r.id).join(", "));
    console.log("  Reachable, and filtering on who is asking rather than from where.");
  }

  console.log(`
  This measured *this* network. A Cloudflare Worker is a different address and
  can get a different answer — that is the usual reason an engine works here and
  not there. Compare with:

    curl -H "X-API-Key: YOUR-KEY" "https://your-address/api/v1/engines?probe=1"
`);
}

main();
