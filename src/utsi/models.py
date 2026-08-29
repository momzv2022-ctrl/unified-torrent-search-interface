"""Wire models for the Torrent Stream Protocol response.

Mirrors the Torrent Stream Protocol `openapi.yaml` (vendored at
`spec/tsp-openapi.yaml`). Fields the gateway cannot know are omitted rather
than sent as null — TSP reads absent numerics as 0 and absent strings as "" —
which keeps the payload small on a free tier.

`sources` and `description_url` are extensions. TSP ignores unknown fields, and
`sources` in particular makes a merged row debuggable.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class Torrent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    magnet: str = Field(description="What a client opens. Required by TSP on every row.")
    infohash: str | None = Field(default=None, description="40 lowercase hex characters.")
    name: str | None = None
    size_bytes: int | None = None
    files: int | None = None
    category: str | None = None
    seeders: int | None = None
    leechers: int | None = None
    year: str | None = None
    resolution: str | None = None
    codec: str | None = None
    source: str | None = None
    season: str | None = None
    episode: str | None = None
    first_seen: str | None = None
    scraped_at: str | None = None
    torrent_url: str | None = None

    # --- extensions -------------------------------------------------------
    description_url: str | None = Field(default=None, description="Non-TSP: the plugin's details page.")
    sources: list[str] | None = Field(default=None, description="Non-TSP: engines this row was merged from.")


class SearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str
    count: int
    limit: int
    offset: int
    took_ms: int
    torrents: list[Torrent]

    # --- extensions -------------------------------------------------------
    engines: list[str] | None = Field(default=None, description="Non-TSP: engines that answered in time.")
    partial: bool | None = Field(
        default=None,
        description="Non-TSP: true when the global deadline cut the fan-out short.",
    )


class EngineStatus(BaseModel):
    """Row of `GET /api/v1/engines` — operational visibility, not part of TSP."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    url: str
    source: str
    link_kind: str
    categories: list[str]
    provisioned: bool
    breaker_open: bool
    consecutive_failures: int
    last_error: str | None = None
    median_ms: int | None = None
    score: float


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: str
    detail: str | None = None
