"""
反检测验收测试 — 验证 Camoufox 在真实 bot 检测页上不被识别为自动化。

这是项目「不被检测」北极星的可量化验收线（opt-in，需联网）。

为什么不用 bot.sannysoft.com（已实测确认）：
  该页某内联脚本抛出 location 为 undefined 的 JS 错误，触发 Playwright 1.60.0
  Firefox driver（Node coreBundle.js）里 pageError.location.url 的未捕获 TypeError，
  导致整个 driver 进程崩溃（"Connection closed while reading from the driver"），
  在 .failed DOM 填充前就断连。绕开它、改用 intoli headless 检测页（同样用
  .failed/.passed 标注，且能在 Firefox 上正常加载完成），断言稳定不靠竞速。

intoli 页在 Firefox 上唯一的 .failed 是 Chrome 专有项（window.chrome 缺失——
真实 Firefox 同样没有，非 webdriver/自动化信号），故只针对 webdriver 断言。
"""

import pytest
from camoufox.async_api import AsyncCamoufox

_DETECTION_URL = (
    "https://intoli.com/blog/not-possible-to-block-chrome-headless/"
    "chrome-headless-test.html"
)


@pytest.mark.online
async def test_no_webdriver_flag():
    """Camoufox 必须隐藏 navigator.webdriver（自动化最硬的破绽）。"""
    async with AsyncCamoufox(headless=True, humanize=True) as ctx:
        page = await ctx.new_page()
        await page.goto(_DETECTION_URL, wait_until="networkidle", timeout=60000)
        wd = await page.evaluate("() => navigator.webdriver")
        assert wd in (False, None), f"navigator.webdriver = {wd!r}，未隐藏 webdriver 标志"


@pytest.mark.online
async def test_no_webdriver_in_detection_failures():
    """检测页的失败项里不得出现 webdriver 相关（Chrome 专有项失败是 Firefox 预期，忽略）。"""
    async with AsyncCamoufox(headless=True, humanize=True) as ctx:
        page = await ctx.new_page()
        await page.goto(_DETECTION_URL, wait_until="networkidle", timeout=60000)
        failed = await page.eval_on_selector_all(
            ".failed", "els => els.map(e => e.id || e.innerText || e.className)"
        )
        joined = " ".join(str(x) for x in failed).lower()
        assert "webdriver" not in joined, f"webdriver 出现在 .failed 列表: {failed}"
