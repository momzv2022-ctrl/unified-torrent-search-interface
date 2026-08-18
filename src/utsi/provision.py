"""Assemble the runtime directory: nova3 core + plugins, fetched, never vendored.

Layout produced (default `/tmp/utsi-runtime`, a tmpfs):

    nova2.py nova2dl.py helpers.py novaprinter.py socks.py   upstream qBittorrent
    _utsi_run.py                                              ours, from `_shim.py`
    engines/<id>.py                                           upstream plugin authors

Nothing here is committed. A redeploy re-fetches against the day's
`registry.json`, so the image stays free of third-party code and picks up
registry changes automatically.
"""

from __future__ import annotations

import asyncio
import compileall
import contextlib
import hashlib
import logging
import shutil
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .config import Settings
from .registry import Plugin, Registry
from .scanner import scan

log = logging.getLogger(__name__)

#: The nova3 files a plugin may import. `nova2.py` is included because plugins
#: are allowed to `from nova2 import Engine`, and `nova2dl.py` because keeping
#: the directory a faithful nova3 environment is what authors test against.
CORE_FILES = ("nova2.py", "nova2dl.py", "helpers.py", "novaprinter.py", "socks.py")

SHIM_NAME = "_utsi_run.py"


@dataclass(slots=True)
class EngineSlot:
    """One plugin's provisioning outcome."""

    plugin: Plugin
    ok: bool = False
    error: str = ""
    sha256: str = ""
    hosts: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ProvisionReport:
    runtime_dir: Path
    slots: dict[str, EngineSlot] = field(default_factory=dict)
    core_error: str = ""

    @property
    def ready(self) -> bool:
        return not self.core_error and any(slot.ok for slot in self.slots.values())

    def available(self) -> list[Plugin]:
        return [slot.plugin for slot in self.slots.values() if slot.ok]

    def describe(self) -> str:
        ok = sum(1 for slot in self.slots.values() if slot.ok)
        return f"{ok}/{len(self.slots)} engines provisioned in {self.runtime_dir}"


#: The runner points `HOME` at the runtime dir so plugins cannot touch the real
#: one. Plugins that cache to a platform data directory then expect its parent
#: to exist — `academictorrents` opens `~/Library/Application Support/…`
#: outright and dies with FileNotFoundError if it does not.
HOME_SUBDIRS = (
    "Library/Application Support",  # macOS
    ".local/share",  # XDG
    ".config",
    ".cache",
)


