/**
 * The TGP feed pipeline: make keys once, then build and sign `feed.json`.
 *
 *     node worker/tools/feed.mjs keygen           # once, on a machine you trust
 *     node worker/tools/feed.mjs build            # nightly, in CI, with $TGP_FEED_KEY
 *     node worker/tools/feed.mjs verify           # what a Worker will conclude
 *
 * The feed is how a Worker pasted into someone else's Cloudflare account keeps
 * its engine addresses and definitions current (see docs/tgp.md). Three files
 * matter here:
 *
 *   feed/engines.json      the source of truth a maintainer edits
 *   feed/feed.json (+.sig) the signed artifact `build` produces, published to
 *                          GitHub Pages next to worker.js by the pages workflow
 *   feed/keyring.json (+.sig) the signing subkeys, blessed by the offline root
 *
 * Trust model, in one paragraph: `keygen` makes two *root* keys and one CI
 * *subkey*. The root public keys are pinned inside worker.js; the root private
 * keys are printed once, for offline storage, and never touch this repository
 * or CI. The subkey's private half becomes the TGP_FEED_KEY repository secret,
 * and is the only key `build` ever sees — so a CI compromise burns a subkey
 * (rotate it with the root, re-sign the keyring) and never the roots.
 *
 * `build` refuses to sign anything the deployed Worker would reject or that
 * changes behaviour silently: every descriptor is validated by the *Worker's
 * own* validator, and every descriptor that shadows a compiled-in engine is
 * replayed against that engine's recorded fixture — the rows must match what
 * the compiled-in configuration emits, byte for byte. A descriptor that does
 * not reproduce golden behaviour needs the seed in worker.js updated in the
 * same change, which is exactly the review that should happen.
 */

import { createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { __testing } from "../src/worker.js";

const { SEED_DESCRIPTORS, ENGINES, descriptorProblem, runDescriptor, verifyFeedDocuments, TGP_ROOT_KEYS } =
  __testing;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const FEED_DIR = join(REPO, "feed");
const FIXTURES = join(REPO, "worker", "tests", "fixtures");
const WORKER_SOURCE = join(REPO, "worker", "src", "worker.js");

const EXPIRES_DAYS = 14;
const PAGES_BASE = "https://momzv2022-ctrl.github.io/unified-torrent-search-interface/";

const read = (path) => readFileSync(path, "utf8");
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

// --- Ed25519, via node:crypto so a private key can be handled as PKCS#8 ------

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

/** The raw 32-byte public key inside an SPKI DER export — its last 32 bytes. */
function rawPublicKey(keyObject) {
  const spki = keyObject.export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32);
}

function signText(privateKeyPem, text) {
  return b64(nodeSign(null, Buffer.from(text, "utf8"), privateKeyPem));
}

function privateKeyFromBase64(pkcs8B64) {
  return createPrivateKey({ key: Buffer.from(pkcs8B64.trim(), "base64"), format: "der", type: "pkcs8" });
}

async function generateKeyPair() {
  const { generateKeyPairSync } = await import("node:crypto");
  const pair = generateKeyPairSync("ed25519");
  return {
    publicRawB64: b64(rawPublicKey(pair.publicKey)),
    privatePkcs8B64: b64(pair.privateKey.export({ format: "der", type: "pkcs8" })),
    privateKey: pair.privateKey,
  };
}

// --- keygen ------------------------------------------------------------------

