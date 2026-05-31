import asyncio
from browser_mcp.server import mcp

EXPECTED = {"use_profile", "navigate", "snapshot", "click", "type_text", "fill", "scroll",
            "extract", "get_state", "cookies_save", "cookies_load", "screenshot"}


def test_tools_registered():
    names = {t.name for t in asyncio.run(mcp.list_tools())}
    assert names == EXPECTED  # 恰好这 12 个，不多不少


def test_host_extraction():
    from browser_mcp import server
    assert server._host("https://x.com/abc?q=1") == "x.com"
    assert server._host("") == "default"


def test_throttle_under_budget_returns():
    from browser_mcp import server
    asyncio.run(server._throttle("example.com"))  # 预算足，立即返回不阻塞


def test_throttle_cools_down_over_budget(monkeypatch):
    # 注入可控时钟的限速器(预算=1)：占满后第二次本应阻塞，待时钟推过窗口才放行
    # —— 证明限速真接在动作路径上、且是冷却而非报错。
    from browser_mcp import server
    from browser_mcp.humanize import RateLimiter

    clock = {"t": 1000.0}
    monkeypatch.setattr(server, "_rl", RateLimiter(1, 10.0, lambda: clock["t"]))
    monkeypatch.setattr(server, "action_delay", lambda *a, **k: 0.01)

    async def scenario():
        assert server._rl.allow("x.com") is True  # 占满该站窗口

        async def advance():
            await asyncio.sleep(0.02)
            clock["t"] += 20  # 推过 10s 窗口

        await asyncio.gather(server._throttle("x.com"), advance())

    asyncio.run(scenario())
