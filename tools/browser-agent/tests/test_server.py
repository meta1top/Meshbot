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
