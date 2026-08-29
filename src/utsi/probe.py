"""M0 — the feasibility probe.

Most public torrent sites sit behind Cloudflare, whose challenges exist to stop
automation from datacenter IPs. A plugin that works from a home connection
often returns a challenge page, a 403, or nothing at all from a cloud host.
**How many still work is the number that decides whether a free-hosted public
instance is worth deploying**, and it can only be measured from the host you
intend to deploy on.

    utsi probe --all-public --query linux

Run it on the target host, read the table, then decide. If only a handful of
engines answer, the honest framing is "self-host it and get a TSP endpoint",
not "click deploy and get a free public API".
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from .config import Settings
from .normalize import detect_link_kind
from .provision import Provisioner
from .registry import Registry
from .runner import EngineRunner


@dataclass(slots=True)
class ProbeRow:
    engine: str
    ok: bool
    rows: int
    elapsed_ms: int
    link_kind: str = ""
    magnets: int = 0
    error: str = ""


@dataclass(slots=True)
class ProbeReport:
    query: str
    category: str
    started_at: str
    rows: list[ProbeRow]

    @property
    def usable(self) -> list[ProbeRow]:
        return [row for row in self.rows if row.ok and row.rows > 0]

    def to_json(self) -> str:
        return json.dumps(
            {
                "query": self.query,
                "category": self.category,
                "started_at": self.started_at,
                "usable": len(self.usable),
                "total": len(self.rows),
                "engines": [asdict(row) for row in self.rows],
            },
            indent=2,
        ) + "\n"

    def to_markdown(self) -> str:
        usable = len(self.usable)
        total = len(self.rows)
        share = f"{100 * usable / total:.0f}%" if total else "n/a"
        lines = [
            "# Plugin feasibility probe",
            "",
            f"- query: `{self.query}` (category `{self.category}`)",
            f"- run at: {self.started_at}",
            f"- **usable engines: {usable} / {total} ({share})**",
            "",
            "An engine is *usable* when it exits cleanly and returns at least one",
            "well-formed result line. Run this on the host you intend to deploy on:",
            "the number is a property of the IP address, not of the plugins.",
            "",
            "| Engine | Rows | ms | Link kind | Magnets | Error |",
            "|---|---:|---:|---|---:|---|",
        ]
        for row in sorted(self.rows, key=lambda r: (-r.rows, r.engine)):
            error = row.error.replace("|", "/")[:70]
            lines.append(
                f"| `{row.engine}` | {row.rows} | {row.elapsed_ms} | {row.link_kind or '—'} "
                f"| {row.magnets} | {error} |"
            )
        return "\n".join(lines) + "\n"


async def run_probe(
    settings: Settings,
    registry: Registry,
    *,
    query: str = "linux",
    category: str = "all",
    concurrency: int = 4,
) -> ProbeReport:
    """Provision every selectable plugin, then hit each with one query."""
    provisioner = Provisioner(settings, registry)
    report = await provisioner.provision()
    runner = EngineRunner(settings)
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    if report.core_error:
        failure = ProbeRow("nova3-core", ok=False, rows=0, elapsed_ms=0, error=report.core_error)
        return ProbeReport(query, category, started_at, [failure])

    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def probe_one(engine_id: str) -> ProbeRow:
        async with semaphore:
            result = await runner.search(engine_id, category, query)
        kinds = {detect_link_kind(row.link) for row in result.rows}
        magnets = sum(1 for row in result.rows if detect_link_kind(row.link) == "magnet")
        return ProbeRow(
            engine=engine_id,
            ok=result.ok,
            rows=len(result.rows),
            elapsed_ms=result.elapsed_ms,
            link_kind=",".join(sorted(kinds)),
            magnets=magnets,
            error=result.error[:200],
        )

    rows = [
        ProbeRow(slot.plugin.id, ok=False, rows=0, elapsed_ms=0, error=slot.error)
        for slot in report.slots.values()
        if not slot.ok
    ]
    rows.extend(await asyncio.gather(*(probe_one(plugin.id) for plugin in report.available())))
    return ProbeReport(query, category, started_at, rows)


def write_report(report: ProbeReport, directory: Path) -> tuple[Path, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    markdown = directory / "probe-report.md"
    payload = directory / "probe-report.json"
    markdown.write_text(report.to_markdown(), encoding="utf-8")
    payload.write_text(report.to_json(), encoding="utf-8")
    return markdown, payload
