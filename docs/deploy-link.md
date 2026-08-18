# Getting the program into a Cloudflare account

How the setup page's link works, how its format was established, and the two
things that still want a real device.

---

## The short version

The setup page hands you **one link**. It opens Cloudflare's Workers playground
with the program already loaded and your key already in it — no copy, no paste,
no code editor. From there it is *Deploy*, sign in, name it.

Copy-and-paste is still on the page, behind a disclosure, because a link this
long is one some browser somewhere will refuse. Nobody who taps the link and
gets nothing is stranded.

**Since 0.4.0 the "some browser" is known, and it is Safari.** The descriptor
engine and the signed feed (see [tgp.md](tgp.md)) grew the program past what
fits under Safari's ~80,000-character URL ceiling once compressed — about 96,000
characters — and no amount of trimming brings it back: the machinery is bigger
than the headroom was, and minifying the artifact to fit would break the
project's actual promise, which is that the file you deploy is the file you can
read. Chrome, Firefox and Edge take URLs orders of magnitude longer and open
the link fine. The page measures the link it built and tells Safari users to
use the copy-and-paste route, which ends in exactly the same deployed Worker.

---

## The format

The playground keeps whatever it is showing in the URL **fragment** — the `#…`
part. That matters here for more than convenience: a fragment is never sent to
the server, so the key baked into the program does not reach Cloudflare when the
page loads.

The fragment is `lz-string`'s `compressToEncodedURIComponent` of:

```
multipart/form-data; boundary=----WebKitFormBoundary<16 random chars>
:
--<boundary>\r\n
Content-Disposition: form-data; name="index.js"; filename="index.js"\r\n
Content-Type: application/javascript+module\r\n
\r\n
<the program>\r\n
--<boundary>\r\n
Content-Disposition: form-data; name="metadata"; filename="blob"\r\n
Content-Type: application/json\r\n
\r\n
{"compatibility_date":"…","compatibility_flags":[],"main_module":"index.js"}\r\n
--<boundary>--\r\n
```

A content-type value, a colon, then that multipart body — the same shape as
Cloudflare's Workers upload API, one part per module and `metadata` last. It is
implemented in [`worker/tools/playground.js`](../worker/tools/playground.js),
which the setup page inlines so there is one copy rather than two that can drift.

### How we know

Not from documentation — there is none — and not from guessing. A link produced
by the live playground on **2026-08-16** was decompressed with the reference
`lz-string` decoder, split into its parts, and fed back through
`playgroundPayload()`, which **reproduced the original payload and then the
original fragment byte for byte**. That is the whole verification: if any detail
of the layout were wrong, the bytes would not have matched.

Two consequences worth keeping in mind:

- The encoder is right. `worker/tools/playground-link.mjs --self-test` pins it to
  `lz-string` 1.5.0's own output, and CI runs it.
- **The format is undocumented and Cloudflare can change it whenever they like.**
  Nothing in this repository will notice if they do — a fixture here only catches
  *our* regressions. If the link ever opens an empty playground, re-run the check
  below; it takes about three minutes.

### Re-checking it

1. Open <https://workers.cloudflare.com/playground>, press **Copy Link**.
2. Decompress the `#…` part with `lz-string`'s
   `decompressFromEncodedURIComponent`.
3. If it still starts `multipart/form-data; boundary=…:`, nothing has changed.
   If it does not, the shape it *has* changed to is right there in the output.

```sh
node worker/tools/playground-link.mjs worker/src/worker.js   # generate one
node worker/tools/playground-link.mjs --self-test            # check the encoder
```

---

## Size, which is the real constraint

The program is about 162 KB and compresses to a fragment of roughly **97,000
characters**. That is fine in Chrome, Firefox and Edge, which take URLs measured
in megabytes. Safari's ceiling is nearer — around 80,000 characters for the whole
URL — and since 0.4.0 the link **no longer fits under it**. That was a decision,
not an accident: minifying the artifact to fit would break the project's actual
promise, which is that the file you deploy is the file you can read.

`worker/tests/worker.test.mjs` asserts the link stays under **300,000**
characters — the limit of the browsers it still serves, so growth is measured
rather than assumed. The setup page measures the link it built and points Safari
users at copy-and-paste, which ends in exactly the same deployed Worker.

**The link works.** A Worker was deployed from one on a real Cloudflare account
on 2026-08-16 — the resulting `workers-playground-…` address answered, with zero
errors and 1.65 ms of CPU per request. So the format, the deploy, and the
compatibility date are all confirmed end to end.

