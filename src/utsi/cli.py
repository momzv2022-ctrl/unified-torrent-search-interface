"""`utsi` — serve the API, or run any stage of the pipeline on its own.

    utsi serve                      # the TSP index
    utsi provision                  # fetch nova3 + plugins, report what landed
    utsi search "big buck bunny" --cat video
    utsi probe --all-public         # M0: does any of this work from this host?
    utsi registry-update            # M4: rebuild registry.json + PLUGINS.md
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import logging
import sys
from dataclasses import asdict, replace
from pathlib import Path

from . import __version__
from .config import Settings
from .registry import Registry


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    # The HTTP client logs a header dump per request at DEBUG; that is never the
    # thing being debugged here.
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _now() -> str:
    return dt.datetime.now(tz=dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# --- commands --------------------------------------------------------------


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .app import create_app

    settings = Settings.from_env()
    uvicorn.run(
        create_app(settings),
        host=args.host or settings.host,
        port=args.port or settings.port,
        log_level="debug" if args.verbose else "info",
        access_log=not args.quiet_access_log,
    )
    return 0


def cmd_share(args: argparse.Namespace) -> int:
    from .share import share

    settings = Settings.from_env()
    if args.port:
        settings = replace(settings, port=args.port)
    return asyncio.run(share(settings, tunnel=not args.no_tunnel))


def cmd_provision(args: argparse.Namespace) -> int:
    from .provision import Provisioner

    settings = Settings.from_env()
    registry = Registry.load(settings.registry_path)
    report = asyncio.run(Provisioner(settings, registry).provision())

    print(report.describe())
    if report.core_error:
        print(f"nova3 core: {report.core_error}", file=sys.stderr)
        return 1
    for slot in sorted(report.slots.values(), key=lambda s: s.plugin.id):
        status = "ok  " if slot.ok else "FAIL"
        print(f"  {status} {slot.plugin.id:<24} {slot.error}")
    return 0 if report.ready else 1


def cmd_search(args: argparse.Namespace) -> int:
    from .provision import Provisioner
    from .search import SearchQuery, SearchService

    settings = Settings.from_env()
    registry = Registry.load(settings.registry_path)

    async def run() -> int:
        report = await Provisioner(settings, registry).provision()
        if not report.available():
            print(f"no engines available: {report.core_error}", file=sys.stderr)
            return 1
        service = SearchService(settings, report)
        try:
            result = await service.search(SearchQuery(
                q=" ".join(args.query), cat=args.cat, year=args.year, res=args.res,
                min_seeders=args.min_seeders, sort=args.sort,
                limit=args.limit, offset=args.offset,
            ))
        finally:
            await service.aclose()

        if args.json:
            print(result.model_dump_json(indent=2, exclude_none=True))
            return 0

        print(
            f"{result.count} results in {result.took_ms}ms "
            f"from {len(result.engines or [])} engines: {', '.join(result.engines or []) or '—'}"
        )
        for torrent in result.torrents:
            size = f"{(torrent.size_bytes or 0) / 1e9:.2f}G" if torrent.size_bytes else "?"
            print(
                f"  {torrent.seeders or 0:>6}S {torrent.leechers or 0:>6}L {size:>8}  "
                f"{(torrent.name or '')[:78]}"
            )
            print(f"          {torrent.infohash} [{','.join(torrent.sources or [])}]")
        return 0

    return asyncio.run(run())


def cmd_probe(args: argparse.Namespace) -> int:
    from .probe import run_probe, write_report
    from .registry import STATUS_OK

    settings = Settings.from_env()
    registry = Registry.load(settings.registry_path)

    if args.all_public:
        # Everything the wiki marks ✔ and public, regardless of `enabled`. This
        # is the measurement that decides whether the free-hosting story holds.
        for plugin in registry.plugins:
            plugin.enabled = plugin.wiki_status == STATUS_OK and not plugin.private

    report = asyncio.run(run_probe(
        settings, registry, query=args.query, category=args.cat, concurrency=args.concurrency
    ))
    markdown, payload = write_report(report, Path(args.out))
    print(report.to_markdown())
    print(f"wrote {markdown} and {payload}", file=sys.stderr)
    return 0 if report.usable else 2


def cmd_registry_update(args: argparse.Namespace) -> int:
    from .bot import build, merge_health, render_plugins_md

    registry_path = Path(args.registry)
    previous = Registry.load(registry_path) if registry_path.is_file() else None

    if args.merge_health:
        if previous is None:
            print(f"{registry_path} does not exist; nothing to merge into", file=sys.stderr)
            return 1
        touched = merge_health(previous, Path(args.merge_health))
        previous.generated_at = _now()
        previous.save(registry_path)
        Path(args.plugins_md).write_text(render_plugins_md(previous), encoding="utf-8")
        print(f"merged health for {touched} engines into {registry_path}")
        return 0

    result = asyncio.run(build(
        previous,
        include_wiki=not args.official_only,
        plugin_ref=args.plugin_ref,
        runtime_ref=args.runtime_ref,
    ))
    result.registry.generated_at = _now()

    if args.dry_run:
        print(result.summary())
        for change in result.changes:
            print(f"  {change}")
        return 0

    result.registry.save(registry_path)
    Path(args.plugins_md).write_text(render_plugins_md(result.registry), encoding="utf-8")

    review = result.review_changes()
    changes_path = Path(args.changes_out)
    changes_path.write_text(
        json.dumps(
            {
                "summary": result.summary(),
                "needs_review": [asdict(c) for c in review],
                "all": [asdict(c) for c in result.changes],
                "fetch_errors": result.fetch_errors,
                "scan_rejections": result.scan_rejections,
            },
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )

    print(result.summary())
    for change in result.changes:
        print(f"  {change}")
    # Non-zero tells the workflow a human needs to look at new or changed code.
    return 3 if review else 0


# --- argument parsing ------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="utsi", description=__doc__.splitlines()[0])
    parser.add_argument("--version", action="version", version=f"utsi {__version__}")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the TSP index")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    serve.add_argument("--quiet-access-log", action="store_true")
    serve.set_defaults(func=cmd_serve)

    share = sub.add_parser("share", help="serve behind a tunnel and print the URL and key")
    share.add_argument("--port", type=int)
    share.add_argument("--no-tunnel", action="store_true", help="print the local URL instead")
    share.set_defaults(func=cmd_share)

    provision = sub.add_parser("provision", help="fetch nova3 + plugins into the runtime dir")
    provision.set_defaults(func=cmd_provision)

    search = sub.add_parser("search", help="run one search without the HTTP layer")
    search.add_argument("query", nargs="*")
    search.add_argument("--cat", default="")
    search.add_argument("--year", default="")
    search.add_argument("--res", default="")
    search.add_argument("--min-seeders", type=int, default=0)
    search.add_argument("--sort", default="", choices=["", "seeders", "size", "recent"])
    search.add_argument("--limit", type=int, default=20)
    search.add_argument("--offset", type=int, default=0)
    search.add_argument("--json", action="store_true")
    search.set_defaults(func=cmd_search)

    probe = sub.add_parser("probe", help="M0: measure how many plugins work from this host")
    probe.add_argument("--query", default="linux")
    probe.add_argument("--cat", default="all")
    probe.add_argument("--concurrency", type=int, default=4)
    probe.add_argument("--all-public", action="store_true", help="probe every public ✔ plugin")
    probe.add_argument("--out", default=".")
    probe.set_defaults(func=cmd_probe)

    update = sub.add_parser("registry-update", help="M4: rebuild registry.json and PLUGINS.md")
    update.add_argument("--registry", default="registry.json")
    update.add_argument("--plugins-md", default="PLUGINS.md")
    update.add_argument("--changes-out", default="registry-changes.json")
    update.add_argument("--plugin-ref", help="pin qbittorrent/search-plugins to this SHA")
    update.add_argument("--runtime-ref", help="pin qbittorrent/qBittorrent to this SHA")
    update.add_argument("--official-only", action="store_true")
    update.add_argument("--merge-health", metavar="PROBE_JSON", help="fold a probe report into health")
    update.add_argument("--dry-run", action="store_true")
    update.set_defaults(func=cmd_registry_update)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _configure_logging(args.verbose)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
