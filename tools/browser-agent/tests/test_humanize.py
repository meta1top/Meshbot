from browser_agent.humanize import (
    action_delay, typing_intervals, RateLimiter,
)


def test_action_delay_within_bounds():
    for _ in range(200):
        d = action_delay(lo=0.4, hi=1.5)
        assert 0.4 <= d <= 1.5


def test_action_delay_varies():
    vals = {round(action_delay(0.4, 1.5), 4) for _ in range(50)}
    assert len(vals) > 10  # 非常量、有抖动


def test_typing_intervals_length_and_bounds():
    iv = typing_intervals("hello")
    assert len(iv) == len("hello")
    assert all(0.02 <= x <= 0.5 for x in iv)


def test_rate_limiter_blocks_when_over_budget():
    rl = RateLimiter(max_per_window=2, window_s=10.0, _now=lambda: 100.0)
    assert rl.allow("x.com") is True
    assert rl.allow("x.com") is True
    assert rl.allow("x.com") is False  # 第三次超预算


def test_rate_limiter_separate_keys():
    rl = RateLimiter(max_per_window=1, window_s=10.0, _now=lambda: 100.0)
    assert rl.allow("x.com") is True
    assert rl.allow("xhs.com") is True  # 不同站独立预算


def test_rate_limiter_evicts_stale_hits():
    now = {"t": 100.0}
    rl = RateLimiter(max_per_window=1, window_s=10.0, _now=lambda: now["t"])
    assert rl.allow("x.com") is True
    assert rl.allow("x.com") is False  # 窗口内已满
    now["t"] = 111.0  # 过窗口（>10s），旧命中应被淘汰
    assert rl.allow("x.com") is True
    now["t"] = 120.0  # 边界：距上次正好 9s，仍在窗口内
    assert rl.allow("x.com") is False
