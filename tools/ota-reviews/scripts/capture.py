from __future__ import annotations

import argparse
import re
from pathlib import Path

from scrapling.fetchers import StealthyFetcher

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"

# 命中其一即疑似被反爬挡（验证码 / 访问拒绝 / 人机校验中转页）。
_BLOCK_MARKERS = [
    "captcha",
    "access denied",
    "are you a robot",
    "verify you are human",
    "robot check",
    "checking your browser",
    "请稍候",
    "请完成安全验证",
]


def capture(
    site: str,
    url: str,
    *,
    wait_selector: str | None = None,
    timeout: int = 60000,
    headless: bool = True,
    out_dir: Path | str | None = None,
) -> Path:
    """抓取 url 的渲染后 HTML，存成 <out_dir>/<site>_sample.html 并打印诊断。

    本地运行（需能访问目标站）。wait_selector 传评论容器选择器可提高拿到完整评论的概率。
    """
    kw: dict = {"headless": headless, "network_idle": True, "timeout": timeout}
    if wait_selector:
        kw["wait_selector"] = wait_selector
    page = StealthyFetcher.fetch(url, **kw)
    html = page.html_content

    out_dir = Path(out_dir) if out_dir else FIXTURES_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{site}_sample.html"
    out.write_text(html, encoding="utf-8")

    lo = html.lower()
    blocked = any(k in lo for k in _BLOCK_MARKERS)
    m = re.search(r"<title>(.*?)</title>", html, re.S | re.I)
    title = m.group(1).strip()[:120] if m else "(none)"
    print(f"saved {out} ({len(html)} bytes)")
    print(f"looks_blocked={blocked}  title={title!r}")
    if blocked:
        print("⚠️  疑似被反爬挡，fixture 可能不含真实评论；换住宅 IP / 加 --wait 评论选择器 / 重试。")
    return out


def main() -> None:
    p = argparse.ArgumentParser(
        description="抓取 OTA 页面存成测试 fixture（本地跑，需能访问目标站）"
    )
    p.add_argument(
        "--site", required=True, choices=["tripadvisor", "trip", "agoda", "booking"]
    )
    p.add_argument("--url", required=True, help="该平台上目标酒店的评论页 URL")
    p.add_argument("--wait", default=None, help="等待出现的 CSS 选择器（评论容器）")
    p.add_argument("--timeout", type=int, default=60000, help="页面加载超时 ms（默认 60s）")
    p.add_argument("--headed", action="store_true", help="非 headless（调试时看浏览器）")
    a = p.parse_args()
    capture(
        a.site,
        a.url,
        wait_selector=a.wait,
        timeout=a.timeout,
        headless=not a.headed,
    )


if __name__ == "__main__":
    main()
