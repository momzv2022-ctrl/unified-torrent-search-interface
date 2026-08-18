/**
 * Produce everything the setup page needs, into `site/`.
 *
 *     node worker/tools/build.mjs
 *
 * Four files, none of them the product of a compiler:
 *
 *   site/worker.js         the artifact — byte-identical to worker/src/worker.js
 *   site/worker.js.sha256  its SHA-256, in `shasum -a 256` format
 *   site/version.json      what a deployed Worker's /healthz asks for
 *   site/index.html        the setup page, with the artifact inlined
 *
 * **There is no build step in the usual sense, and that is the point.** The
 * artifact is a copy, not an output: `site/worker.js` and `worker/src/worker.js`
 * are the same bytes, so the SHA-256 this publishes is the hash of a file you can
 * read on GitHub, and a developer can deploy the source directly without running
 * anything here. This script exists to inline that file into a web page and to
 * write down its hash — not to make it.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const OUT = join(REPO, "site");

const SOURCE_PATH = join(REPO, "worker", "src", "worker.js");
const PAGE_PATH = join(HERE, "setup-page.html");
const PLAYGROUND_PATH = join(HERE, "playground.js");

const REPO_URL = "https://github.com/momzv2022-ctrl/unified-torrent-search-interface";

const source = readFileSync(SOURCE_PATH, "utf8");

// The committed artifact must fail closed. A key spliced in by accident — by a
// local experiment, by a bad merge — would be one key shared by every person who
// ever copied the page, so this is a build failure and not a warning.
if (!/^const API_KEY = "";$/m.test(source)) {
  throw new Error(
    "worker/src/worker.js does not carry an empty API_KEY line. The published " +
      "artifact must ship without a key; the setup page adds one in the browser.",
  );
}

const version = /^const VERSION = "([^"]+)";$/m.exec(source);
if (!version) throw new Error("worker/src/worker.js has no VERSION line");

const sha256 = createHash("sha256").update(source, "utf8").digest("hex");
const published = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
  : new Date().toISOString();

/**
 * The artifact as a JavaScript string literal, safe to sit inside a `<script>`.
 *
 * `JSON.stringify` handles the quoting; the two replacements after it handle the
 * one thing JSON does not know about — an HTML parser ends a script block at the
 * literal text `</script`, wherever it appears, and closes a comment at `-->`.
 */
function inlineLiteral(text) {
  return JSON.stringify(text).replace(/<\//g, "<\\/").replace(/-->/g, "--\\>");
}

/**
 * `playground.js` as a plain script, for inlining.
 *
 * It is written as an ES module so the command-line tools and the test suite can
 * import it; the page wants the same functions as ordinary globals. Dropping the
 * `export` keyword is the whole conversion — which is why the file is written
 * with no imports and no Node-only APIs, so that one copy serves both.
 */
const playground = readFileSync(PLAYGROUND_PATH, "utf8").replace(/^export /gm, "");
if (/\bimport\b|\brequire\(/.test(playground)) {
  throw new Error("worker/tools/playground.js must stay dependency-free — the page inlines it");
}

const page = readFileSync(PAGE_PATH, "utf8")
  .replace("__PLAYGROUND_LIB__", () => playground)
  .replace("__WORKER_SOURCE__", () => inlineLiteral(source))
  .replace(/__SHA256__/g, sha256)
  .replace(/__VERSION__/g, version[1]);

for (const placeholder of ["__PLAYGROUND_LIB__", "__WORKER_SOURCE__", "__SHA256__", "__VERSION__"]) {
  if (page.includes(placeholder)) throw new Error(`the setup page still has ${placeholder} in it`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "worker.js"), source);
writeFileSync(join(OUT, "worker.js.sha256"), `${sha256}  worker.js\n`);
writeFileSync(join(OUT, "index.html"), page);
writeFileSync(
  join(OUT, "version.json"),
  JSON.stringify(
    {
      version: version[1],
      sha256,
      published,
      source: `${REPO_URL}/blob/main/worker/src/worker.js`,
      notes: `${REPO_URL}/releases`,
    },
    null,
    2,
  ) + "\n",
);

// The signed engine feed travels next to the artifact, when it exists: the
// nightly feed workflow signs it, and a deployed Worker fetches it from the
// same Pages site /healthz already reads version.json from. Absent files are
// simply not published — a repository whose maintainer has not provisioned
// signing keys ships a Worker that runs from its compiled-in engines.
const feedFiles = ["feed.json", "feed.json.sig", "keyring.json", "keyring.json.sig"];
const publishedFeed = [];
for (const name of feedFiles) {
  const feedSource = join(REPO, "feed", name);
  if (existsSync(feedSource)) {
    copyFileSync(feedSource, join(OUT, name));
    publishedFeed.push(name);
  }
}

// A published page that a phone cannot load is not a mobile-first page. This is
// nowhere near any real limit; it is here so that stops being true loudly.
const pageBytes = Buffer.byteLength(page);
if (pageBytes > 2 * 1024 * 1024) throw new Error(`the setup page is ${pageBytes} bytes`);

console.log(`worker.js      ${Buffer.byteLength(source).toLocaleString()} bytes`);
console.log(`sha256         ${sha256}`);
console.log(`version        ${version[1]}`);
console.log(`index.html     ${pageBytes.toLocaleString()} bytes`);
console.log(`feed           ${publishedFeed.length ? publishedFeed.join(", ") : "(not provisioned; see docs/tgp.md)"}`);
console.log(`written to     ${OUT}`);
