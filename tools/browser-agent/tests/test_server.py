"""browser-free tests for server.py: tool registration + write-guard behaviour."""
from __future__ import annotations

import asyncio

import pytest

from browser_agent import server
from browser_agent.guardrails import GuardError
from browser_agent.server import mcp

EXPECTED = {
    "use_profile",
    "begin_login",
    "navigate",
    "snapshot",
    "click",
    "type_text",
    "extract",
    "get_state",
    "compose",
    "confirm_publish",
}


def test_all_tools_registered():
    tools = asyncio.run(mcp.list_tools())
    names = {t.name for t in tools}
    assert names == EXPECTED


def test_confirm_publish_rejects_unknown_token():
    with pytest.raises(GuardError):
        asyncio.run(server.confirm_publish("bogus-token", 1))


def test_compose_token_is_single_use():
    # compose 经模块 _guard 暂存并返回 token；token 用一次即失效（防重放）。
    # 直接走 _guard.confirm 验证消费语义，避开 confirm_publish 的浏览器点击路径。
    out = asyncio.run(server.compose(site="x.com", summary="hi"))
    token = out["confirm_token"]
    assert server._guard.confirm(token).summary == "hi"
    with pytest.raises(GuardError):
        server._guard.confirm(token)


def test_host_extraction():
    assert server._host("https://x.com/abc?q=1") == "x.com"
    assert server._host("") == "default"


def test_throttle_passes_under_budget():
    # 预算充足时单次放行应立即返回（不阻塞）。
    asyncio.run(server._throttle("example.com"))


def test_throttle_cools_down_when_over_budget(monkeypatch):
    # 注入可控时钟的限速器：预算=1。第一次占满，第二次本应阻塞，
    # 待时钟推过窗口后放行——证明限速真的接在动作路径上、且是冷却而非报错。
    from browser_agent.humanize import RateLimiter

    clock = {"t": 1000.0}
    rl = RateLimiter(max_per_window=1, window_s=10.0, _now=lambda: clock["t"])
    monkeypatch.setattr(server, "_rl", rl)
    monkeypatch.setattr(server, "action_delay", lambda *a, **k: 0.01)

    async def scenario():
        assert rl.allow("x.com") is True  # 占满该站窗口

        async def advance():
            await asyncio.sleep(0.02)
            clock["t"] += 20  # 推过 10s 窗口，旧命中应被淘汰

        await asyncio.gather(server._throttle("x.com"), advance())

    asyncio.run(scenario())
