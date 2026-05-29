from __future__ import annotations

import random
import time
from typing import Callable

from scrapling.fetchers import StealthyFetcher


def make_fetch(*, proxy: str | None = None, delay_range: tuple[float, float] = (2.0, 5.0),
               wait_for: str | None = None) -> Callable[..., object]:
    def fetch(url: str, *, wait_for_override: str | None = None) -> object:
        lo, hi = delay_range
        if hi > 0:
            time.sleep(random.uniform(lo, hi))
        kw: dict = {"headless": True, "network_idle": True}
        sel = wait_for_override or wait_for
        if sel:
            kw["wait_selector"] = sel
        if proxy:
            kw["proxy"] = proxy
        return StealthyFetcher.fetch(url, **kw)

    return fetch
