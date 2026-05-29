from __future__ import annotations

import argparse
from datetime import date
from pathlib import Path
from typing import Callable

from scripts.models import Review
from scripts.store import ReviewStore
from scripts.targets import load_target

ScrapeFn = Callable[[dict, int, object], list[Review]]


def run(*, site: str, scrape_fn: ScrapeFn, hotel_key: str, max_reviews: int,
        targets_path: Path | str, out_root: Path | str, fetch: object) -> dict:
    target = load_target(targets_path, site, hotel_key)
    reviews = scrape_fn(target, max_reviews, fetch)
    out_root = Path(out_root)
    store = ReviewStore(out_root / "reviews.db")
    new = store.upsert(reviews)
    export = store.export_json(site, hotel_key, out_root / "exports", date_str=date.today().isoformat())
    return {"site": site, "hotel_key": hotel_key, "scraped": len(reviews),
            "new": new, "total": store.count(), "export": str(export)}


def default_out_root() -> Path:
    import os
    base = os.environ.get("MESHBOT_DIR") or str(Path.home() / ".meshbot")
    return Path(base) / "workspace" / "ota-reviews"


def main(site: str, scrape_fn: ScrapeFn, fetch_factory: Callable[[], object]) -> None:
    parser = argparse.ArgumentParser(description=f"{site} 评论抓取")
    parser.add_argument("--hotel", required=True, help="targets.json 里的酒店 key")
    parser.add_argument("--max-reviews", type=int, default=200)
    parser.add_argument("--targets", default=str(Path(__file__).resolve().parent.parent / "targets.json"))
    parser.add_argument("--out", default=None, help="落库根目录，默认 workspace/ota-reviews")
    args = parser.parse_args()
    out_root = Path(args.out) if args.out else default_out_root()
    summary = run(site=site, scrape_fn=scrape_fn, hotel_key=args.hotel, max_reviews=args.max_reviews,
                  targets_path=args.targets, out_root=out_root, fetch=fetch_factory())
    print(f"[{site}] hotel={summary['hotel_key']} scraped={summary['scraped']} "
          f"new={summary['new']} total={summary['total']}")
    print(f"[{site}] export -> {summary['export']}")
