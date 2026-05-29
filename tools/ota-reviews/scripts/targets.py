from __future__ import annotations

import json
from pathlib import Path


class TargetNotFound(Exception):
    pass


def load_target(targets_path: Path | str, site: str, hotel_key: str) -> dict:
    data = json.loads(Path(targets_path).read_text(encoding="utf-8"))
    hotel = data.get(hotel_key)
    if hotel is None:
        raise TargetNotFound(f"未找到酒店 {hotel_key!r}")
    url = (hotel.get("platforms") or {}).get(site, "")
    if not url:
        raise TargetNotFound(f"酒店 {hotel_key!r} 在平台 {site!r} 没有配置 URL")
    return {"url": url, "hotel_name": hotel.get("hotel_name") or None, "hotel_key": hotel_key}
