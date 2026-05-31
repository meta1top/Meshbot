from browser_mcp.humanize import action_delay, typing_intervals, mouse_path, RateLimiter

def test_action_delay_bounds_and_varies():
    vals = {round(action_delay(0.4, 1.5), 4) for _ in range(200)}
    assert all(0.4 <= v <= 1.5 for v in vals) and len(vals) > 20

def test_typing_intervals():
    iv = typing_intervals("hello")
    assert len(iv) == 5 and all(0.02 <= x <= 0.5 for x in iv)

def test_mouse_path_endpoints():
    p = mouse_path((0, 0), (100, 50), 6)
    assert p[0] == (0, 0) and p[-1] == (100, 50) and len(p) == 7

def test_rate_limiter():
    now = [100.0]
    rl = RateLimiter(1, 10, lambda: now[0])
    assert rl.allow("x") and not rl.allow("x") and rl.allow("y")
    now[0] = 111.0
    assert rl.allow("x")
