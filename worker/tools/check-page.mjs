/**
 * Open the built setup page in a real browser, at phone sizes, and check the
 * things that are easy to claim and easy to break.
 *
 *     node worker/tools/build.mjs
 *     node worker/tools/check-page.mjs
 *
 * "Mobile-first" is not a design opinion here, it is five assertions:
 *
 *   1. the page never scrolls sideways, at 320 CSS pixels wide;
 *   2. wide things — the program, the curl line — scroll inside their own box;
 *   3. every button and disclosure is at least 32 pixels tall;
 *   4. the key is legible without pinch-zoom;
 *   5. the copy button really does yield the program with *this* browser's key
 *      spliced into it, byte for byte.
 *
 * And one that is not about layout at all: **the page must make no network
 * request.** It is a page about a security key; anything it fetched would be
 * something to explain.
 *
 * It needs a Chromium. `playwright-core` and a browser path, in this order:
 * `$PLAYWRIGHT_CHROMIUM`, then the usual `$PLAYWRIGHT_BROWSERS_PATH` layout,
 * then whatever `playwright` bundles. With neither, it says so and exits 0 —
 * a developer without a browser installed should not be blocked, but CI runs it
 * with one.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { playgroundLink } from "./playground.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const PAGE = pathToFileURL(join(REPO, "site", "index.html")).href;
const WORKER = readFileSync(join(REPO, "worker", "src", "worker.js"), "utf8");

/** Fixed, so the browser's link and this process's link are comparable at all. */
const FIXED_BOUNDARY = "----WebKitFormBoundaryPageCheck00";

const VIEWPORTS = [
  { name: "smallest phone still in use", width: 320, height: 568, scheme: "light" },
  { name: "typical Android phone", width: 360, height: 800, scheme: "dark" },
  { name: "recent iPhone", width: 393, height: 852, scheme: "light" },
  { name: "tablet, portrait", width: 768, height: 1024, scheme: "dark" },
  { name: "desktop", width: 1440, height: 900, scheme: "light" },
];

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium")) continue;
      for (const binary of ["chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const candidate = join(root, entry, binary);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

// `playwright` first: it downloads and tracks its own browser, so it needs no
// path. `playwright-core` is the lighter package and does need one.
let chromium = null;
let bringsItsOwnBrowser = false;
try {
  ({ chromium } = await import("playwright"));
  bringsItsOwnBrowser = true;
} catch {
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.log("skipped: no playwright installed (npm i -D playwright)");
    process.exit(0);
  }
}

const executablePath = findChromium();
if (!executablePath && !bringsItsOwnBrowser) {
  console.log("skipped: no chromium found (set PLAYWRIGHT_CHROMIUM to one)");
  process.exit(0);
}

const browser = await chromium.launch(executablePath ? { executablePath } : {});
let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`  ✗ ${message}`);
};

