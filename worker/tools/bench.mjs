/**
 * How much CPU one request costs, with the network taken out of the picture.
 *
 * A free-plan Worker gets **10 ms of CPU per request**. Waiting on `fetch()`
 * does not count against it; parsing what comes back does. So this measures
 * exactly that: five engines' worth of responses, parsed, merged, filtered,
 * sorted, paged, and turned into TSP JSON — with `http` answering instantly from
 * memory, so every microsecond reported is work this Worker actually does.
 *
 *     node worker/tools/bench.mjs [rows-per-engine] [iterations]
 *
 * The number this prints is what `UTSI_MAX_ROWS_PER_ENGINE`'s comment in
 * `worker/src/worker.js` quotes. It is Node's V8 on whatever machine you run it
 * on, not Cloudflare's, so treat it as the shape of the cost rather than the
 * bill. The bill is `wrangler tail --format=pretty` against your own deployment,
 * which prints the real CPU time per request.
 */

import { __testing } from "../src/worker.js";

const { readSettings, search } = __testing;

const ROWS = Number(process.argv[2] || 100);
const ITERATIONS = Number(process.argv[3] || 200);

const HASH = (n) => n.toString(16).padStart(40, "0");
const NAMES = [
  "Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP",
  "Sintel.2010.2160p.UHD.BluRay.x265-GRP",
  "Cosmos.Laundromat.S01E02.720p.WEB-DL.x265",
  "Ubuntu 24.04.1 LTS desktop amd64 iso",
  "Public Domain Radio Hour discography FLAC",
];

/** A plausible engine response of *rows* rows, built once and reused. */
function tspPayload(offset) {
  return JSON.stringify({
    torrents: Array.from({ length: ROWS }, (_, index) => ({
      infohash: HASH(offset + index),
      name: NAMES[index % NAMES.length] + ` [${offset + index}]`,
      size_bytes: 1073741824 + index,
      files: 3,
      seeders: (index * 7) % 900,
      leechers: index % 40,
      first_seen: "2019-01-01T00:00:00Z",
      sources: ["1337x"],
    })),
  });
}

function knabenPayload(offset) {
  return JSON.stringify({
    hits: Array.from({ length: ROWS }, (_, index) => ({
      title: NAMES[index % NAMES.length] + ` [${offset + index}]`,
      hash: HASH(offset + index),
      bytes: String(1073741824 + index),
      seeders: (index * 11) % 900,
      peers: index % 50,
      date: "2019-01-01T00:00:00+00:00",
      tracker: "1337x",
      details: "https://example.test/" + index,
    })),
  });
}

function csvPayload(offset) {
  return JSON.stringify({
    torrents: Array.from({ length: ROWS }, (_, index) => ({
      infohash: HASH(offset + index),
      name: NAMES[index % NAMES.length] + ` [${offset + index}]`,
      size_bytes: 1073741824 + index,
      seeders: (index * 3) % 900,
      leechers: index % 30,
      created_unix: 1546300800 + index,
    })),
  });
}

function ytsPayload() {
  return JSON.stringify({
    data: {
      movies: Array.from({ length: Math.ceil(ROWS / 2) }, (_, index) => ({
        title_long: `Public Domain Film ${index} (19${10 + (index % 80)})`,
        url: "https://example.test/film/" + index,
        torrents: [
          { hash: HASH(900000 + index * 2), quality: "1080p", type: "bluray", video_codec: "x264", size_bytes: 1, seeds: index, peers: 1, date_uploaded_unix: 1546300800 },
          { hash: HASH(900001 + index * 2), quality: "720p", type: "web", video_codec: "x264", size_bytes: 2, seeds: index, peers: 1, date_uploaded_unix: 1546300800 },
        ],
      })),
    },
  });
}

function nyaaPayload() {
  const items = Array.from(
    { length: ROWS },
    (_, index) => `    <item>
      <title>[Group] Public Domain Animation - ${index} (1080p) [ABCD1234].mkv</title>
      <link>https://nyaa.si/download/${index}.torrent</link>
      <guid isPermaLink="true">https://nyaa.si/view/${index}</guid>
      <pubDate>Wed, 01 May 2024 12:00:00 -0000</pubDate>
      <nyaa:seeders>${index % 500}</nyaa:seeders>
      <nyaa:leechers>${index % 20}</nyaa:leechers>
      <nyaa:infoHash>${HASH(700000 + index)}</nyaa:infoHash>
      <nyaa:categoryId>1_2</nyaa:categoryId>
      <nyaa:size>1.4 GiB</nyaa:size>
    </item>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:nyaa="https://nyaa.si/xmlns/nyaa">
  <channel>
${items}
  </channel>
</rss>`;
}

const RESPONSES = {
  "https://index.test/api/v1/search": tspPayload(0),
  "https://api.knaben.org/v1": knabenPayload(1000),
  "https://torrents-csv.com/service/search": csvPayload(0),
  "https://yts.bz/api/v2/list_movies.json": ytsPayload(),
  "https://nyaa.si/?page=rss": nyaaPayload(),
};

const http = {
  async text(url) {
    for (const [prefix, body] of Object.entries(RESPONSES)) {
      if (url.startsWith(prefix)) return [200, body];
    }
    return [404, ""];
  },
  async bytes() {
    return [404, new Uint8Array()];
  },
};

const settings = {
  ...readSettings({ UTSI_API_KEY: "k".repeat(32), UTSI_UPSTREAM_URL: "https://index.test" }),
  maxRowsPerEngine: ROWS,
};

const query = () => ({
  q: "public domain",
  cat: "video",
  year: "",
  res: "",
  minSeeders: 0,
  sort: "",
  limit: 50,
  offset: 0,
  terms: "",
});

// `cat=video` on purpose: a filtered search is the expensive one, because it
// keeps the full candidate set instead of shrinking the window to the page.
for (let warm = 0; warm < 20; warm += 1) await search(query(), http, settings);

const before = process.cpuUsage();
const wallBefore = performance.now();
for (let index = 0; index < ITERATIONS; index += 1) await search(query(), http, settings);
const wall = performance.now() - wallBefore;
const used = process.cpuUsage(before);

const cpuMs = (used.user + used.system) / 1000 / ITERATIONS;
console.log(`engines:      ${settings.engines.join(", ")}`);
console.log(`rows/engine:  ${ROWS}  (${ROWS * 5} rows collected, 50 returned)`);
console.log(`iterations:   ${ITERATIONS}`);
console.log(`CPU/request:  ${cpuMs.toFixed(2)} ms`);
console.log(`wall/request: ${(wall / ITERATIONS).toFixed(2)} ms`);
console.log(`free-plan CPU ceiling is 10 ms/request`);
