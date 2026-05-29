from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, Field


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Review(BaseModel):
    site: str
    hotel_key: str
    review_id: str
    text: str
    hotel_name: str | None = None
    author: str | None = None
    rating: float | None = None
    title: str | None = None
    date: str | None = None
    language: str | None = None
    trip_type: str | None = None
    raw: dict | None = None
    scraped_at: datetime = Field(default_factory=_now)

    def dedup_key(self) -> tuple[str, str]:
        return (self.site, self.review_id)
