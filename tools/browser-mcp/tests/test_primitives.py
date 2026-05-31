import pytest, tempfile, nodriver as uc
from pathlib import Path
from browser_mcp import primitives as P
from browser_mcp.snapshot import COLLECT_JS

FIX = "file://" + str(Path("tests/fixtures/form.html").resolve())

@pytest.mark.browser
async def test_navigate_snapshot_click_type():
    b = await uc.start(user_data_dir=tempfile.mkdtemp(), headless=True, sandbox=True)
    try:
        tab = await b.get(FIX)
        st = await P.get_state(tab); assert st["ok"]
        snap = await P.snapshot(tab); assert "登录" in snap and "[" in snap
        await tab.evaluate(COLLECT_JS)
        uref = await tab.evaluate("document.getElementById('u').getAttribute('data-mb-ref')")
        await P.type_text(tab, uref, "alice")
        assert (await tab.evaluate("document.getElementById('u').value")) == "alice"
        gref = await tab.evaluate("document.getElementById('go').getAttribute('data-mb-ref')")
        await P.click(tab, gref)
        await tab.sleep(0.3)
        assert (await tab.evaluate("document.getElementById('m').innerText")) == "clicked"
        res = await P.extract(tab, ".c")
        assert res["count"] == 2 and res["data"][0]["text"] == "很好"
    finally:
        b.stop()
