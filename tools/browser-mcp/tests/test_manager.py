import asyncio, pytest
from browser_mcp.manager import BrowserManager

async def test_run_serializes(tmp_path):
    mgr = BrowserManager(profiles_root=tmp_path, headless=True)
    order = []
    async def op(tag, d):
        order.append(f"s-{tag}"); await asyncio.sleep(d); order.append(f"e-{tag}"); return tag
    r = await asyncio.gather(mgr.run(lambda: op("a", 0.05)), mgr.run(lambda: op("b", 0.0)))
    assert r == ["a", "b"] and order == ["s-a", "e-a", "s-b", "e-b"]

def test_profile_path(tmp_path):
    mgr = BrowserManager(profiles_root=tmp_path, headless=True)
    assert mgr._profile_path("acct") == tmp_path / "acct"