async function keygen() {
  const keyringPath = join(FEED_DIR, "keyring.json");
  if (existsSync(keyringPath) && !process.argv.includes("--force")) {
    console.error("feed/keyring.json already exists. Re-run with --force to replace the whole chain.");
    process.exit(1);
  }

  const rootA = await generateKeyPair();
  const rootB = await generateKeyPair();
  const subkey = await generateKeyPair();

  const now = new Date();
  const notAfter = new Date(now.getTime());
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 2);
  const keyId = `ci-${now.toISOString().slice(0, 7)}`;

  const keyring = JSON.stringify(
    {
      tgp_keyring_version: 1,
      issued_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      subkeys: [
        {
          key_id: keyId,
          public_key: subkey.publicRawB64,
          not_before: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
          not_after: notAfter.toISOString().replace(/\.\d{3}Z$/, "Z"),
        },
      ],
    },
    null,
    2,
  ) + "\n";

  mkdirSync(FEED_DIR, { recursive: true });
  writeFileSync(keyringPath, keyring);
  writeJson(join(FEED_DIR, "keyring.json.sig"), {
    algorithm: "ed25519",
    signature: signText(rootA.privateKey, keyring),
  });

  console.log("Wrote feed/keyring.json and feed/keyring.json.sig — commit both.\n");
  console.log("1. Pin the root public keys: replace the TGP_ROOT_KEYS line in worker/src/worker.js with\n");
  console.log(`const TGP_ROOT_KEYS = ["${rootA.publicRawB64}", "${rootB.publicRawB64}"];\n`);
  console.log("2. Add the CI signing subkey as a repository Actions secret named TGP_FEED_KEY:\n");
  console.log(`${subkey.privatePkcs8B64}\n`);
  console.log("3. Store the ROOT PRIVATE KEYS offline (a password manager, a printout —");
  console.log("   anywhere that is not this repository and not CI). They are shown once:\n");
  console.log(`   root A (signed this keyring): ${rootA.privatePkcs8B64}`);
  console.log(`   root B (the spare):           ${rootB.privatePkcs8B64}\n`);
  console.log("Losing both roots means shipping new pinned keys — a re-paste for every");
  console.log("deployment. Losing the subkey means re-running keygen's keyring step only.");
}

// --- build -------------------------------------------------------------------

/** A stub HTTP client that answers every request from one fixture body. */
function fixtureHttp(body) {
  return {
    async text() {
      return [200, body];
    },
    async bytes() {
      return [404, new Uint8Array()];
    },
  };
}

const REPLAY_FIXTURES = {
  knaben: "knaben.json",
  piratebay: "piratebay.json",
  torrentscsv: "torrentscsv.json",
  animetosho: "animetosho.json",
  eztvx: "eztvx.json",
  nyaa: "nyaa.xml",
};

/** Settings shaped like readSettings' output, enough to drive one engine. */
function replaySettings() {
  return {
    engineUrls: {},
    maxRowsPerEngine: 100,
    engineTimeoutS: 5,
    upstreamTimeoutS: 15,
  };
}

const replayQuery = { q: "replay", terms: "replay", cat: "", year: "", res: "", minSeeders: 0 };

/**
 * The gate from the requirements: a descriptor that shadows a compiled-in
 * engine must emit exactly the rows the compiled-in configuration emits from
 * the same recorded response. Byte-for-byte, via JSON.
 */
async function replay(descriptor) {
  const fixture = REPLAY_FIXTURES[descriptor.name];
  if (!fixture || !["json", "rss"].includes(descriptor.kind)) return null;
  const body = read(join(FIXTURES, fixture));

  const fed = await runDescriptor(descriptor, fixtureHttp(body), replayQuery, replaySettings());
  const compiled = await ENGINES[descriptor.name](fixtureHttp(body), replayQuery, replaySettings());
  const left = JSON.stringify(fed);
  const right = JSON.stringify(compiled);
  if (left !== right) {
    throw new Error(
      `${descriptor.name}: the feed descriptor does not reproduce the compiled-in engine's rows.\n` +
        `  feed:     ${left.slice(0, 400)}\n  compiled: ${right.slice(0, 400)}\n` +
        `If the change is intentional, update the seed descriptor in worker/src/worker.js in the ` +
        `same commit — the two ship together or not at all.`,
    );
  }
  return fixture;
}

/** Validate and replay feed/engines.json without signing anything. */
async function check() {
  const sourcePath = join(FEED_DIR, "engines.json");
  if (!existsSync(sourcePath)) {
    console.error("feed/engines.json does not exist; run `node worker/tools/feed.mjs init` first.");
    process.exit(1);
  }
  const source = JSON.parse(read(sourcePath));
  const engines = source.engines || [];
  if (!Array.isArray(engines) || !engines.length) throw new Error("feed/engines.json has no engines");
  if (engines.length > 64) throw new Error("more than 64 engines");

  // The Worker's own validator is the arbiter — there is exactly one schema.
  for (const entry of engines) {
    const problem = descriptorProblem(entry);
    if (problem) throw new Error(`${entry && entry.name}: ${problem}`);
  }
  let replayed = 0;
  for (const entry of engines) {
    const fixture = await replay(entry);
    if (fixture) {
      console.log(`replayed ${entry.name} against ${fixture}: identical rows`);
      replayed += 1;
    }
  }
  console.log(`checked ${engines.length} engines (${replayed} replayed against fixtures)`);
  return source;
}

