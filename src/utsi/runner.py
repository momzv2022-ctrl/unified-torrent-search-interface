"""Run one engine in one sandboxed subprocess and parse what it prints.

Third-party plugin code never enters this process. Each invocation gets its own
interpreter with capped address space, CPU and file size (applied inside the
shim), its own session so the whole process group can be killed on timeout, and
a scrubbed environment — the API key and any deploy credentials are not in it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import signal
import time
from dataclasses import dataclass

from .config import Settings
from .provision import SHIM_NAME

log = logging.getLogger(__name__)

#: A nova3 result line: link|name|size|seeds|leech|engine_url|desc_link|pub_date
FIELD_COUNT = 8

#: `-1` is nova3's "unknown" for any numeric field.
UNKNOWN = -1

#: Anything past this is a plugin emitting milliseconds, or garbage.
_MAX_PUB_DATE = 4102444800  # 2100-01-01Z


@dataclass(slots=True)
class EngineRow:
    """One parsed nova3 result line, still in nova3 terms."""

    link: str
    name: str
    size_bytes: int | None
    seeders: int | None
    leechers: int | None
    engine_url: str
    desc_link: str
    pub_date: int | None


@dataclass(slots=True)
class EngineResult:
    engine_id: str
    rows: list[EngineRow]
    ok: bool
    error: str = ""
    elapsed_ms: int = 0
    exit_code: int | None = None
    stderr: str = ""


def _int_or_none(raw: str) -> int | None:
    try:
        value = int(raw.strip())
    except (TypeError, ValueError):
        return None
    return None if value <= UNKNOWN else value


def _pub_date(raw: str) -> int | None:
    value = _int_or_none(raw)
    if value is None or value <= 0:
        return None
    if value > _MAX_PUB_DATE:
        # Some plugins print milliseconds. Recover rather than drop the field.
        value //= 1000
    return value if 0 < value <= _MAX_PUB_DATE else None


def parse_line(line: str) -> EngineRow | None:
    """Parse one `prettyPrinter` line, or ``None`` if it is not one.

    Split from the right, not the left. `prettyPrinter` strips `|` from the
    name but not from the URLs, so the seven trailing fields are always exactly
    where the right-hand split puts them, and any stray pipe is absorbed back
    into the link field it came from.
    """
    line = line.rstrip("\r\n")
    if line.count("|") < FIELD_COUNT - 1:
        return None

    link, name, size, seeds, leech, engine_url, desc_link, pub_date = line.rsplit("|", FIELD_COUNT - 1)
    link = link.strip()
    name = name.strip()
    if not link or not name or link == str(UNKNOWN):
        return None

    return EngineRow(
        link=link,
        name=name,
        size_bytes=_int_or_none(size),
        seeders=_int_or_none(seeds),
        leechers=_int_or_none(leech),
        engine_url=engine_url.strip(),
        desc_link=desc_link.strip(),
        pub_date=_pub_date(pub_date),
    )


def parse_output(stdout: str) -> list[EngineRow]:
    """Every well-formed row in *stdout*; plugin debug chatter is skipped."""
    return [row for line in stdout.splitlines() if (row := parse_line(line)) is not None]


def build_env(settings: Settings) -> dict[str, str]:
    """The subprocess environment — an allowlist, never `os.environ`.

    Nothing the gateway holds (`UTSI_API_KEY`, deploy tokens, cloud credentials)
    is reachable from plugin code.
    """
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(settings.runtime_dir),
        "TMPDIR": str(settings.runtime_dir),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONHASHSEED": "0",
        # Unescaped regex literals are endemic in the plugin ecosystem. The
        # warnings are upstream's to fix and would otherwise drown the log.
        "PYTHONWARNINGS": "ignore::SyntaxWarning",
        "UTSI_RLIMIT_AS_MB": str(settings.rlimit_as_mb),
        "UTSI_RLIMIT_CPU_S": str(settings.rlimit_cpu_s),
        "UTSI_RLIMIT_NOFILE": str(settings.rlimit_nofile),
        "UTSI_RLIMIT_FSIZE_MB": str(settings.rlimit_fsize_mb),
        # Give the plugin a chance to flush partial results before we kill it.
        "UTSI_SOCKET_TIMEOUT_S": f"{max(1.0, settings.engine_timeout_s * 0.6):.1f}",
    }
    if settings.socks_proxy:
        env["qbt_socks_proxy"] = settings.socks_proxy
    return env


async def _read_capped(stream: asyncio.StreamReader | None, limit: int) -> bytes:
    """Drain *stream* but stop storing past *limit* bytes.

    Both pipes must be drained or the child blocks on a full buffer, so the
    excess is read and discarded rather than left behind.
    """
    if stream is None:
        return b""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            break
        if total < limit:
            chunks.append(chunk[: limit - total])
        total += len(chunk)
    return b"".join(chunks)


class EngineRunner:
    """Spawns `_utsi_run.py` once per engine invocation."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._env = build_env(settings)

    async def _spawn(self, args: list[str], timeout: float) -> tuple[int | None, str, str, int]:
        started = time.monotonic()
        runtime = self.settings.runtime_dir
        process = await asyncio.create_subprocess_exec(
            self.settings.python_executable,
            str(runtime / SHIM_NAME),
            *args,
            cwd=str(runtime),
            env=self._env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                asyncio.gather(
                    _read_capped(process.stdout, self.settings.stdout_max_bytes),
                    _read_capped(process.stderr, self.settings.stderr_max_bytes),
                ),
                timeout,
            )
            code = await process.wait()
        except (TimeoutError, asyncio.CancelledError):
            await self._terminate(process)
            raise
        elapsed = int((time.monotonic() - started) * 1000)
        return code, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace"), elapsed

    @staticmethod
    async def _terminate(process: asyncio.subprocess.Process) -> None:
        """Kill the whole group and reap it — plugins leave children behind."""
        if process.returncode is not None:
            return
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                process.kill()
            except ProcessLookupError:
                return
        with contextlib.suppress(TimeoutError, ProcessLookupError):
            await asyncio.wait_for(asyncio.shield(process.wait()), 2.0)

    async def search(
        self, engine_id: str, category: str, query: str, timeout: float | None = None
    ) -> EngineResult:
        budget = timeout if timeout is not None else self.settings.engine_timeout_s
        if budget <= 0:
            return EngineResult(engine_id, [], ok=False, error="no time budget left")

        try:
            code, stdout, stderr, elapsed = await self._spawn(
                ["search", engine_id, category, query], budget
            )
        except TimeoutError:
            return EngineResult(
                engine_id, [], ok=False, error=f"timeout after {budget:.1f}s",
                elapsed_ms=int(budget * 1000),
            )
        except OSError as exc:
            return EngineResult(engine_id, [], ok=False, error=f"spawn failed: {exc!r}")

        rows = parse_output(stdout)
        # A non-zero exit with usable rows still counts: plugins often raise
        # after printing part of a page, and partial results beat none.
        ok = code == 0 or bool(rows)
        error = "" if ok else (stderr.strip().splitlines() or [f"exit {code}"])[-1][:300]
        return EngineResult(
            engine_id=engine_id,
            rows=rows,
            ok=ok,
            error=error,
            elapsed_ms=elapsed,
            exit_code=code,
            stderr=stderr[-2000:],
        )

    async def resolve_download(
        self, engine_id: str, param: str, timeout: float | None = None
    ) -> str | None:
        """Run the plugin's `download_torrent()` and return the magnet it prints.

        nova3 prints ``"<magnet-or-path> <original_param>"``, so the value is
        taken from before the last space.
        """
        budget = timeout if timeout is not None else self.settings.resolve_timeout_s
        if budget <= 0:
            return None
        try:
            code, stdout, _stderr, _elapsed = await self._spawn(
                ["download", engine_id, param], budget
            )
        except (TimeoutError, OSError):
            return None
        if code != 0:
            return None

        for line in reversed(stdout.splitlines()):
            candidate = line.strip()
            if not candidate:
                continue
            head = candidate.rsplit(" ", 1)[0].strip() if " " in candidate else candidate
            if head.lower().startswith("magnet:"):
                return head
        return None

    async def info(self, engine_id: str, timeout: float = 15.0) -> dict[str, object] | None:
        """Ask an engine for its declared name, url and categories."""
        try:
            code, stdout, _stderr, _elapsed = await self._spawn(["info", engine_id], timeout)
        except (TimeoutError, OSError):
            return None
        if code != 0:
            return None
        try:
            return json.loads(stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            return None
