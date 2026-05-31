"""行为节奏：动作延迟、打字间隔、鼠标轨迹、限速。纯函数 / 可注入时钟。"""
from __future__ import annotations
import asyncio, math, random, time
from collections import deque
from typing import Callable

def action_delay(lo: float = 0.4, hi: float = 1.5) -> float:
    mu = (math.log(lo) + math.log(hi)) / 2
    sigma = (math.log(hi) - math.log(lo)) / 4
    return max(lo, min(hi, math.exp(random.gauss(mu, sigma))))

def typing_intervals(text: str, base: float = 0.08) -> list[float]:
    out = []
    for ch in text:
        jitter = random.uniform(0.6, 1.6)
        pause = 0.25 if ch == " " and random.random() < 0.2 else 0.0
        out.append(min(0.5, max(0.02, base * jitter + pause)))
    return out

class RateLimiter:
    def __init__(self, max_per_window: int, window_s: float, now: Callable[[], float] | None = None):
        self._max, self._window, self._now = max_per_window, window_s, now or time.monotonic
        self._hits: dict[str, deque] = {}

    def allow(self, key: str) -> bool:
        t = self._now()
        dq = self._hits.setdefault(key, deque())
        while dq and t - dq[0] > self._window:
            dq.popleft()
        if len(dq) >= self._max:
            return False
        dq.append(t)
        return True

async def sleep(s: float) -> None:
    await asyncio.sleep(s)
