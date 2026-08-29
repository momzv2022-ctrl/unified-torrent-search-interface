"""`utsi share` — one command, out comes a URL and a key.

The full recipe is a server, a tunnel, a generated key and four terminal
windows' worth of copy-paste. What anyone actually wants from it is two strings
and a way to stop. This runs the server and the tunnel together, waits until
the public URL genuinely answers, prints the two strings, and tears both down
on Ctrl-C.

The tunnel is a Cloudflare quick tunnel: no account, no card, and the URL dies
with the process — which is the property that makes "stop whenever you like"
true rather than aspirational.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import shutil
import sys

import httpx
import uvicorn

from .config import Settings

CLOUDFLARED = "cloudflared"
_QUICK_URL = re.compile(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com")

#: Cloudflare usually prints the URL within a couple of seconds; a slow mobile
#: connection can take longer, and waiting beats reporting a failure that isn't.
URL_TIMEOUT_S = 45.0

INSTALL_HINT = {
    "darwin": "brew install cloudflared",
    "linux": "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
}


def install_hint() -> str:
    return INSTALL_HINT.get(sys.platform, INSTALL_HINT["linux"])


def find_url(text: str) -> str:
    match = _QUICK_URL.search(text)
    return match.group(0) if match else ""


def summary(url: str, key: str, *, reachable: bool) -> str:
    """The whole point of the command, in the shape someone can act on."""
    lines = [
        "",
        "  ┌─────────────────────────────────────────────────────────────",
        f"  │  URL  {url}",
        f"  │  Key  {key or '(none, running unauthenticated)'}",
        "  └─────────────────────────────────────────────────────────────",
        "",
    ]
    if not reachable:
        lines.append(
            "  The URL did not answer yet. A new tunnel hostname can take a"
            " little longer to resolve. The server itself is up, so try again"
            " shortly."
        )
    lines.append("  Ctrl-C to stop. The URL stops working the moment you do.")
    lines.append("")
    return "\n".join(lines)


class QuickTunnel:
    """A Cloudflare quick tunnel, for as long as this process lives."""

    def __init__(self, port: int) -> None:
        self.port = port
        self.url = ""
        self._process: asyncio.subprocess.Process | None = None
        self._drain: asyncio.Task[None] | None = None

    async def start(self) -> str:
        self._process = await asyncio.create_subprocess_exec(
            CLOUDFLARED, "tunnel", "--url", f"http://127.0.0.1:{self.port}",
            "--no-autoupdate",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL,
        )
        try:
            self.url = await asyncio.wait_for(self._read_url(), URL_TIMEOUT_S)
        except TimeoutError:
            raise RuntimeError("cloudflared did not report a URL in time") from None
        # Keep reading, or cloudflared eventually blocks on a full pipe.
        self._drain = asyncio.create_task(self._discard())
        return self.url

    async def _read_url(self) -> str:
        assert self._process is not None and self._process.stdout is not None
        transcript: list[str] = []
        while True:
            raw = await self._process.stdout.readline()
            if not raw:
                tail = "".join(transcript[-5:]).strip()
                raise RuntimeError(f"cloudflared exited before reporting a URL\n{tail}")
            line = raw.decode("utf-8", "replace")
            transcript.append(line)
            url = find_url(line)
            if url:
                return url

    async def _discard(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        with contextlib.suppress(asyncio.CancelledError):
            while await self._process.stdout.readline():
                pass

    async def stop(self) -> None:
        if self._process is None:
            return
        if self._process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self._process.terminate()
            try:
                await asyncio.wait_for(asyncio.shield(self._process.wait()), 3.0)
            except TimeoutError:
                # Ctrl-C should not mean "wait around for a tunnel to feel like
                # exiting". Anything still up after SIGTERM gets SIGKILL.
                with contextlib.suppress(ProcessLookupError):
                    self._process.kill()
        # The pipe has to reach EOF either way. Left open, its transport is
        # closed by the garbage collector after the loop has gone, which asyncio
        # reports loudly and unhelpfully, long after the fact.
        if self._drain is not None:
            with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(self._drain, 5.0)
        elif self._process.stdout is not None:
            # start() raised before the drain task existed — a timeout waiting
            # for the URL, or the process dying — so nothing else will read it.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._process.stdout.read(), 5.0)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._process.wait(), 5.0)


#: Binds that mean "every interface", and so are reachable on loopback.
_WILDCARD = {"", "0.0.0.0", "::", "*"}


def probe_host(host: str) -> str:
    """Where to poll for readiness, given what the server bound to.

    A wildcard bind answers on loopback, but a bind to one specific address —
    a Tailscale or LAN address, say — answers only there. Polling 127.0.0.1
    regardless would report "the server did not come up" about a server that
    came up fine.
    """
    return "127.0.0.1" if host in _WILDCARD else host


def origin(host: str, port: int) -> str:
    """`http://host:port`, with an IPv6 literal bracketed as a URL needs."""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{port}"


async def _wait_until_serving(host: str, port: int, timeout: float = 60.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    target = f"{origin(probe_host(host), port)}/healthz"
    async with httpx.AsyncClient(timeout=5.0) as client:
        while asyncio.get_running_loop().time() < deadline:
            try:
                if (await client.get(target)).status_code == 200:
                    return True
            except httpx.HTTPError:
                pass
            await asyncio.sleep(1.0)
    return False


#: A quick tunnel's hostname is minted seconds before it is usable, and the
#: first thing to fail is DNS. Six seconds of patience was not enough: a
#: resolver that gets NXDOMAIN caches it, so giving up early does not merely
#: report the problem, it prolongs it for whoever curls the URL next.
REACH_ATTEMPTS = 10
REACH_INTERVAL_S = 3.0


async def _reaches(url: str) -> bool:
    """Confirm the tunnel actually carries traffic before saying it is ready."""
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        for attempt in range(REACH_ATTEMPTS):
            with contextlib.suppress(httpx.HTTPError):
                if (await client.get(f"{url}/healthz")).status_code == 200:
                    return True
            if attempt < REACH_ATTEMPTS - 1:
                await asyncio.sleep(REACH_INTERVAL_S)
    return False


async def share(settings: Settings, *, tunnel: bool = True) -> int:
    from .app import create_app

    if tunnel and shutil.which(CLOUDFLARED) is None:
        print(
            f"{CLOUDFLARED} is not installed. Install it with:\n  {install_hint()}\n"
            "or pass --no-tunnel to serve on this machine only.",
            file=sys.stderr,
        )
        return 1

    # Bound to loopback: the tunnel reaches it there, and nothing on the local
    # network can. Without a tunnel the operator chose the host themselves.
    host = "127.0.0.1" if tunnel else settings.host
    server = uvicorn.Server(uvicorn.Config(
        create_app(settings), host=host, port=settings.port, log_level="warning",
    ))
    serving = asyncio.create_task(server.serve())

    quick: QuickTunnel | None = None
    try:
        if not await _wait_until_serving(host, settings.port):
            print("the server did not come up", file=sys.stderr)
            return 1

        url = origin(host, settings.port)
        reachable = True
        if tunnel:
            quick = QuickTunnel(settings.port)
            try:
                url = await quick.start()
            except RuntimeError as exc:
                print(f"tunnel failed: {exc}", file=sys.stderr)
                return 1
            reachable = await _reaches(url)

        print(summary(url, settings.api_key, reachable=reachable), flush=True)
        await serving
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        server.should_exit = True
        if quick is not None:
            await quick.stop()
        with contextlib.suppress(TimeoutError, asyncio.CancelledError):
            await asyncio.wait_for(serving, 10.0)
    return 0
