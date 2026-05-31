import asyncio
from browser_mcp.server import mcp

EXPECTED = {"use_profile", "navigate", "snapshot", "click", "type_text", "fill", "scroll",
            "extract", "get_state", "cookies_save", "cookies_load", "screenshot"}


def test_tools_registered():
    names = {t.name for t in asyncio.run(mcp.list_tools())}
    assert EXPECTED.issubset(names)