def _make_home_dirs(runtime: Path) -> None:
    for relative in HOME_SUBDIRS:
        (runtime / relative).mkdir(parents=True, exist_ok=True)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Provisioner:
    """Fetches and verifies everything the subprocess runner needs."""

    def __init__(self, settings: Settings, registry: Registry) -> None:
        self.settings = settings
        self.registry = registry
        self.report = ProvisionReport(runtime_dir=settings.runtime_dir)
        self._done = asyncio.Event()

    # --- lifecycle ---------------------------------------------------------

    async def wait_ready(self, timeout: float | None = None) -> ProvisionReport:
        """Block until the first provisioning pass finishes."""
        if timeout is None:
            await self._done.wait()
        else:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._done.wait(), timeout)
        return self.report

    async def provision(self) -> ProvisionReport:
        try:
            await self._provision()
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("provisioning failed")
            self.report.core_error = repr(exc)
        finally:
            self._done.set()
        return self.report

    # --- internals ---------------------------------------------------------

    async def _provision(self) -> None:
        runtime = self.settings.runtime_dir
        engines_dir = runtime / "engines"
        engines_dir.mkdir(parents=True, exist_ok=True)
        (engines_dir / "__init__.py").write_text("", encoding="utf-8")
        _make_home_dirs(runtime)

        shutil.copyfile(Path(__file__).with_name("_shim.py"), runtime / SHIM_NAME)

        candidates = self.registry.selectable(
            include_private=self.settings.include_private,
            only=self.settings.engines,
        )
        if self.settings.max_plugins:
            # Best first, so a cap keeps the engines most likely to answer. With
            # no measured health they all score alike and this is arbitrary but
            # stable — run `utsi probe` and merge it to make the choice mean
            # something.
            candidates = sorted(candidates, key=lambda p: (-p.base_score(), p.id))
            candidates = sorted(candidates[: self.settings.max_plugins], key=lambda p: p.id)
            log.info("provisioning the top %d plugins by health score", len(candidates))
        self.report.slots = {plugin.id: EngineSlot(plugin=plugin) for plugin in candidates}

        if self.settings.offline:
            self._provision_offline(engines_dir)
        else:
            async with httpx.AsyncClient(
                timeout=self.settings.fetch_timeout_s,
                follow_redirects=True,
                headers={"User-Agent": "utsi-provisioner"},
            ) as client:
                await self._fetch_core(client, runtime)
                if self.report.core_error:
                    return
                semaphore = asyncio.Semaphore(self.settings.fetch_concurrency)
                await asyncio.gather(*(
                    self._fetch_plugin(client, semaphore, slot, engines_dir)
                    for slot in self.report.slots.values()
                ))

        # Byte-compiling once here keeps every later subprocess start cheap.
        # Plenty of plugins have unescaped regex literals; those SyntaxWarnings
        # are upstream's to fix and would otherwise repeat on every boot.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", SyntaxWarning)
            compileall.compile_dir(str(runtime), quiet=2, force=False)
        log.info("%s", self.report.describe())

    def _provision_offline(self, engines_dir: Path) -> None:
        """Trust what is already on disk. Used by tests and air-gapped hosts."""
        missing = [name for name in CORE_FILES if not (self.settings.runtime_dir / name).is_file()]
        if missing:
            self.report.core_error = f"offline mode: missing nova3 core files {missing}"
            return
        for slot in self.report.slots.values():
            path = engines_dir / f"{slot.plugin.id}.py"
            if path.is_file():
                slot.ok = True
            else:
                slot.error = "offline mode: not present in runtime dir"

    async def _fetch_core(self, client: httpx.AsyncClient, runtime: Path) -> None:
        runtime_spec = self.registry.runtime
        if not runtime_spec.base_url:
            self.report.core_error = "registry has no runtime.base_url"
            return

        async def one(name: str) -> str:
            response = await client.get(runtime_spec.url_for(name))
            response.raise_for_status()
            data = response.content
            expected = runtime_spec.files.get(name)
            digest = _sha256(data)
            if expected and digest != expected:
                raise ValueError(f"{name}: sha256 {digest} != pinned {expected}")
            (runtime / name).write_bytes(data)
            return name

        try:
            await asyncio.gather(*(one(name) for name in CORE_FILES))
        except (httpx.HTTPError, ValueError, OSError) as exc:
            self.report.core_error = f"nova3 core: {exc!r}"
            log.error("could not provision nova3 core: %r", exc)

    async def _fetch_plugin(
        self,
        client: httpx.AsyncClient,
        semaphore: asyncio.Semaphore,
        slot: EngineSlot,
        engines_dir: Path,
    ) -> None:
        plugin = slot.plugin
        async with semaphore:
            try:
                response = await client.get(plugin.url)
                response.raise_for_status()
                data = response.content
            except httpx.HTTPError as exc:
                slot.error = f"fetch failed: {exc!r}"
                log.warning("plugin %s: %s", plugin.id, slot.error)
                return

        slot.sha256 = _sha256(data)
        if plugin.pinned_sha256 and slot.sha256 != plugin.pinned_sha256:
            slot.error = f"sha256 mismatch: {slot.sha256} != pinned {plugin.pinned_sha256}"
            log.error("plugin %s rejected: %s", plugin.id, slot.error)
            return
        if not plugin.pinned_sha256:
            log.warning("plugin %s has no pinned_sha256 (got %s)", plugin.id, slot.sha256)

        try:
            source = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            slot.error = f"not utf-8: {exc!r}"
            return

        result = scan(
            source,
            plugin.id,
            declared_url=plugin.site_url,
            # Hosts recorded when the registry was last built are already
            # reviewed; a new one is what matters.
            allowed_hosts=tuple(plugin.hosts),
            strict_hosts=self.settings.strict_hosts,
        )
        slot.hosts = result.hosts
        if not result.ok:
            slot.error = f"static scan: {result.summary()}"
            log.error("plugin %s rejected: %s", plugin.id, slot.error)
            return

        try:
            (engines_dir / f"{plugin.id}.py").write_text(source, encoding="utf-8")
        except OSError as exc:
            slot.error = f"write failed: {exc!r}"
            return
        slot.ok = True
