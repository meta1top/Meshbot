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
