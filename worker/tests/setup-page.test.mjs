/**
 * The setup page, run rather than read.
 *
 * `worker.test.mjs` covers the Worker and the link format. This covers the other
 * half of the setup flow: the page's own script, driven in a stub DOM, because
 * the parts people get wrong are the handoff (a key minted in one tab meeting a
 * URL that only Cloudflare could produce) and losing your place in the steps.
 *
 * It runs the built page (`site/index.html`), not the template, so the inlining
 * in `build.mjs` is covered too: a placeholder left unreplaced fails here.
 *
 * **The stub is a model, and a model can lie.** So the shape it models is read
 * out of the real markup rather than written down twice: the step ids and their
 * `data-next` targets come from the file, and a step renamed or a `data-next`
 * pointed at nothing fails here rather than quietly working in a fake DOM.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

execFileSync(process.execPath, [join(REPO, "worker", "tools", "build.mjs")], { stdio: "ignore" });
const html = readFileSync(join(REPO, "site", "index.html"), "utf8");

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);

// Which of them the page ships hidden. Taken from the markup rather than
// restated here, so a panel that loses its `hidden` attribute, and would
// therefore greet a first-time reader with a warning meant for someone
// returning, fails a test instead of shipping.
const hiddenIds = new Set(
  [...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)]
    .filter((match) => /\shidden[\s>]/.test(match[0]))
    .map((match) => match[1]),
);

/** The steps, read out of the page: `[{ id, next }]` in document order. */
const STEPS = (() => {
  const opens = [...html.matchAll(/<li class="step[^"]*" id="([^"]+)">/g)];
  return opens.map((match, index) => {
    const from = match.index;
    const to = index + 1 < opens.length ? opens[index + 1].index : html.length;
    const next = /data-next="([^"]+)"/.exec(html.slice(from, to));
    return { id: match[1], next: next ? next[1] : null };
  });
})();

const KEY_SHAPE = /^[a-z2-9]{4}(?:-[a-z2-9]{4}){5}$/;
const SAVED = "utsi.key.v1";
const fresh = (key) => ({ [SAVED]: JSON.stringify({ key, at: Date.now() }) });

/** Let the page's promise chains settle. */
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/**
 * Enough DOM to run the page and no more.
 *
 * *reply* is what a `fetch` from the page resolves to: `{status, body}`, or a
 * thrown value to model a request that never lands, which is what CORS refusing
 * and a wrong hostname both look like from here.
 */
