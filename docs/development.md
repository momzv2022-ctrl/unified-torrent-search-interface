# Development

[← back to the README](../README.md)

## Development

```sh
pip install -e ".[dev]"
pytest          # fully offline: no plugin and no torrent site is contacted
ruff check .
```

The suite runs against fixture engines in `tests/fixtures/` that produce every
shape the real ones do: magnet rows, `.torrent` URLs, opaque tokens, debug
chatter, a plugin that raises, a plugin that hangs, and one whose class name
only matches its module case-insensitively. Responses are validated against
`spec/tsp-openapi.yaml`, a checked-in copy of the TSP contract that CI compares
against upstream on every run.

```sh
utsi provision                      # fetch nova3 + plugins, report what landed
utsi search "big buck bunny" --cat video --json
utsi probe --all-public             # which engines answer from here
utsi registry-update --dry-run
```

Configuration is entirely environment variables; see [.env.example](../.env.example).

## The Worker, and the one line of npm

```sh
node --test worker/tests/*.test.mjs   # every suite: the Worker, and the setup page
node worker/tools/build.mjs           # the artifact and the setup page
node worker/tools/preview.mjs         # both of them running, on this machine
node worker/tools/probe-indexes.mjs   # which indexes answer from here
```

### Walking the setup flow without deploying anything

The flow spans two origins that only exist after a deploy — the setup page,
which mints the key, and the Worker, which is the only party that knows the
address and hands it back. Neither half can be judged alone, and going to
Cloudflare every time is a slow way to find a typo. `preview.mjs` serves both
and points them at each other:

```sh
node worker/tools/preview.mjs      # or: npm run preview

  setup page   http://127.0.0.1:8788/
  worker       http://127.0.0.1:8787/
  key          prev-iewk-eyno-tase-cret-0000
```

It builds first, splices a visibly fake key into the artifact exactly as the
setup page does in a browser, and rewrites `SETUP_PAGE` so the Worker's *Finish
setup* button points at the copy being served locally rather than the published
one.

Then walk it. The key is saved on this device by any of three actions — pressing
*Deploy it*, *Copy just the key*, or *Copy the program* — and for a local walk
you want the middle one, since the first navigates to Cloudflare and the third is
folded inside the "if that link will not open" disclosure. So: open the setup
page, press **Copy just the key** directly under the key in section 1, open the
Worker, press **Finish setup**, and land back on the setup page with the address
filled in beside that same key.

`UTSI_PREVIEW_PORT` moves the pair; the setup page is always the next port up.

**The deploy link is the one thing this cannot exercise**, because it goes to
Cloudflare. Its shape is covered by `worker/tests/worker.test.mjs` and
`worker/tools/playground-link.mjs --self-test`; what needed a real browser was
everything after it, and that is what this is for.

**There is still nothing to install.** `package.json` has no dependencies and
there is no lockfile; `npm install` would do nothing and is not a step. It exists
for one reason, and deleting it breaks the repository on Node 20:

Node decides whether a `.js` file is an ES module or CommonJS by the nearest
`package.json`. Without one, `.js` means CommonJS — and both `.js` files here
(`worker/src/worker.js` and `worker/tools/playground.js`) are ES modules, so
every `import { … } from "./….js"` threw `Named export not found`. That included
the entire test suite. Node 22.7 added automatic module-syntax detection, which
hid the problem completely on new Node while it stayed broken on the LTS before
it — and CI, pinned to 22, was green throughout. The `"type": "module"` line
states what those files always were.

CI now runs the Worker job on Node 20 **and** 22 for exactly that reason. If you
are adding tooling, run it on the older one before believing it works: the
failure mode is a confident CommonJS error message about a file that has never
been CommonJS.

Adding the second suite walked straight into the same trap, and the way out is
narrower than it looks. **Leave the glob unquoted** and let the shell expand it:

| | Node 20 | Node 22 |
|---|---|---|
| `node --test "worker/tests/*.test.mjs"` | `Could not find` | passes |
| `node --test worker/tests/` | passes | `Cannot find module` |
| `node --test worker/tests/*.test.mjs` | passes | passes |

Quoted, the glob reaches Node, which only learned to expand one in 22. As a
directory it reaches Node 20's file search, which 22 no longer does — it treats
the argument as a file and tries to import a directory. Unquoted, the shell
expands it before Node sees anything and both versions get a list of files.
Either wrong form is green on one job and red on the other, which is why the
matrix exists.

### A deliberate deviation from nova3

`nova2.py`'s multi-engine mode merges every engine's stdout into one stream
through a `multiprocessing` pool. One hanging site stalls the whole response and
failures cannot be attributed to an engine, so it is not used for production
traffic. Each engine gets its own process, launched by a ~150-line shim.

The shim is also slightly more forgiving than nova3 on import: nova3 requires the
class name to equal the module name and gives up otherwise, but real plugins
break that rule (`rutracker.py` defines `class RuTracker`). It falls back to a
case-insensitive match, then to the module's sole class implementing `search()`.
That only widens what can be loaded; the sandbox around it is unchanged.