for (const viewport of VIEWPORTS) {
  const phone = viewport.width < 800;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: viewport.scheme,
    permissions: ["clipboard-read", "clipboard-write"],
    hasTouch: phone,
    isMobile: phone,
    deviceScaleFactor: phone ? 3 : 1,
  });
  const page = await context.newPage();

  const problems = [];
  page.on("pageerror", (error) => problems.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  const offsite = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("file://")) offsite.push(request.url());
  });

  await page.goto(PAGE);
  await page.waitForFunction(() => document.getElementById("key").textContent !== "generating…");

  console.log(`\n${viewport.name} — ${viewport.width}×${viewport.height}, ${viewport.scheme}`);
  if (problems.length) fail(`script errors: ${problems.join(" | ")}`);
  if (offsite.length) fail(`the page fetched something: ${offsite.join(", ")}`);

  const layout = await page.evaluate(() => {
    /** Overflow is only a bug when nothing between here and the body scrolls. */
    const contained = (element) => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === "auto" || overflow === "scroll") return true;
      }
      return false;
    };
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      escaping: [...document.querySelectorAll("body *")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !contained(el))
        .map((el) => `${el.tagName}${el.id ? "#" + el.id : ""}`),
      scrollers: [...document.querySelectorAll("pre")].filter(
        (el) => getComputedStyle(el).overflowX !== "visible",
      ).length,
      small: [...document.querySelectorAll("button, summary")]
        .map((el) => ({ text: (el.textContent || "").trim().slice(0, 30), height: el.getBoundingClientRect().height }))
        .filter((el) => el.height > 0 && el.height < 32),
      key: (() => {
        const el = document.getElementById("key");
        return {
          text: el.textContent,
          fontSize: parseFloat(getComputedStyle(el).fontSize),
          right: el.getBoundingClientRect().right,
        };
      })(),
    };
  });

  if (layout.documentWidth > layout.viewportWidth) {
    fail(`the page scrolls sideways: ${layout.documentWidth}px of content in ${layout.viewportWidth}px`);
  }
  if (layout.escaping.length) fail(`outside the viewport and not in a scroller: ${layout.escaping.join(", ")}`);
  if (!layout.scrollers) fail("no <pre> has its own horizontal scroller");
  if (layout.small.length) fail(`tap targets under 32px: ${JSON.stringify(layout.small)}`);
  if (layout.key.fontSize < 16) fail(`the key is ${layout.key.fontSize}px — that needs pinch-zoom`);
  if (!/^[a-z2-9]{4}(-[a-z2-9]{4}){5}$/.test(layout.key.text)) fail(`the key looks wrong: ${layout.key.text}`);
  console.log(
    `  ✓ no sideways scroll · ${layout.scrollers} scrolling code blocks · ` +
      `key ${layout.key.fontSize.toFixed(0)}px · every target ≥ 32px`,
  );

  // Copy-and-paste is the fallback route now, so it lives behind a disclosure.
  // Open every one of them: the checks below are about what a reader can reach,
  // and something that cannot be opened cannot be reached.
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) details.open = true;
  });
  await page.click("#copy-code");
  await page.waitForFunction(() => document.getElementById("code-status").textContent !== "");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const expected = WORKER.replace('const API_KEY = "";', `const API_KEY = "${layout.key.text}";`);
  if (copied !== expected) {
    fail(`the copy button did not yield the program with the key in it (${copied.length} vs ${expected.length})`);
  } else {
    console.log(`  ✓ copied ${copied.length.toLocaleString()} characters, key spliced in exactly`);
  }

  await page.click("#copy-key");
  await page.waitForFunction(() => /Save it/.test(document.getElementById("key-status").textContent));
  const copiedKey = await page.evaluate(() => navigator.clipboard.readText());
  if (copiedKey !== layout.key.text) fail("the key button copied something else");

  // The playground link: the page inlines `worker/tools/playground.js`, so the
  // copy running in the browser has to produce the same bytes as the module this
  // process imported. Same program, same boundary, same string — or they have
  // drifted and one of them is wrong.
  await page.waitForFunction(
    () => document.getElementById("open-playground").getAttribute("aria-disabled") === null,
    { timeout: 15000 },
  );
  const href = await page.getAttribute("#open-playground", "href");
  if (!href.startsWith("https://workers.cloudflare.com/playground#")) {
    fail(`the playground link points at ${href.slice(0, 60)}`);
  }
  const inBrowser = await page.evaluate(
    ([program, boundary]) => playgroundLink(program, { boundary }),
    [expected, FIXED_BOUNDARY],
  );
  if (inBrowser !== playgroundLink(expected, { boundary: FIXED_BOUNDARY })) {
    fail("the page's inlined copy of playground.js disagrees with the module");
  }
  // The two differ because the real link has a random boundary and a random key
  // in it, and lz-string's output size depends on what it is compressing. The
  // exact byte count is already pinned by the equality check above; this is only
  // here to catch the page building something *wildly* different.
  //
  // 200 was too tight and made this fail roughly one viewport in ten. Measured
  // over 60 random key-and-boundary pairs: median 54, p95 149, max 183. 500 is
  // clear of that and still nowhere near a real divergence, which would run to
  // thousands — a different program, not a different boundary.
  if (Math.abs(href.length - inBrowser.length) > 500) {
    fail(`the real link is ${href.length} but a fixed-boundary one is ${inBrowser.length}`);
  }
  console.log(`  ✓ playground link ${href.length.toLocaleString()} characters, matches the module`);

  // The deploy link is the button people actually press, so it gets checked
  // harder than the one it replaced. The fragment must be *identical* to the
  // playground link's: same program, same key, two destinations. If those ever
  // diverge, one of the two buttons is deploying something else.
  const deployHref = await page.getAttribute("#open-deploy", "href");
  const deployBase = "https://dash.cloudflare.com/workers-and-pages/deploy/playground/";
  if (!deployHref.startsWith(deployBase)) {
    fail(`the deploy link points at ${deployHref.slice(0, 70)}`);
  }
  const [deployPath, deployFragment] = deployHref.slice(deployBase.length).split("#");
  if (deployFragment !== href.split("#")[1]) {
    fail("the deploy link and the playground link carry different programs");
  }
  // The name becomes the address, so it must not be a constant, and it must not
  // be able to break out of the path.
  if (!/^utsi-[a-z0-9]{6}$/.test(deployPath)) {
    fail(`the deploy link's worker name is ${JSON.stringify(deployPath)}`);
  }
  console.log(`  ✓ deploy link → ${deployPath}, same program as the playground link`);

  // The name is generated inside the link builder, so it is easy for the page to
  // show one thing and deploy another. It is also the first half of the address,
  // which is why it is on the page at all.
  // The address box: the one thing this page cannot work out for itself, so it
  // asks. People paste whole URLs, so anything host-shaped has to be accepted and
  // anything else refused — a command with rubbish in it is worse than a
  // placeholder, because it looks ready to run.
  const commandFor = async (typed) => {
    await page.fill("#address", typed);
    return page.textContent("#curl");
  };
  const host = "utsi-ab12.example.workers.dev";
  for (const typed of [host, `https://${host}`, `https://${host}/healthz`, `  ${host}/  `]) {
    const command = await commandFor(typed);
    if (!command.includes(`https://${host}/api/v1/search`) || !command.includes(layout.key.text)) {
      fail(`the address box made ${JSON.stringify(command.slice(0, 90))} of ${JSON.stringify(typed)}`);
    }
  }
  const rubbish = await commandFor("not an address");
  if (!rubbish.includes("your-address.workers.dev")) {
    fail("the address box put something that is not an address into the command");
  }
  await page.fill("#address", "");
  console.log("  ✓ the address box fills the command in, and refuses what is not an address");

  await context.close();
}

// Two browsers, two keys. A page that handed everyone the same key would be a
// page that handed everyone the same password.
const first = await keyFrom(browser);
const second = await keyFrom(browser);
if (first === second) fail("two visits produced the same key");
else console.log(`\n✓ two visits produce different keys (${first.slice(0, 9)}…, ${second.slice(0, 9)}…)`);

async function keyFrom(instance) {
  const context = await instance.newContext();
  const page = await context.newPage();
  await page.goto(PAGE);
  await page.waitForFunction(() => document.getElementById("key").textContent !== "generating…");
  const key = await page.textContent("#key");
  await context.close();
  return key;
}

await browser.close();
console.log(failures ? `\n${failures} failed` : "\nthe setup page is fine on every size checked");
process.exit(failures ? 1 : 0);
