import json
import tempfile

import pytest
import nodriver as uc

URL = "https://intoli.com/blog/not-possible-to-block-chrome-headless/chrome-headless-test.html"


@pytest.mark.online
async def test_stealth_headed():
    b = await uc.start(user_data_dir=tempfile.mkdtemp(), headless=False, sandbox=True)
    try:
        tab = await b.get(URL)
        await tab.sleep(3)
        wd = await tab.evaluate("navigator.webdriver")
        assert wd in (False, None)
        failed = await tab.evaluate(
            "JSON.stringify(Array.from(document.querySelectorAll('.failed')).map(e=>e.id||e.innerText))"
        )
        failed_list = json.loads(failed) if isinstance(failed, str) else []
        assert "webdriver" not in " ".join(failed_list).lower()
    finally:
        b.stop()
