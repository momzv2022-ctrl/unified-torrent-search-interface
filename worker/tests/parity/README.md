# Parity with the Python Worker

This directory is the bridge that was used to port `cloudflare/src/*.py` to
`worker/src/worker.js`. It exists so the claim "the JavaScript Worker answers
exactly what the Python one answered" is a thing you can re-run rather than a
thing you have to believe.

## What it does

`scenarios.json` describes 23 searches — every fixture in `worker/tests/fixtures`,
every engine, every filter, every sort, both merge orders, engines that fail,
and the paging edges. Each scenario is a settings object, a table of stubbed
URLs, and a query. **No scenario touches the network**: the stub answers from
fixtures and returns 404 for anything not in its table, which is also how a
scenario proves an engine was *not* asked.

`run-py.py` and `run-js.mjs` feed those scenarios to the two implementations and
print the TSP response bodies as JSON.

## The result

Byte-identical, all 23 scenarios, on the commit that introduced
`worker/src/worker.js`. The frozen output is `worker/tests/golden/search.json`,
and `worker/tests/worker.test.mjs` re-checks the JavaScript worker against it on
every CI run — so the parity survives the Python worker's deletion, which is the
only part of it that had to.

Those 23 are the parity record and do not change. Scenarios added afterwards are
a different thing wearing the same coat: regression fixtures for engines the
Python worker never had, frozen the same way and checked by the same test, but
proving only that this worker still answers what it answered yesterday. The
three `piratebay` scenarios are the first of them. When you add an engine, add
its scenario at the end of its group and regenerate — and check that the
original 23 came out unchanged, because if they did not, you altered something
you were not aiming at.

Three values are pinned before comparing, because they cannot be equal between
two runs of two languages and are not part of the contract:

| Pinned | Why |
|---|---|
| `took_ms` | a stopwatch |
| `scraped_at` | a clock |
| `not JSON: …` detail | CPython says `Expecting value: line 1 column 1`, V8 says `Unexpected token '<'` |

One deliberate difference is **not** pinned, because it is not in the output at
all: `json.dumps` escapes non-ASCII as `\uXXXX` and `JSON.stringify` does not.
Both emit valid JSON that parses to the same values; the runners compare the
JSON text they each produce with their own encoder, which is why the comparison
is byte-for-byte rather than "close enough".

## Re-running it

The JavaScript half runs anywhere:

```sh
node worker/tests/parity/run-js.mjs
```

The Python half needs `cloudflare/src/`, which was deleted when the port landed.
To run the reference side, check out **`966cfcd`** — the last commit with the
Python Worker in it — copy this directory and `worker/tests/fixtures` across, and
run:

```sh
python3 worker/tests/parity/run-py.py > /tmp/py.json
node   worker/tests/parity/run-js.mjs > /tmp/js.json
diff -u /tmp/py.json /tmp/js.json
```

## What is not covered

`piratebay` — the adapter was dropped rather than ported, so `apibay.json` and
`apibay_empty.json` did not come across either. The reasoning is in
[`docs/cloudflare.md`](../../../docs/cloudflare.md#why-there-is-no-piratebay-adapter).