## Skipping the editor

The playground is a code editor with a *Deploy* button on it. That button goes to

```
https://dash.cloudflare.com/workers-and-pages/deploy/playground/<name>#<fragment>
```

and the fragment is **the same fragment** — read off the live button, decoded,
and confirmed byte-identical in shape to what `playgroundPayload()` builds. So
`deployLink()` is not a new format; it is the destination the editor was sending
people to anyway, reached without the stop in between. `bothLinks()` builds the
pair from one pass of the compressor, because doing 120 KB twice is a visible
freeze on a phone.

> **Broken upstream since 2026-08-18.** The deploy screen now answers
> `Incoming deployment from Workers Playground missing worker hash` and renders
> "The Cloudflare Dashboard is temporarily unavailable" instead of the deploy
> form. Reproduced in Chrome with the fragment present and absent: without a
> fragment the dashboard boots and reports a missing payload, with one it hits
> its error boundary. It is not a length problem and not an outage — Cloudflare
> expects a worker hash this link does not carry, exactly the undocumented-format
> drift warned about above. The setup page now leads with the **playground**
> link, which was re-verified working on 2026-08-18 (program in the editor,
> preview answering), and keeps the deploy link behind a disclosure that says
> this.

**Also confirmed on a real account, 2026-08-16.** A link generated by this
project — not by the playground — opened the deploy screen with the name
pre-filled and this project's own `index.js` under *Code preview*.

Two things learned from that screen, both now reflected in the page:

- **Cloudflare lengthens the name.** `utsi-g85lc6` arrived as
  `utsi-g85lc6-old-art-d5e6`. So the final address cannot be predicted here and
  the page does not pretend to: it tells you to take the address off the screen
  that shows it.
- **The name is the address**, so the default is randomised per visit. A constant
  would hand every reader of this repository the same one.

The trade is the preview: the deploy screen shows the code but does not run it.
The playground link stays on the page for anyone who would rather look first, and
`--deploy` on `playground-link.mjs` prints either.

Why bother, when the playground worked? Because on 2026-08-16 it also blank-paged
on two branches for one person while working in that person's incognito window —
a browser-profile problem, not a payload one, but a reminder that the shortest
path through somebody else's UI is the one with the fewest pages that can have a
bad day.

**What is still unverified is the phone.** A 97 KB fragment has not been opened
on a real Android device or a real iPhone. That is the one remaining item, and it
is the kind of thing only a device answers:

- [ ] open a generated link in Chrome on Android
- [ ] open a generated link in Safari on iOS
- [ ] confirm the program arrives intact — the playground's preview answering
      `/healthz` proves it, before anything is deployed
- [ ] if either truncates, say so on the setup page and move copy-and-paste back
      to the front

---

## The steps after the link

**Walked once, successfully**, on 2026-08-16: link, Deploy, name, and a live
`*.workers.dev` address. The wording below still describes what to look for
rather than promising exact labels, because Cloudflare renames things.

1. The link opens the playground with the program in the editor and running in
   the preview pane.
2. **Deploy**, top right. Sign in or make a free account — an email address and a
   password, no domain and no card.
3. Cloudflare asks for a name. It becomes the address.
4. Open `/healthz` on the resulting `*.workers.dev` address.

Worth confirming on one pass and correcting here:

- [ ] whether **Deploy** from the playground goes straight to a named Worker, or
      via an intermediate screen
- [ ] whether the name is chosen before or after the deploy
- [ ] that the result is on `*.workers.dev` with no further setup
- [ ] that a playground deploy keeps the pinned `compatibility_date` rather than
      substituting its own

---

## Why the key is in the link but not in this page's own URL

The generated playground link contains the key, because the program contains the
key — that is the whole point of minting one in the browser. The page says so
next to the link, in those words: treat it like a password, do not send it to
anyone.

The setup page's *own* URL contains nothing. A bookmark of it is not a
credential, and sharing the page is safe. The usual argument for putting the key
in the page's fragment is recovery, and it does not apply here, because the key
ends up somewhere better: on the `const API_KEY` line of the program, inside the
reader's own Cloudflare account. Recovering it is "open your Worker, press Edit
code, read the line near the top".

---

## Why not the Deploy to Cloudflare button

The previous version of this project used one. It required a GitHub account, a
GitHub-to-Cloudflare authorisation, about six wizard pages and a two-minute
build — and the repository-reading step was flaky enough that the old
documentation had to tell people to press Continue again when it failed.

A link needs none of that. One account, no build, and what you deploy is what you
read on the way past.
