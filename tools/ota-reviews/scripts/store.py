from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from scripts.models import Review

_SCHEMA = """
CREATE TABLE IF NOT EXISTS reviews (
    site TEXT NOT NULL, review_id TEXT NOT NULL, hotel_key TEXT NOT NULL,
    hotel_name TEXT, author TEXT, rating REAL, title TEXT, text TEXT NOT NULL,
    date TEXT, language TEXT, trip_type TEXT, raw TEXT, scraped_at TEXT NOT NULL,
    PRIMARY KEY (site, review_id)
);
"""


class ReviewStore:
    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)

    def upsert(self, reviews: list[Review]) -> int:
        new_count = 0
        cur = self._conn.cursor()
        for r in reviews:
            existing = cur.execute(
                "SELECT 1 FROM reviews WHERE site=? AND review_id=?", (r.site, r.review_id)
            ).fetchone()
            if existing is None:
                new_count += 1
            cur.execute(
                """INSERT INTO reviews
                   (site, review_id, hotel_key, hotel_name, author, rating, title,
                    text, date, language, trip_type, raw, scraped_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(site, review_id) DO UPDATE SET
                     hotel_key=excluded.hotel_key, hotel_name=excluded.hotel_name,
                     author=excluded.author, rating=excluded.rating, title=excluded.title,
                     text=excluded.text, date=excluded.date, language=excluded.language,
                     trip_type=excluded.trip_type, raw=excluded.raw, scraped_at=excluded.scraped_at""",
                (r.site, r.review_id, r.hotel_key, r.hotel_name, r.author, r.rating,
                 r.title, r.text, r.date, r.language, r.trip_type,
                 json.dumps(r.raw, ensure_ascii=False) if r.raw is not None else None,
                 r.scraped_at.isoformat()),
            )
        self._conn.commit()
        return new_count

    def count(self) -> int:
        return self._conn.execute("SELECT COUNT(*) FROM reviews").fetchone()[0]

    def all(self) -> list[dict]:
        return [dict(row) for row in self._conn.execute("SELECT * FROM reviews").fetchall()]

    def by(self, site: str, hotel_key: str) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM reviews WHERE site=? AND hotel_key=? ORDER BY date DESC",
            (site, hotel_key),
        ).fetchall()
        return [dict(row) for row in rows]

    def export_json(self, site: str, hotel_key: str, out_dir: Path | str, date_str: str) -> Path:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        rows = self.by(site, hotel_key)
        out = out_dir / f"{site}-{hotel_key}-{date_str}.json"
        out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        return out