async function build() {
  const source = await check();
  const engines = source.engines;

  const serialPath = join(FEED_DIR, "serial");
  const serial = (existsSync(serialPath) ? Number(read(serialPath).trim()) : 0) + 1;
  const now = new Date();
  const expires = new Date(now.getTime() + EXPIRES_DAYS * 24 * 3600 * 1000);
  const stamp = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

  const feedText = JSON.stringify(
    {
      tgp_version: 1,
      serial,
      issued_at: stamp(now),
      expires_at: stamp(expires),
      moved_to: source.moved_to ?? null,
      mirrors: source.mirrors || [`${PAGES_BASE}feed.json`],
      engines,
    },
    null,
    2,
  ) + "\n";

  const keyB64 = process.env.TGP_FEED_KEY;
  if (!keyB64) {
    console.error("TGP_FEED_KEY is not set. The feed must be signed; an unsigned feed is unusable.");
    process.exit(1);
  }
  const privateKey = privateKeyFromBase64(keyB64);
  const publicRaw = b64(rawPublicKey(createPublicKey(privateKey)));

  const keyring = JSON.parse(read(join(FEED_DIR, "keyring.json")));
  const subkey = (keyring.subkeys || []).find((entry) => entry.public_key === publicRaw);
  if (!subkey) {
    throw new Error(
      "TGP_FEED_KEY's public half is not in feed/keyring.json — the Worker would reject this " +
        "signature. Re-run keygen, or add the subkey to the keyring and re-sign it with the root.",
    );
  }

  writeFileSync(join(FEED_DIR, "feed.json"), feedText);
  writeJson(join(FEED_DIR, "feed.json.sig"), {
    key_id: subkey.key_id,
    algorithm: "ed25519",
    signature: signText(privateKey, feedText),
  });
  writeFileSync(serialPath, `${serial}\n`);
  console.log(`wrote feed/feed.json — serial ${serial}, ${engines.length} engines, expires ${stamp(expires)}`);

  await verify();
}

// --- init --------------------------------------------------------------------

/** Seed feed/engines.json from the descriptors compiled into the Worker. */
function init() {
  const path = join(FEED_DIR, "engines.json");
  if (existsSync(path) && !process.argv.includes("--force")) {
    console.error("feed/engines.json already exists; edit it directly (or --force to regenerate).");
    process.exit(1);
  }
  mkdirSync(FEED_DIR, { recursive: true });
  writeJson(path, {
    "//": [
      "The source of truth for the published feed. `node worker/tools/feed.mjs build`",
      "validates every entry with the Worker's own validator, replays each one against",
      "its recorded fixture, and signs the result. Engines here shadow the seed",
      "compiled into worker.js — change both together, or the replay gate will refuse.",
    ],
    moved_to: null,
    mirrors: [`${PAGES_BASE}feed.json`],
    engines: SEED_DESCRIPTORS,
  });
  console.log("wrote feed/engines.json from the compiled-in seed descriptors");
}

// --- verify ------------------------------------------------------------------

async function verify() {
  const docs = {
    feed: read(join(FEED_DIR, "feed.json")),
    feedSig: read(join(FEED_DIR, "feed.json.sig")),
    keyring: read(join(FEED_DIR, "keyring.json")),
    keyringSig: read(join(FEED_DIR, "keyring.json.sig")),
  };
  const pinned = /^const TGP_ROOT_KEYS = \[([^\]]*)\];$/m.exec(read(WORKER_SOURCE));
  const rootKeys = pinned && pinned[1].trim()
    ? pinned[1].split(",").map((key) => key.trim().replace(/^"|"$/g, ""))
    : TGP_ROOT_KEYS;
  if (!rootKeys.length) {
    console.log("verify: worker.js pins no root keys yet — deployed Workers will ignore this feed.");
    return;
  }
  const feed = await verifyFeedDocuments(docs, rootKeys, Date.now());
  console.log(
    `verify: a Worker pinning worker.js's roots accepts this feed — serial ${feed.serial}, ` +
      `${feed.engines.length} engines, expires ${feed.expires_at}`,
  );
}

// --- entry -------------------------------------------------------------------

const command = process.argv[2];
if (command === "keygen") await keygen();
else if (command === "build") await build();
else if (command === "check") await check();
else if (command === "init") init();
else if (command === "verify") await verify();
else {
  console.error("usage: node worker/tools/feed.mjs <keygen|init|check|build|verify>");
  process.exit(1);
}
