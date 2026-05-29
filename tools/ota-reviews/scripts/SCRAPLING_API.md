# Scrapling 实测 API 备忘

> 本文件记录 **本机实际安装版本** 的 Scrapling API，供后续任务（Pydantic 模型、
> 各平台抓取脚本、SKILL.md 安装说明）引用。所有内容均基于真实 `import` + introspection，
> 非凭记忆。版本间差异较大，升级后请重新实测并更新本文件。
>
> 实测日期：2026-05-30 · Python 3.10.14 · macOS arm64

## 安装版本

- **scrapling 0.4.8**（`requirements.txt` 写 `scrapling[fetchers]>=0.2.9`，pip 解析到 0.4.8）

### 重要：0.4.x 已做包拆分（与计划假设的 0.2.x 不同）

裸 `pip install scrapling` **只装解析器**（`Selector`），不含任何 Fetcher / CLI。
`StealthyFetcher`、`scrapling` CLI 等需要 `[fetchers]` extra：

```bash
pip install "scrapling[fetchers]"
```

不装 extra 时 `from scrapling.fetchers import StealthyFetcher` 会抛
`ModuleNotFoundError: No module named 'curl_cffi'`（以及 click 缺失导致 CLI 不可用）。

因此 `requirements.txt` 已改为 `scrapling[fetchers]>=0.2.9`。

extras 列表（来自包 metadata）：`fetchers` / `ai` / `shell` / `all`。
`[fetchers]` 会拉入：`playwright==1.59.0`、`patchright==1.59.1`、`curl_cffi>=0.15.0`、
`browserforge`、`apify-fingerprint-datapoints`、`click`、`msgspec`、`anyio`、`protego` 等。

## 顶层导出（`import scrapling`）

```python
['AsyncFetcher', 'DynamicFetcher', 'Fetcher', 'Selector',
 'StealthyFetcher', 'cli', 'core', 'fetchers', 'parser']
```

注意：解析器类名是 **`Selector`**（不是旧版的 `Adaptor`）。`from scrapling import Selector`。

`scrapling.fetchers` 导出：
```python
['AsyncDynamicSession', 'AsyncFetcher', 'AsyncStealthySession',
 'DynamicFetcher', 'DynamicSession', 'Fetcher', 'FetcherSession',
 'StealthyFetcher', 'StealthySession']
```

## 抓取入口：`StealthyFetcher.fetch`

```python
from scrapling.fetchers import StealthyFetcher
page = StealthyFetcher.fetch(url, **kwargs)   # 返回 Response（即 Selector 子类，见下）
```

- 签名：`fetch(url: str, **kwargs) -> Response`，所有参数走 `**kwargs`
  （类型来自 `scrapling.engines._browsers._types.StealthSession` TypedDict）。
- 也有 `StealthyFetcher.async_fetch(...)` 异步版本。
- 类上其它可调用：`configure`、`display_config`、`adaptive`、`adaptive_domain`、
  `huge_tree`、`keep_cdata`、`keep_comments`、`parser_keywords`、`storage`、`storage_args`。

### `fetch` 的关键参数（实测的完整 kwargs 集合）

后续任务最常用的几个：

| 参数 | 类型 | 用途 |
|------|------|------|
| `headless` | `bool` | 无头模式 |
| `network_idle` | `bool` | 等待网络空闲 |
| `load_dom` | `bool` | 等 DOM 加载 |
| `wait_selector` | `Optional[str]` | 等待某 CSS 选择器出现（等评论列表渲染） |
| `wait_selector_state` | `'attached'\|'detached'\|'hidden'\|'visible'` | 等待状态 |
| `wait` | `int\|float` | 额外固定等待（毫秒） |
| `timeout` | `int\|float` | 超时 |
| `proxy` | `str \| Dict[str,str] \| Tuple \| None` | 代理 |
| `proxy_rotator` | `Optional[ProxyRotator]` | 代理轮换 |
| `extra_headers` | `Optional[Dict[str,str]]` | 额外请求头 |
| `useragent` | `Optional[str]` | UA |
| `cookies` | `Optional[Sequence[SetCookieParam]]` | cookies |
| `page_action` / `page_setup` | `Optional[Callable]` | 页面交互回调（滚动/点击加载更多评论） |
| `disable_resources` | `bool` | 屏蔽资源加载 |
| `block_ads` / `blocked_domains` | `bool` / `Optional[Set[str]]` | 拦广告/域名 |
| `solve_cloudflare` | `bool` | 过 Cloudflare |
| `retries` / `retry_delay` | `int` / `int\|float` | 重试 |
| `geolocation/locale/timezone_id` | — | `locale: Optional[str]`、`timezone_id: str\|None` |
| `real_chrome` / `executable_path` / `cdp_url` | — | 用真实 Chrome / 指定浏览器路径 / 连 CDP |
| `capture_xhr` | `str\|None` | 抓 XHR（可能直接拿评论 JSON 接口） |

