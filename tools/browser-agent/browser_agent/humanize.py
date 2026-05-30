"""人类节奏：动作延迟、打字间隔、限速。纯函数 / 可注入时钟，便于单测。"""
from __future__ import annotations

import math
import random
import time
from collections import deque
from typing import Callable, Deque, Dict


def action_delay(lo: float = 0.4, hi: float = 1.5) -> float:
    """两次动作间的随机延迟（秒），偏向区间中段的对数正态抖动。"""
    mu = (math.log(lo) + math.log(hi)) / 2
    sigma = (math.log(hi) - math.log(lo)) / 4
    val = math.exp(random.gauss(mu, sigma))
    return max(lo, min(hi, val))


def typing_intervals(text: str, base: float = 0.08) -> list[float]:
    """逐字输入的间隔列表，模拟人类打字节奏（含偶发停顿）。"""
    out: list[float] = []
    for ch in text:
        jitter = random.uniform(0.6, 1.6)
        pause = 0.25 if ch == " " and random.random() < 0.2 else 0.0
        out.append(min(0.5, max(0.02, base * jitter + pause)))
    return out


class RateLimiter:
    """滑动窗口限速：每个 key（站点）独立预算。"""

    def __init__(self, max_per_window: int, window_s: float,
                 _now: Callable[[], float] | None = None) -> None:
        self._max = max_per_window
        self._window = window_s
        self._now = _now or time.monotonic
        # 按 key（站点）存命中时间戳；本场景 key 是少量固定站点，集合有界，不做过期清理。
        self._hits: Dict[str, Deque[float]] = {}

    def allow(self, key: str) -> bool:
        now = self._now()
        dq = self._hits.setdefault(key, deque())
        while dq and now - dq[0] > self._window:
            dq.popleft()
        if len(dq) >= self._max:
            return False
        dq.append(now)
        return True
