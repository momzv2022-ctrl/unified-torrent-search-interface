# Security, the registry, and the daily bot

[← back to the README](../README.md)

## The one rule everything else follows from

**No plugin code lives in this repository. Not one `.py`.**

Plugins are fetched at runtime from their upstream authors, pinned to a commit
SHA and a `sha256`, executed in a subprocess, and thrown away when the service
stops. That is not squeamishness. It is what makes the project maintainable and
distributable:

- **Licensing.** The ~100 community plugins are a genuine mix: the official ones
  are GPL-2.0-or-later, `LightDestory` (15 plugins) is GPL-3.0, `BurningMop`
  (15), `imDMG` (10) and `tolotp` (10) are MIT, and `bugsbringer` (6) and
  `MadeOfMagicAndWires` (5) have no licence file at all, which under default
  copyright means no redistribution right. Vendoring that mix into one repo
  would be a licensing mess. Storing a URL and a hash sidesteps it entirely: your
  deployment downloads from the author, exactly as a qBittorrent user does.
- **Maintenance.** Plugins break when sites change. Not owning them means not
  owning that treadmill.
- **Freshness.** A redeploy picks up the day's `registry.json` automatically.

Every plugin is attributed to its author and repository in [PLUGINS.md](../PLUGINS.md).

## Security

You are downloading and executing Python from ~100 repositories you do not
control. The qBittorrent wiki says it plainly: *"Python plugins/scripts are, by
its nature, not considered to be safe."* This is the largest risk in the
project, and it is not theoretical.

- **Pinned, never floating.** Every plugin URL points at an immutable commit SHA
  and carries a `sha256`. A mismatch is refused at boot, not auto-updated.
- **Subprocess, never imported.** Plugin code never enters the API process. Each
  invocation gets a hard timeout, capped address space, CPU and file size, and
  its own session so the whole process group can be killed.
- **No secrets in reach.** The subprocess environment is an allowlist. The API
  key, deploy tokens and cloud credentials are not in it, and there is a test that
  asserts exactly that.
- **Static scan on ingest.** `eval`, `exec`, `compile`, `__import__`,
  `os.system`, `subprocess`, `pickle`, `marshal`, `socket` and direct dunder
  reach-arounds are rejected outright. It is a cheap tripwire, not a sandbox; the
  subprocess is the containment.
- **Host tracking, not host blocking.** Plugins legitimately talk to more hosts
  than they declare (piratebay declares `thepiratebay.org` and calls
  `apibay.org`), so a foreign host is recorded for review rather than treated as
  a verdict. The security value is in noticing the day a plugin *gains* a host.
  `UTSI_STRICT_HOSTS=1` makes it fatal.
- **Public sites only.** The wiki's ~25 private-site plugins need user
  credentials; excluding them removes an entire class of credential-handling
  liability. `UTSI_INCLUDE_PRIVATE=1` opts in.
- **`❗` and `✖` are hard-excluded.** The wiki states those plugins "will result
  in the slowdown and malfunction of other plugins as well". Where a row carries
  several glyphs, the worst one wins.
- **One writable directory.** Plugin code lands in `UTSI_RUNTIME_DIR` (`/tmp`
  by default) and nowhere else, and is re-fetched from scratch on every boot.

Keep `UTSI_ALLOW_ANONYMOUS` off. An open, unauthenticated scraper proxy on a
public URL will be found and abused.

## The registry

`registry.json` is the only state this project owns. It stores where a plugin
lives and what it hashed to, never the plugin.

```jsonc
{
  "id": "piratebay",
  "source": "official",
  "url": "https://raw.githubusercontent.com/…/<sha>/nova3/engines/piratebay.py",
  "pinned_sha256": "…",
  "license": "GPL-2.0-or-later",
  "wiki_status": "ok",             // ok | warn | broken  (✔ | ❗ | ✖)
  "categories": ["all", "games", "movies", "music", "software"],
  "link_kind": "magnet",           // magnet | torrent_url | needs_dl | unknown
  "health": { "score": 0.8, "last_ok": "…", "median_ms": 810, "rows": 31 },
  "enabled": true
}
```

A daily workflow rebuilds it from the community plugin list, which is a file on
`master` in qbittorrent/search-plugins, not wiki-only, so tracking it needs no API
token and gives commit history and blame. New plugins and content changes to
already-trusted ones land on a `registry-review` branch and open a pull request
instead of merging silently, because that is exactly the case the pinning exists
to catch: deployments read `registry.json` from `main`, so nothing is live until
a human merges that pull request. (Until 2026-08 the bot pushed the updated pins
to `main` first and opened an issue after — a notification, not a gate. The
pirateiro 1.4 bump went out that way; it was reviewed after the fact and was a
benign parser fix, but the ordering was the bug, and this is the fix.)

### Turning the bot on

`.github/workflows/registry.yml` is already in the repo, but GitHub will not run
it until two things are true:

1. **It is on the default branch.** Scheduled workflows only ever run from the
   repository's default branch. On a feature branch the cron is ignored. Merge
   first.
2. **Actions can write.** Settings → Actions → General → Workflow permissions →
   **Read and write permissions**. Without it the bot's `git push` fails with a
   403 and the issue it wants to open never appears.

Then test it by hand rather than waiting for 04:00 UTC: Actions tab → *registry*
→ **Run workflow**. A green run with no diff is the expected result on day one,
since `registry.json` is already current.

Two things worth knowing afterwards:

- GitHub disables scheduled workflows in repositories with **60 days of no
  activity**, and emails you when it does. A single commit re-arms it.
- The bot opens an issue only for a new plugin or changed bytes in an existing
  one. Those are third-party code reaching your deployment, so they want a human;
  everything else it commits quietly.

Health is the one thing it cannot collect. See below.

**The bot does not smoke-test.** Running ~90 scrapers a day from GitHub Actions'
address space would measure Cloudflare's opinion of GitHub Actions, not the
plugins, and would auto-disable a healthy registry. Health belongs to the host
that actually serves traffic:

```sh
utsi probe --out .                              # on your deployment host
utsi registry-update --merge-health probe-report.json
```

Three consecutive failed merges disable a plugin. It stays in the file with its
history rather than being deleted, and one success brings it back.
