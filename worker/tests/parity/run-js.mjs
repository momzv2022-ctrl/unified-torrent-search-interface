/**
 * Run every parity scenario against `worker/src/worker.js` and print the result.
 *
 * The network is a table of fixtures. Nothing here reaches a torrent site, or
 * any site: `stubHttp` answers from `routes` and 404s everything else, which is
 * also how a scenario asserts that an engine was *not* asked.
 *
 * Output is one JSON object, scenario name to TSP response body, with the two
 * fields that cannot be equal between two runs — the clock and the stopwatch —
 * pinned. See `worker/tests/parity/README.md`.
 *
 *     node worker/tests/parity/run-js.mjs > /tmp/js.json
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { __testing } from "../../src/worker.js";

const { readSettings, search } = __testing;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");
const SCENARIOS = JSON.parse(readFileSync(join(HERE, "scenarios.json"), "utf8"));

/** Answers from a URL-prefix table; records what was asked for. */
function stubHttp(routes) {
  const calls = [];
  const answer = (url) => {
    calls.push(url);
    for (const [prefix, route] of Object.entries(routes)) {
      if (!url.startsWith(prefix)) continue;
      if (route.status) return [route.status, ""];
      if (route.text !== undefined) return [200, route.text];
      return [200, readFileSync(join(FIXTURES, route.fixture), "utf8")];
    }
    return [404, ""];
  };
  return {
    calls,
    async text(url) {
      return answer(url);
    },
    async bytes(url) {
      const [status] = answer(url);
      return [status, new Uint8Array()];
    },
  };
}

/**
 * Scenario settings, which are written in the Python worker's snake_case so one
 * file can drive both runners.
 */
function settingsFor(scenario) {
  const overrides = scenario.settings || {};
  const settings = readSettings({ UTSI_API_KEY: "k".repeat(32) });

  // The parity record predates the query gate. These scenarios reproduce a
  // worker that returned whatever its engines said, and their fixtures answer
  // every query with the same canned rows — so leaving the gate on its default
  // would rewrite the frozen answers for a reason that has nothing to do with
  // the plumbing they exist to pin. Scenarios written to exercise the gate turn
  // it on by name; see `worker/tests/parity/README.md`.
  settings.queryMatch = "off";

  const map = {
    query_match: "queryMatch",
    engines: "engines",
    upstream_url: "upstreamUrl",
    upstream_apikey: "upstreamApikey",
    fallback: "fallback",
    fallback_url: "fallbackUrl",
    fallback_apikey: "fallbackApikey",
    torznab_url: "torznabUrl",
    torznab_apikey: "torznabApikey",
    engine_urls: "engineUrls",
    max_rows_per_engine: "maxRowsPerEngine",
    max_resolve: "maxResolve",
    empty_query_mode: "emptyQueryMode",
    browse_queries: "browseQueries",
  };
  for (const [from, to] of Object.entries(overrides)) {
    if (!(from in map)) throw new Error(`unknown scenario setting ${from}`);
    settings[map[from]] = to;
  }
  return settings;
}

function queryFor(scenario) {
  const asked = scenario.query || {};
  return {
    q: asked.q || "",
    cat: asked.cat || "",
    year: asked.year || "",
    res: asked.res || "",
    minSeeders: asked.min_seeders || 0,
    sort: asked.sort || "",
    limit: asked.limit === undefined ? 50 : asked.limit,
    offset: asked.offset || 0,
    terms: "",
  };
}

/**
 * Pin the three things that cannot be equal between two runs of two languages:
 * the clock, the stopwatch, and the words a JSON parser uses to complain. The
 * first two are time; the third is CPython's "Expecting value: line 1 column 1"
 * against V8's "Unexpected token '<'". That a site sent something that was not
 * JSON is the contract; whose phrasing says so is not.
 */
function pin(body) {
  body.took_ms = 0;
  for (const torrent of body.torrents || []) {
    if (torrent.scraped_at) torrent.scraped_at = "PINNED";
  }
  for (const [engine, message] of Object.entries(body.engine_errors || {})) {
    if (message.startsWith("not JSON:")) body.engine_errors[engine] = "not JSON";
  }
  return body;
}

const results = {};
for (const scenario of SCENARIOS) {
  const answer = await search(queryFor(scenario), stubHttp(scenario.routes || {}), settingsFor(scenario));
  results[scenario.name] = pin(answer.body);
}

process.stdout.write(JSON.stringify(results, null, 2) + "\n");