完整 kwargs（实测 `StealthSession.__annotations__`）：
`max_pages, headless, disable_resources, network_idle, load_dom, wait_selector,
wait_selector_state, cookies, google_search, wait, timezone_id, page_action,
page_setup, proxy, proxy_rotator, extra_headers, timeout, init_script,
user_data_dir, selector_config, additional_args, locale, real_chrome, cdp_url,
useragent, extra_flags, blocked_domains, block_ads, retries, retry_delay,
capture_xhr, executable_path, dns_over_https, allow_webgl, hide_canvas,
block_webrtc, solve_cloudflare`。

## 从 HTML 字符串构造解析器

```python
from scrapling import Selector
sel = Selector(html_str)         # 第一个位置参数 content: str|bytes|None
# 其它常用入参：url='', encoding='utf-8', keep_comments=False, adaptive=False
```

`StealthyFetcher.fetch` 返回的 `Response`（`scrapling.engines.toolbelt.custom.Response`）
本身就拥有全部 Selector 查询方法（同一套 API），无需再包一层。

## 查询方法（Selector / Response 通用）

实测可用成员：
```
css, xpath, find, find_all, find_by_text, find_by_regex, find_similar, find_ancestor,
get, getall, get_all_text, extract, extract_first, re, re_first,
attrib, text, tag, has_class, parent, children, siblings, next, previous,
html_content, body, prettify, json, url, save, ...
```

### 关键差异：没有 `css_first` / `xpath_first`

旧版本里的 `css_first` 在 0.4.8 **不存在**。`css()` / `xpath()` 返回 `Selectors`
（类列表容器），取首个元素用下标 `[0]`，注意先判空：

```python
items = sel.css('div.review')          # -> Selectors（可 len()、可下标、可迭代）
first = items[0] if items else None     # 没有 css_first，自己取 [0]
```

- `css(selector, ...)` / `xpath(selector, ...)` -> `Selectors`
- 支持 CSS `::text` 伪选择器：`sel.css('span.t::text')[0].get()` 返回文本
- 单元素 `.text` -> 该节点文本；`.get_all_text(separator='\n', strip=False, ignore_tags=('script','style'))` -> 拼接后代文本
- `.get()` -> `TextHandler`（取元素文本/值）；`.getall()` -> 列表
- `.attrib` 是 **property**，返回 dict-like，取属性：`el.attrib.get('href')`
- `.re(regex, ...)` / `.re_first(regex, default=None, ...)` 正则提取
- `find(...)` -> `Optional[Selector]`；`find_all(...)` -> `Selectors`（BeautifulSoup 风格）

### 实测验证（确实跑通）

```python
sel = Selector('<div class="r"><span class="t">Great hotel</span><a href="/u/1">Alice</a></div>...')
sel.css('div.r')                       # -> Selectors len=2
sel.css('div.r')[0].css('span.t')[0].text          # -> 'Great hotel'
sel.css('div.r')[0].css('span.t::text')[0].get()   # -> 'Great hotel'
sel.css('div.r')[0].css('a')[0].attrib.get('href') # -> '/u/1'
sel.css('div.r')[0].get_all_text(strip=True)        # -> 'Great hotel\nAlice'
```

## 取原始 HTML 字符串

- `page.html_content` -> `str`（整页 HTML 源码，实测可用，推荐用它存 fixture）
- `page.body` -> `str`（实测也返回 str）
- `page.prettify()` -> 美化后的 HTML

## 浏览器二进制安装（StealthyFetcher 首次使用前需要）

`StealthyFetcher` 依赖浏览器引擎（playwright/patchright + camoufox 系）。装完
`scrapling[fetchers]` 后，需要再跑一次 Scrapling 自带的安装命令拉取浏览器二进制：

```bash
scrapling install        # 安装所有 Fetcher 浏览器依赖；-f / --force 强制重装
```

> 本任务按计划只做 import + introspection，**未实际联网抓取**，因此尚未运行
> `scrapling install`（也未下载浏览器二进制）。后续任务首次真正调用
> `StealthyFetcher.fetch` 前必须先执行上面这条命令，SKILL.md 的安装段落应引用它。
> 备选：playwright 也提供 `python -m playwright install`，但 Scrapling 官方推荐 `scrapling install`。

CLI 其它子命令（`scrapling --help`）：`extract` / `install` / `mcp` / `shell`。
（CLI 同样需要 `[fetchers]` 或 `[shell]` extra，否则报缺 click。）
