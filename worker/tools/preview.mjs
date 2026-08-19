/**
 * Run both halves of the setup flow on your own machine.
 *
 *     node worker/tools/preview.mjs
 *
 * The flow this project cares about spans two origins that only exist after a
 * deploy: the **setup page**, which mints the key, and the **Worker**, which is
 * the only party that knows the address and hands it back. Neither half can be
 * judged alone, and testing the join by deploying to Cloudflare every time is a
 * slow way to find a typo.
 *
 * So this serves both, locally, and points them at each other:
 *
 *   http://127.0.0.1:8788/   the setup page, freshly built
 *   http://127.0.0.1:8787/   a Worker, with the setup page above wired in
 *
 * Then walk it: open the setup page, press **Copy just the key** — the button
 * directly under the key, and the one saving action that does not navigate to
 * Cloudflare — then open the Worker, press **Finish setup**, and you should land
 * back on the setup page with the address filled in beside that same key. That
 * is the whole handoff, and it is the part that used to be a person retyping a
 * hostname.
 *
 * **The deploy link is not exercised here** and cannot be: it goes to
 * Cloudflare. The link is checked for shape in `worker/tests/worker.test.mjs`
 * and by `worker/tools/playground-link.mjs`; what needs a real browser is
 * everything after it.
 *
 * No dependencies, like everything else here — `node:http` and the Workers-shaped
 * `fetch` handler that Node has had since 18.
 */

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SITE = join(REPO, "site");

const WORKER_PORT = Number(process.env.UTSI_PREVIEW_PORT || 8787);
const PAGE_PORT = WORKER_PORT + 1;
const HOST = "127.0.0.1";
const workerOrigin = `http://${HOST}:${WORKER_PORT}`;
const pageOrigin = `http://${HOST}:${PAGE_PORT}`;

// A key you are meant to see in a terminal. It is 24 characters so it passes the
// same length check a real one does, and obviously fake so it never gets
// mistaken for one worth keeping.
const DEV_KEY = "prev-iewk-eyno-tase-cret-0000";

// ── the artifact, and the two edits that make it local ──────────────────────
// The same splice the setup page does in the browser (the key), plus the one
// thing only a preview needs: the Worker's Finish setup button has to point at
// the setup page being served here rather than the published one, or the round
// trip leaves the machine.
execFileSync(process.execPath, [join(REPO, "worker", "tools", "build.mjs")], { stdio: "inherit" });

const source = readFileSync(join(REPO, "worker", "src", "worker.js"), "utf8");
const EMPTY_KEY = 'const API_KEY = "";';
const SETUP_LINE = /^const SETUP_PAGE = "[^"]*";$/m;
if (!source.includes(EMPTY_KEY)) throw new Error("worker/src/worker.js has no empty API_KEY line");
if (!SETUP_LINE.test(source)) throw new Error("worker/src/worker.js has no SETUP_PAGE line");

const patched = source
  .replace(EMPTY_KEY, `const API_KEY = "${DEV_KEY}";`)
  .replace(SETUP_LINE, `const SETUP_PAGE = "${pageOrigin}/";`);

// `site/` is already ignored by git, so the patched copy lands there rather than
// anywhere someone might commit it.
const patchedPath = join(SITE, "preview-worker.mjs");
writeFileSync(patchedPath, patched);
const worker = (await import(pathToFileURL(patchedPath).href)).default;

// ── the Worker ──────────────────────────────────────────────────────────────
createServer(async (incoming, outgoing) => {
  const request = new Request(new URL(incoming.url, workerOrigin), {
    method: incoming.method,
    headers: incoming.headers,
  });
  try {
    const answer = await worker.fetch(request, process.env, { waitUntil: (promise) => void promise });
    outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
    outgoing.end(Buffer.from(await answer.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "text/plain" });
    outgoing.end(String(error && error.stack ? error.stack : error));
  }
}).listen(WORKER_PORT, HOST);

// ── the setup page ──────────────────────────────────────────────────────────
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".sig": "application/octet-stream",
  ".sha256": "text/plain; charset=utf-8",
};

createServer((incoming, outgoing) => {
  const path = decodeURIComponent(new URL(incoming.url, pageOrigin).pathname);
  // `normalize` first, then refuse anything still climbing: a preview server is
  // still a server, and `../../../etc/passwd` is still a request people send.
  const relative = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  const file = join(SITE, relative);
  if (!file.startsWith(SITE)) {
    outgoing.writeHead(403).end("no");
    return;
  }
  try {
    const body = readFileSync(file);
    const extension = file.slice(file.lastIndexOf("."));
    outgoing.writeHead(200, { "content-type": TYPES[extension] || "application/octet-stream" });
    outgoing.end(body);
  } catch (error) {
    outgoing.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
  }
}).listen(PAGE_PORT, HOST);

console.log(`
  setup page   ${pageOrigin}/
  worker       ${workerOrigin}/
  key          ${DEV_KEY}   (a preview key, not worth keeping)

  Walk it:
    1. open the setup page and press "Copy just the key", the button under the
       key in section 1 — copying the key is one of the three actions that save
       it on this device, and it is the one that does not open Cloudflare
    2. open the worker and press "Finish setup"
    3. you should be back on the setup page with the address filled in, beside
       the key from step 1

  Or ask it something:
    curl -s -H "X-API-Key: ${DEV_KEY}" "${workerOrigin}/api/v1/search?q=big+buck+bunny&limit=3"
    curl -s ${workerOrigin}/healthz

  Ctrl-C to stop.
`);