function load(hash, store = {}, reply = null) {
  const nodes = new Map();
  const requests = [];
  const pending = [];

  const element = (id) => {
    const node = {
      id,
      textContent: "",
      value: "",
      href: "",
      className: "",
      hidden: hiddenIds.has(id),
      disabled: false,
      scrolled: false,
      attributes: {},
      listeners: {},
      style: {},
      children: {},
      classes: new Set(),
      nextElementSibling: null,
      addEventListener(type, handler) {
        (this.listeners[type] = this.listeners[type] || []).push(handler);
      },
      fire(type) {
        (this.listeners[type] || []).forEach((handler) => handler({ preventDefault() {} }));
      },
      click() {
        this.fire("click");
      },
      input() {
        this.fire("input");
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      getAttribute(name) {
        return name === "href" ? this.href : (this.attributes[name] ?? null);
      },
      querySelector(selector) {
        return this.children[selector] || null;
      },
      scrollIntoView() {
        this.scrolled = true;
      },
      focus() {},
      select() {},
      setSelectionRange() {},
      appendChild() {},
      removeChild() {},
    };
    node.classList = {
      add: (name) => node.classes.add(name),
      remove: (name) => node.classes.delete(name),
      contains: (name) => node.classes.has(name),
      toggle: (name, on) => (on ? node.classes.add(name) : node.classes.delete(name)),
    };
    return node;
  };

  for (const id of ids) nodes.set(id, element(id));

  // The steps, built from the shape the page actually ships. `open` fires the
  // toggle event a real <details> fires, because the page leans on that to keep
  // one panel open at a time.
  const steps = STEPS.map(({ id, next }) => {
    const step = nodes.get(id) || element(id);
    nodes.set(id, step);
    const details = element(`${id}-details`);
    let isOpen = /<li class="step current"/.test(html) && id === STEPS[0].id;
    Object.defineProperty(details, "open", {
      get: () => isOpen,
      set(value) {
        const was = isOpen;
        isOpen = Boolean(value);
        if (isOpen !== was) details.fire("toggle");
      },
      configurable: true,
    });
    step.children.details = details;
    step.children[".state"] = element(`${id}-state`);
    if (next) {
      const button = element(`${id}-next`);
      button.attributes["data-next"] = next;
      step.children[".next"] = button;
    }
    if (id === STEPS[0].id) step.classes.add("current");
    return step;
  });
  steps.forEach((step, index) => {
    step.nextElementSibling = steps[index + 1] || null;
  });

  const sandbox = {
    document: {
      getElementById: (id) => nodes.get(id) || null,
      querySelectorAll: (selector) => (selector === "#steps > li.step" ? steps : []),
      createElement: () => element("scratch"),
      body: element("body"),
      execCommand: () => true,
    },
    location: { href: "https://example.test/setup/", hash },
    navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: "Mozilla/5.0 Chrome/148" },
    localStorage: {
      getItem: (name) => (name in store ? store[name] : null),
      setItem: (name, value) => {
        store[name] = String(value);
      },
      removeItem: (name) => {
        delete store[name];
      },
    },
    fetch: (url, options) => {
      requests.push({ url, options });
      // An array of replies is a sequence: one per call, the last one repeating.
      // That is how "fails, fails, then works" gets tested without waiting.
      const answer = Array.isArray(reply) ? reply[Math.min(requests.length - 1, reply.length - 1)] : reply;
      if (!answer || answer.throws) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({
        status: answer.status,
        text: () => Promise.resolve(answer.body),
      });
    },
    // A zero delay is the page deferring the compressor past first paint, and it
    // runs at once so no test has to sleep. Anything longer is the retry loop,
    // which is queued so a test can drive the clock instead of living through it.
    setTimeout: (fn, ms) => {
      if (!ms) {
        fn();
        return 0;
      }
      pending.push(fn);
      return pending.length;
    },
    clearTimeout: () => {
      pending.length = 0;
    },
    crypto,
    console,
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    Uint8Array,
    Promise,
    encodeURIComponent,
    decodeURIComponent,
    isNaN,
    parseInt,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const code of scripts) vm.runInContext(code, sandbox);

  return {
    at: (id) => nodes.get(id),
    step: (id) => nodes.get(id),
    steps,
    store,
    requests,
    /** Fire whatever the page is waiting on. */
    tick: () => {
      const due = pending.splice(0, pending.length);
      due.forEach((fn) => fn());
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// what the page is
// ───────────────────────────────────────────────────────────────────────────

test("the page ships four steps, each pointing at the next", () => {
  assert.deepEqual(
    STEPS,
    [
      { id: "step-1", next: "step-2" },
      { id: "step-2", next: "step-3" },
      { id: "step-3", next: "step-4" },
      { id: "step-4", next: null },
    ],
    "the stub below models this exactly; change one and change both",
  );
});

test("a first visit mints a key, builds both links, and saves nothing", () => {
  const page = load("");

  assert.match(page.at("key").textContent, KEY_SHAPE);
  assert.match(
    page.at("open-deploy").href,
    /^https:\/\/dash\.cloudflare\.com\/workers-and-pages\/deploy\/playground\/utsi-[a-z0-9]{6}#[A-Za-z0-9+\-$]+$/,
  );
  assert.match(page.at("open-playground").href, /^https:\/\/workers\.cloudflare\.com\/playground#/);
  assert.equal(page.at("link-status").textContent, "", "no warning on a browser that can open it");

  // Merely looking at this page must not overwrite the key of a Worker that is
  // already running, so nothing is stored until the key is acted on.
  assert.deepEqual(Object.keys(page.store), []);
  assert.equal(page.at("returned").hidden, true);
  assert.equal(page.at("key-missing").hidden, true);
  assert.equal(page.at("build-on-it").hidden, true, "hidden until a test actually succeeds");
});

test("the key on screen is always the key inside the file being offered", () => {
  // The trap this closes: mint a new key on every visit, and someone who
  // reloads after deploying sees a key that opens nothing. A stored key is
  // reused, so the file this page hands out and the key it displays cannot
  // disagree.
  const key = "abcd-efgh-ijkl-mnop-qrst-uvwx";
  const page = load("", fresh(key));

  assert.equal(page.at("key").textContent, key);
  assert.ok(page.at("source").textContent.includes(`const API_KEY = "${key}";`));
  assert.ok(!page.at("source").textContent.includes('const API_KEY = "";'));
});

test("a saved key older than a week is dropped, not reused", () => {
  const stale = { [SAVED]: JSON.stringify({ key: "stal-ekey-valu-eeee-eeee-eeee", at: Date.now() - 8 * 864e5 }) };
  const page = load("", stale);

  assert.notEqual(page.at("key").textContent, "stal-ekey-valu-eeee-eeee-eeee");
  assert.equal(page.store[SAVED], undefined);
});

test("acting on the key is what saves it", () => {
  for (const button of ["open-deploy", "copy-key", "copy-code", "copy-both"]) {
    const page = load("");
    page.at(button).click();
    assert.equal(JSON.parse(page.store[SAVED]).key, page.at("key").textContent, button);
  }
});

test("the key never reaches this page's own URL", () => {
  // A bookmark that contains a password is a password you can leak by sharing a
  // link. The key goes into the fragment of the deploy link and nowhere else.
  const page = load("");
  assert.ok(!page.at("open-deploy").href.includes("?"));
});

// ───────────────────────────────────────────────────────────────────────────
// the steps
// ───────────────────────────────────────────────────────────────────────────

test("one step is open at a time, and finishing one opens the next", () => {
  const page = load("");
  const open = () => page.steps.filter((step) => step.children.details.open).map((step) => step.id);

  assert.deepEqual(open(), ["step-1"], "a first visit starts at the top");

  page.step("step-1").children[".next"].click();
  assert.deepEqual(open(), ["step-2"]);
  assert.ok(page.step("step-1").classes.has("done"));
  assert.equal(page.step("step-1").children[".state"].textContent, "done");
  assert.ok(page.step("step-2").classes.has("current"));
  assert.ok(page.step("step-2").scrolled, "and it scrolls to where the reader now is");

  page.step("step-2").children[".next"].click();
  page.step("step-3").children[".next"].click();
  assert.deepEqual(open(), ["step-4"]);
});

test("opening a step by hand closes the others", () => {
  // Coming back from another tab to four open panels is how people lose their
  // place, which is the whole reason this is an accordion.
  const page = load("");
  page.step("step-3").children.details.open = true;

  assert.deepEqual(
    page.steps.filter((step) => step.children.details.open).map((step) => step.id),
    ["step-3"],
  );
  assert.ok(page.step("step-3").classes.has("current"));
  assert.ok(!page.step("step-1").classes.has("current"));
});

// ───────────────────────────────────────────────────────────────────────────
// coming back from your own Worker
// ───────────────────────────────────────────────────────────────────────────

test("a Worker handing its URL back completes the pair and skips to the end", () => {
  const key = "abcd-efgh-ijkl-mnop-qrst-uvwx";
  const url = "utsi-g85lc6-old-art-d5e6.demo.workers.dev";
  const page = load(`#url=${url}`, fresh(key));

  // The one thing that must not happen: minting a stranger. The key on screen
  // has to be the key inside the Worker that sent the URL.
  assert.equal(page.at("key").textContent, key);
  assert.equal(page.at("url").value, url);
  assert.equal(page.at("returned").hidden, false);

  // A 40 character hostname does not fit in an input box on a phone, and this is
  // the one value the reader has to be able to read all of.
  assert.equal(page.at("url-shown").hidden, false);
  assert.equal(page.at("url-shown").textContent, `https://${url}`);
  assert.equal(page.at("url").hidden, true);
  assert.equal(page.at("edit-url").hidden, false);

  page.at("edit-url").click();
  assert.equal(page.at("url").hidden, false, "and the box comes back if they want it");
  assert.equal(page.at("url-shown").hidden, true);
  assert.equal(page.at("key-missing").hidden, true);

  assert.deepEqual(
    page.steps.filter((step) => step.children.details.open).map((step) => step.id),
    ["step-4"],
    "there is nothing left to do in the first three",
  );
  assert.ok(page.steps.slice(0, 3).every((step) => step.classes.has("done")));
  assert.ok(page.at("step-4").scrolled);
  assert.ok(page.at("curl").textContent.includes(key));
  assert.ok(page.at("curl").textContent.includes(url));
});

test("the fragment name the first version used still works", () => {
  // Workers deployed before the rename are still out there sending `addr`.
  const page = load("#addr=utsi-x.demo.workers.dev", fresh("abcd-efgh-ijkl-mnop-qrst-uvwx"));
  assert.equal(page.at("url").value, "utsi-x.demo.workers.dev");
  assert.equal(page.at("returned").hidden, false);
});

test("a URL arriving with no saved key says so instead of lying", () => {
  const page = load("#url=utsi-x.demo.workers.dev");

  assert.match(page.at("key").textContent, KEY_SHAPE);
  assert.equal(page.at("key-missing").hidden, false);
  assert.equal(page.at("returned").hidden, true);
});

test("a port survives, and loopback is not pretended to be https", () => {
  // `worker/tools/preview.mjs` serves on a port, and a reverse proxy in front of
  // a Worker does too. A box that rejects the URL in front of the reader is
  // worse than no box.
  const saved = fresh("abcd-efgh-ijkl-mnop-qrst-uvwx");
  const local = load("#url=127.0.0.1%3A8787", { ...saved });
  assert.equal(local.at("url").value, "127.0.0.1:8787");
  assert.ok(local.at("curl").textContent.includes("http://127.0.0.1:8787/"));
  assert.ok(!local.at("curl").textContent.includes("https://127.0.0.1"));

  const named = load("#url=utsi.example.test%3A8443", { ...saved });
  assert.ok(named.at("curl").textContent.includes("https://utsi.example.test:8443/"));
});

test("a fragment that is not a URL is ignored", () => {
  const saved = fresh("abcd-efgh-ijkl-mnop-qrst-uvwx");
  for (const hash of ["#url=not%20a%20url", "#url=", "#something-else", "#url=nodots", "#url=h.test%3A999999", ""]) {
    const page = load(hash, { ...saved });
    assert.equal(page.at("returned").hidden, true, hash);
    assert.equal(page.at("url").value, "", hash);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// testing it, which is the point of the last step
// ───────────────────────────────────────────────────────────────────────────

const ANSWER = JSON.stringify({
  query: "big buck bunny",
  count: 3,
  limit: 3,
  offset: 0,
  took_ms: 412,
  torrents: [{ name: "Big Buck Bunny", seeders: 40, magnet: "magnet:?xt=urn:btih:0000" }],
  engines: ["knaben", "yts"],
  engine_errors: {},
});

test("the test asks the reader's own Worker, with the key, and shows the answer", async () => {
  const key = "abcd-efgh-ijkl-mnop-qrst-uvwx";
  const url = "utsi-x.demo.workers.dev";
  const page = load(`#url=${url}`, fresh(key), { status: 200, body: ANSWER });

  page.at("run-test").click();
  await flush();

  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, `https://${url}/api/v1/search?q=big+buck+bunny&limit=3`);
  assert.equal(page.requests[0].options.headers["X-API-Key"], key);

  assert.match(page.at("test-status").textContent, /It works\. 3 results from 2 indexes in 412 ms\./);
  assert.equal(page.at("test-status").className, "status", "not the failure colour");
  assert.equal(page.at("test-output").hidden, false);
  assert.ok(page.at("test-output").textContent.includes('"took_ms": 412'), "pretty printed, not one line");
  assert.equal(page.at("build-on-it").hidden, false, "and only now is the API worth mentioning");
});

test("a URL that answers nothing is waited on, not given up on", async () => {
  // A brand new Cloudflare account has no certificate for its workers.dev name
  // for a couple of minutes, and every request fails until it does. That is the
  // most alarming moment in the whole setup, so the page keeps asking on its own
  // and says so, rather than reporting a problem the reader cannot act on.
  const key = "abcd-efgh-ijkl-mnop-qrst-uvwx";
  const page = load(`#url=utsi-x.demo.workers.dev`, fresh(key), [
    { throws: true },
    { throws: true },
    { status: 200, body: ANSWER },
  ]);

  page.at("run-test").click();
  await flush();

  assert.equal(page.requests.length, 1);
  assert.match(page.at("test-status").textContent, /Not live yet/);
  assert.match(page.at("test-status").textContent, /Tried 1 time\./);
  assert.equal(page.at("stop-test").hidden, false, "and offers a way to stop");
  assert.equal(page.at("run-test").disabled, true);

  page.tick();
  await flush();
  assert.equal(page.requests.length, 2);
  assert.match(page.at("test-status").textContent, /Tried 2 times\./);

  page.tick();
  await flush();
  assert.equal(page.requests.length, 3);
  assert.match(page.at("test-status").textContent, /It works\./, "and the moment it answers, it says so");
  assert.equal(page.at("stop-test").hidden, true, "and stops asking");
  assert.equal(page.at("run-test").disabled, false);
  assert.equal(page.at("build-on-it").hidden, false);
});

test("the checking loop gives up eventually, and can be stopped by hand", async () => {
  const page = load("#url=utsi-x.demo.workers.dev", fresh("abcd-efgh-ijkl-mnop-qrst-uvwx"), { throws: true });

  page.at("run-test").click();
  await flush();
  page.at("stop-test").click();
  assert.match(page.at("test-status").textContent, /Stopped/);
  assert.equal(page.at("stop-test").hidden, true);
  assert.equal(page.at("run-test").disabled, false);

  // And left alone it stops itself rather than hammering a URL forever.
  page.at("run-test").click();
  await flush();
  for (let i = 0; i < 40; i += 1) {
    page.tick();
    await flush();
  }
  assert.match(page.at("test-status").textContent, /Still nothing after three minutes/);
  assert.equal(page.at("stop-test").hidden, true);
  assert.ok(page.requests.length <= 38, `stopped asking, ${page.requests.length} tries`);
});

test("a refused key is told apart from an unreachable URL", async () => {
  const url = "utsi-x.demo.workers.dev";

  const wrongKey = load(`#url=${url}`, fresh("abcd-efgh-ijkl-mnop-qrst-uvwx"), {
    status: 401,
    body: '{"error":"unauthorized"}',
  });
  wrongKey.at("run-test").click();
  await flush();
  assert.equal(wrongKey.at("test-status").className, "status bad");
  assert.match(wrongKey.at("test-status").textContent, /refused this key/);
  assert.match(wrongKey.at("test-status").textContent, /const API_KEY/, "and says where the real one is");
  assert.equal(wrongKey.at("build-on-it").hidden, true);

  const unreachable = load(`#url=${url}`, fresh("abcd-efgh-ijkl-mnop-qrst-uvwx"), { throws: true });
  unreachable.at("run-test").click();
  await flush();
  assert.match(unreachable.at("test-status").textContent, /Not live yet/);
  assert.equal(unreachable.at("test-output").hidden, true, "and shows no half-answer");
});

test("the test refuses to guess when there is no URL", async () => {
  const page = load("", fresh("abcd-efgh-ijkl-mnop-qrst-uvwx"), { status: 200, body: ANSWER });
  page.at("run-test").click();
  await flush();

  assert.equal(page.requests.length, 0, "no request at all");
  assert.equal(page.at("test-status").className, "status bad");
  assert.match(page.at("test-status").textContent, /Fill in your URL first/);
});

test("nothing else on the page ever reaches the network", () => {
  // The claim in the verify section is that this page makes no requests. Pressing
  // the one button that does is the only exception, and it goes to the reader's
  // own Worker.
  const page = load("", fresh("abcd-efgh-ijkl-mnop-qrst-uvwx"));
  ["open-deploy", "copy-key", "copy-both", "copy-code", "copy-curl"].forEach((id) => page.at(id).click());
  page.steps.forEach((step) => step.children[".next"] && step.children[".next"].click());

  assert.deepEqual(page.requests, []);
});
