# Unified Torrent Search Interface

**Search several public torrent indexes at once, from a URL only you know.** It
asks them all the same question, merges the answers into one list, and hands back
names, sizes, swarm counts and `magnet:` links.

Three minutes to set up. Free, MIT licensed, no card, no domain, nothing
installed, and it works on a phone.

---

## Get it running

### The quick way: a free Cloudflare account, three minutes

Nothing to install, no terminal, no GitHub account. It works on a phone.

**[→ Open the setup page](https://momzv2022-ctrl.github.io/unified-torrent-search-interface/)**

Want to see it working first? [Here is the whole
setup](https://youtu.be/R9z3e6vYVNg), start to finish.

**Read it before you run it.** That page leads with the verification, not the
button: what the file is, how to check it is the same file this repository
published, what it can and cannot reach, and how to delete the whole thing. A
stranger asking you to put their code in your cloud account deserves suspicion,
and everything you need to settle it can be done before you deploy anything.

Then four steps, one at a time:

1. **Sign in to Cloudflare.** A free account is an email address and a password.
   No card and no domain. Do this first, because the deploy link carries the
   whole file in the part of a URL after the `#`, and a sign-in page in the
   middle of that journey is the one thing known to drop it. You would arrive
   signed in at an empty editor with nothing to show for the trip.
2. **Deploy to Cloudflare for free.** One link opens the deploy screen with the
   file already loaded and your key already in it. It is there under *Code
   preview*, so you can read what you are about to run. Press *Deploy*.
3. **Press the blue Visit button** on your new Worker's page. It opens and says
   *Your search is live*, with a **Finish setup** button on it. Press that. You
   never have to write the URL down.
4. **You are done.** Your URL and your key are side by side, both with copy
   buttons, and a **Test your URL and key** button runs a real search and prints
   the answer.

> If the Worker's URL says *This site can't provide a secure connection*, nothing
> is wrong with it. Cloudflare is still issuing the certificate for your brand new
> `workers.dev` name, and the dashboard does not tell you it is happening. Try
> switching on the *Preview* URL under that Worker's *Domains* tab and pressing
> *Visit* again, which people report clears it. Either way you are not stuck: the
> same tab shows your URL, so copy it into step 4 and carry on.

Step 3 is the one this project spent a long time getting wrong. The URL is
`name.your-account.workers.dev`, Cloudflare picks the account part and lengthens
the name, and no page anywhere can guess it. So for a while the last instruction
was "read it off Cloudflare's screen and type it into the other tab", which is
exactly where setups died. Now the Worker says it, and the URL travels in a
fragment, which browsers do not send to servers, so it goes from your Worker to
that page and nowhere else.

Your key is made in your browser and never sent anywhere. It goes into the copy
of the file that goes into the link, which is why the link is worth treating like
a password. If you lose the key it is not gone: open your Worker, press *Edit
code*, and read the line near the top that starts `const API_KEY`. The setup page
keeps a copy in your browser for a week so it can pair the two halves, and it
saves one only when you act on it, never merely for visiting.

> The link is long, because the whole file is inside it. Chrome, Firefox and Edge
> open it. Safari's URL ceiling is lower than the file is big, and the page says
> so before you tap. Either way there is a **Copy the file** button and the
> dashboard steps that do the same job, and they end at exactly the same deployed
> Worker. Nobody gets stranded.

Cloudflare's free plan covers 100,000 requests a day, forever. The Worker
searches a handful of indexes with a real API, plus one meta-index that covers
dozens of trackers. What that leaves out, and how to get it back, is in
[docs/cloudflare.md](docs/cloudflare.md).

### The full way: on a machine of your own

This is the version that searches around a hundred sites, by running
qBittorrent's own search plugins in a sandbox. You need **Python 3.11 or newer**
and a Mac, a Linux box, or Windows with WSL.

```sh
git clone https://github.com/momzv2022-ctrl/unified-torrent-search-interface
cd unified-torrent-search-interface
./start.sh
```

The first run takes a few minutes. When it finishes it prints an address and a
key:

```
  URL  https://calm-mode-tiny-fox.trycloudflare.com
  Key  Xy9wR2mKp4Ln8vQ2sT6yB1cE5hJ9dF3g
```

**That address and that key are the whole product.** Open the address in any
browser, on any device, paste the key in once, and search. `./stop.sh` takes it
down; `./update.sh` gets the latest version.

It downloads the plugins fresh every time it starts and runs each one inside its
own locked box. **No plugin code lives in this repository** — that single rule
shapes the whole design, and the reasons are in
[docs/security.md](docs/security.md).

Details, Windows, a cheap server, and what to do when few engines answer:
[docs/development.md](docs/development.md) and
[docs/security.md](docs/security.md).

### Both at once

Point the Cloudflare Worker at a machine running `./start.sh` and you get the
hundred plugins *and* an address that stays up when the machine sleeps. Set
`UTSI_UPSTREAM_URL` on the Worker — [docs/cloudflare.md](docs/cloudflare.md#your-own-index).

---

## Using it

**In a browser.** The local server serves a page: open the address, paste the key
once, search. Results are cards with a **Get** button, which is an ordinary
`magnet:` link — it hands off to whatever torrent app you already have.

The Cloudflare Worker is an API and has no search page. It answers its own URL
with one small page, and that page exists for a single reason: to tell you the
URL and hand it back to the setup page. It never shows the key. Every
`*.workers.dev` hostname turns up in the public certificate transparency logs
within minutes, so a page anyone may find is no place for a secret.

**From an app.** It speaks
[Torrent Stream Protocol](https://github.com/raul2hot/torrent-stream-protocol),
so any TSP client works. Give it the address and the key.

**From a terminal.**

```sh
curl -H "X-API-Key: YOUR-KEY" \
  "https://your-address/api/v1/search?q=big+buck+bunny&limit=5"
```

The full API, including every filter, is in [docs/api.md](docs/api.md).

---

## When something stops working

**Open `/healthz` first.** It needs no key and it says what is actually wrong:

- `"status":"not_configured"` — the key never arrived, or is under 16
  characters. Fix it where you set it.
- `"status":"degraded"` — either every index it tried came back broken, or the
  general-purpose ones did and only a single-subject index is left standing. The
  `coverage` field tells you which: `"narrow"` means films and anime still work
  and a search for a book or a disk image will find nothing. Read
  `engine_status`; each entry says which address it used and what happened.
- `"last":"rate_limited"` on an index — that one is alive and has decided you are
  asking too often. Pointing it at a different address will not help; the fix is
  to ask less, or to put an index of your own in front of it.
- `"status":"ok"` but no results — the search itself carries `engine_errors`,
  which says which index refused and why.

**An index moved domain.** These sites do that constantly. Every engine already
carries several addresses and tries them in turn, so most moves are invisible.
When one is not, point it somewhere new from the Cloudflare dashboard, under
Settings → Variables and Secrets:

```
UTSI_ENGINE_URLS = yts=https://the-new-address.example
```

No re-paste, no redeploy. This is the normal repair.

**Your copy is old.** `/healthz` compares its version against the one this
project publishes and tells you when a newer one exists. Updating is the same
copy-and-paste it was the first time; your key stays put, because it is either in
the file you are replacing (copy it across) or set as a variable, which nothing
touches.

**Few engines answer at all.** That depends on the address asking, not on the
software: many sites treat data-centre addresses as suspicious, so a rented
server gets worse results than a home connection. Ask your own deployment which
ones work for it:

```sh
curl -H "X-API-Key: YOUR-KEY" "https://your-address/api/v1/engines?probe=1"
```

To tell "this index is dead" apart from "this index dislikes Cloudflare's
addresses", ask the same question from your own machine and compare:

```sh
node worker/tools/probe-indexes.mjs
```

It needs no install and nothing deployed. It also asks a few indexes this Worker
has no adapter for, which is how you find out whether one is worth adding.

The first line of the answer is a list you can paste straight into
`UTSI_ENGINES`. On the local server, `UTSI_SOCKS_PROXY` sends the searching back
out through a connection of your own, which is the fix when your server's address
is the problem.

---

## What this is, and is not

It **searches public indexes and returns metadata and `magnet:` URIs**. It hosts
nothing, stores nothing, and transfers no file. It is not a BitTorrent client and
it downloads nothing — the links go to whatever torrent app you already have.
qBittorrent ships the same search plugins; Jackett and Prowlarr are the same kind
of tool.

It **keeps no search log**. That is a true statement about logging and nothing
more. It is not anonymity: the indexes see the query, your network carries it,
and on the Cloudflare path Cloudflare is your network. On that path, request
logging is switched off in the file you paste, on purpose, so there is no second
durable copy of your searches — but Cloudflare still sees the traffic.

There is **no public instance of this, and no list of other people's**. The only
address that exists is the one you make.

Plenty of what moves over BitTorrent is meant to: Linux and BSD installation
images, Internet Archive material, public-domain film, Creative Commons music and
video, game mods, and the large scientific and open datasets distributed this way
because it is the cheapest way to move a terabyte. The examples throughout this
project are *Big Buck Bunny* and *Sintel* — both released by the Blender
Foundation under Creative Commons — and *Ubuntu*, and that is deliberate.

**Your responsibility.** Laws about what you may download differ from country to
country, and so do the terms of the sites this queries. Complying with both is
yours to do. This software is published under the MIT licence with no warranty of
any kind, and nothing here is legal advice.

---

## Going deeper

| | |
|---|---|
| [docs/api.md](docs/api.md) | The API in full, and how plugin output becomes it |
| [docs/cloudflare.md](docs/cloudflare.md) | The Worker: settings, engines, limits, trade-offs |
| [docs/deploy-link.md](docs/deploy-link.md) | How the setup flow was arrived at, and what is still unverified |
| [docs/tgp.md](docs/tgp.md) | The signed engine feed: how a pasted Worker stays current without a re-paste |
| [docs/security.md](docs/security.md) | The sandbox, the plugin registry, the nightly bot |
| [docs/development.md](docs/development.md) | Tests, layout, contributing |
| [PLUGINS.md](PLUGINS.md) | Every plugin, its author and its licence |
| [.env.example](.env.example) | Every setting, with defaults |

```
worker/src/worker.js     the Cloudflare Worker — one file, no dependencies
src/utsi/                the local server: plugin sandbox, fan-out, TSP
registry.json            the plugin list, refreshed nightly and pinned
spec/tsp-openapi.yaml    the protocol both deployments answer
```

## Licence

MIT, and it covers the code in this repository only. There is no plugin code
here. Plugins stay under their own licences, listed in
[PLUGINS.md](PLUGINS.md), and the nova3 runtime files are distributed by their
authors under a 3-clause BSD-style licence.
