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
node --test worker/tests/worker.test.mjs   # the whole Worker suite
node worker/tools/build.mjs                # the artifact and the setup page
node worker/tools/probe-indexes.mjs        # which indexes answer from here
```

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
