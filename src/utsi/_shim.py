"""Per-engine entry point, copied into the runtime directory as `_utsi_run.py`.

This is the one file that shares a process with third-party plugin code, so it
is deliberately tiny, stdlib-only, and owns no plugin logic.

It replaces `nova2.py`'s CLI for production traffic. `nova2.py` merges every
engine's stdout into one stream through a `multiprocessing` pool, which means a
single hanging site stalls the whole response and failures cannot be attributed
to an engine. One engine per process fixes both, and skips the pool spawn cost.

`nova2.py` is still provisioned alongside this file: plugins are allowed to
import it, and the wider nova3 environment is what their authors test against.

Usage:
    _utsi_run.py search   <engine> <category> <query...>
    _utsi_run.py download <engine> <download_param>
    _utsi_run.py info     <engine>
"""

from __future__ import annotations

import importlib
import json
import os
import pathlib
import socket
import sys
import traceback
import urllib.parse

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_IMPORT = 3
EXIT_UNSUPPORTED_CATEGORY = 4
EXIT_SEARCH_FAILED = 5
EXIT_NO_DOWNLOAD = 6

_HERE = str(pathlib.Path(__file__).parent.resolve())
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _apply_limits() -> None:
    """Cap address space, CPU and file writes before any plugin code loads."""
    try:
        import resource
    except ImportError:  # pragma: no cover - non-POSIX
        return

    caps = (
        (resource.RLIMIT_AS, _env_int("UTSI_RLIMIT_AS_MB", 512) * 1024 * 1024),
        (resource.RLIMIT_CPU, _env_int("UTSI_RLIMIT_CPU_S", 20)),
        (resource.RLIMIT_NOFILE, _env_int("UTSI_RLIMIT_NOFILE", 256)),
        (resource.RLIMIT_FSIZE, _env_int("UTSI_RLIMIT_FSIZE_MB", 32) * 1024 * 1024),
        (resource.RLIMIT_CORE, 0),
    )
    for what, limit in caps:
        if limit <= 0:
            continue
        try:
            hard = resource.getrlimit(what)[1]
            ceiling = limit if hard == resource.RLIM_INFINITY else min(limit, hard)
            resource.setrlimit(what, (ceiling, hard))
        except (ValueError, OSError):
            pass


def _engine_class(module, engine_name: str):
    """Find the engine class in *module*.

    nova3 requires the class name to equal the module name and gives up
    otherwise. Real plugins break that rule — `rutracker.py` defines
    `class RuTracker` — so fall back to a case-insensitive match and then to
    the module's sole class implementing `search()`. This only widens what can
    be imported; the sandbox around it is unchanged.
    """
    candidate = getattr(module, engine_name, None)
    if isinstance(candidate, type):
        return candidate

    defined = [
        value
        for value in vars(module).values()
        if isinstance(value, type) and getattr(value, "__module__", "") == module.__name__
    ]
    lowered = engine_name.lower()
    for cls in defined:
        if cls.__name__.lower() == lowered:
            return cls

    searchable = [cls for cls in defined if callable(getattr(cls, "search", None))]
    if len(searchable) == 1:
        return searchable[0]
    raise ImportError(f"no engine class for {engine_name!r} in {module.__name__}")


def _load(engine_name: str):
    """Import `engines.<name>` and return an instance, nova3 style."""
    module = importlib.import_module("engines." + engine_name)
    return _engine_class(module, engine_name)()


def _main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return EXIT_USAGE

    mode, engine_name = argv[1], argv[2].strip()

    timeout = float(os.environ.get("UTSI_SOCKET_TIMEOUT_S", "") or 0)
    if timeout > 0:
        # Without this a stalled site burns the whole engine budget and we lose
        # the rows the plugin had already produced.
        socket.setdefaulttimeout(timeout)

    _apply_limits()

    # Plugins occasionally read sys.argv; hand them nothing interesting.
    sys.argv = [argv[0]]

    try:
        import helpers

        helpers.enable_socks_proxy(True)
    except Exception:  # pragma: no cover - helpers is always provisioned
        traceback.print_exc()

    try:
        engine = _load(engine_name)
    except Exception:
        traceback.print_exc()
        return EXIT_IMPORT

    if mode == "info":
        json.dump(
            {
                "id": engine_name,
                "name": getattr(engine, "name", engine_name),
                "url": getattr(engine, "url", ""),
                "supported_categories": sorted(getattr(engine, "supported_categories", {"all": ""})),
                "has_download_torrent": hasattr(engine, "download_torrent"),
            },
            sys.stdout,
        )
        sys.stdout.write("\n")
        return EXIT_OK

    if mode == "download":
        if len(argv) < 4:
            return EXIT_USAGE
        param = argv[3]
        try:
            if hasattr(engine, "download_torrent"):
                engine.download_torrent(param)
            else:
                import helpers as _helpers

                print(_helpers.download_file(param))
        except SystemExit:
            raise
        except Exception:
            traceback.print_exc()
            return EXIT_NO_DOWNLOAD
        return EXIT_OK

    if mode != "search" or len(argv) < 5:
        print(__doc__, file=sys.stderr)
        return EXIT_USAGE

    category = argv[3].strip().lower()
    supported = getattr(engine, "supported_categories", None)
    if supported is not None and category not in supported:
        # nova2.py drops the engine silently here; be explicit instead.
        print(f"engine does not declare category {category!r}", file=sys.stderr)
        return EXIT_UNSUPPORTED_CATEGORY

    # Match nova2.py exactly: keywords are space-joined then percent-quoted, and
    # plugins are documented to receive a space-free string.
    what = urllib.parse.quote(" ".join(argv[4:]))
    try:
        if supported is None:
            engine.search(what)
        else:
            engine.search(what, category)
    except SystemExit:
        return EXIT_OK
    except Exception:
        traceback.print_exc()
        return EXIT_SEARCH_FAILED
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
