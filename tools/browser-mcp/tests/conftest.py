"""默认跳过 browser/online 标记的测试；用环境变量显式打开：
  BROWSER_E2E=1 pytest   → 跑 @pytest.mark.browser（需真 Chrome，无网络）
  BROWSER_ONLINE=1 pytest → 跑 @pytest.mark.online（需联网，反检测验收）
比 addopts 里硬编 -m 过滤更直观（env 一开即生效，无需 --override-ini）。"""
import os
import pytest


def pytest_collection_modifyitems(config, items):
    run_browser = os.environ.get("BROWSER_E2E") == "1"
    run_online = os.environ.get("BROWSER_ONLINE") == "1"
    skip_browser = pytest.mark.skip(reason="需 BROWSER_E2E=1（真 Chrome e2e）")
    skip_online = pytest.mark.skip(reason="需 BROWSER_ONLINE=1（联网反检测验收）")
    for item in items:
        if "browser" in item.keywords and not run_browser:
            item.add_marker(skip_browser)
        if "online" in item.keywords and not run_online:
            item.add_marker(skip_online)
