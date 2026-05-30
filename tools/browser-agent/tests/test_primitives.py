from pathlib import Path
import pytest
from camoufox.async_api import AsyncCamoufox
from browser_agent import primitives as P
from browser_agent.snapshot import COLLECT_JS

FIXTURE = (Path(__file__).parent / "fixtures" / "form.html").resolve().as_uri()


async def _ref_of(page, element_id):
    """COLLECT_JS 执行后，读元素被打上的 data-mb-ref。"""
    return await page.get_attribute(f"#{element_id}", "data-mb-ref")


@pytest.mark.browser
async def test_navigate_and_snapshot_have_refs():
    async with AsyncCamoufox(headless=True, humanize=True) as ctx:
        page = await ctx.new_page()
        await P.navigate(page, FIXTURE)
        snap = await P.snapshot(page)
        assert "登录" in snap          # button name
        assert "[" in snap             # 含 ref 编号


@pytest.mark.browser
async def test_type_and_click_change_dom():
    async with AsyncCamoufox(headless=True, humanize=True) as ctx:
        page = await ctx.new_page()
        await P.navigate(page, FIXTURE)
        # navigate 只调 get_state（不打 ref）；ref 由 snapshot/COLLECT_JS 才会写上，
        # 故这里显式 evaluate 一次，模拟 LLM 真实流程 navigate→snapshot→click(ref)。
        await page.evaluate(COLLECT_JS)
        user_ref = await _ref_of(page, "user")
        await P.type_text(page, ref=user_ref, text="alice")
        assert await page.input_value("#user") == "alice"
        go_ref = await _ref_of(page, "go")
        await P.click(page, ref=go_ref)
        assert await page.inner_text("#msg") == "clicked"


@pytest.mark.browser
async def test_extract_comments():
    async with AsyncCamoufox(headless=True, humanize=True) as ctx:
        page = await ctx.new_page()
        await P.navigate(page, FIXTURE)
        res = await P.extract(page, ".c")
        assert res["count"] == 2
        assert res["data"][0]["text"] == "很好"
