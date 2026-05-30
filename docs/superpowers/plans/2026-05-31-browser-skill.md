# browser skill（patchright/真 Chrome 任务 CLI）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把浏览器自动化做成 meshbot 运行时 skill：`tools/browser/` 捆绑一个 Node/patchright CLI，对外是高层任务动词（login / post / comments），用系统真 Chrome + 持久登录态 profile，agent 经 `skill_load` + `bash` 调用。首切片只做 X。

**Architecture:** 独立 Node 项目（不入主 monorepo 构建，类比 `tools/ota-reviews`），自带 `node_modules`（patchright，不下载浏览器）。`cli.js` 解析动词 → dispatch 到 `src/<verb>.js`；动词用 `src/browser.js`（启真 Chrome 持久 context + Chrome 必装检查 + 被挡检测）+ `src/humanize.js`（节奏）+ `src/platforms/<p>.js`（每平台选择器/流程）。零 core 改动、无 mcp.json；软链装进 `<meshbotDir>/skills/browser`。

**Tech Stack:** Node 20+ · `patchright`（真 Chrome over CDP，堵 webdriver/Runtime.enable）· `vitest`（测试）。

参考 spec：`docs/superpowers/specs/2026-05-31-browser-agent-patchright-migration-design.md`。

---

## 文件结构

```
tools/browser/
├── package.json              # type:module, deps: patchright; devDeps: vitest; scripts
├── .gitignore                # node_modules profiles debug
├── SKILL.md                  # frontmatter + 正文（动词、登录、确认约定、注意）
├── cli.js                    # 入口：parseArgs → dispatch verb → exit code
├── install.js                # 软链 tools/browser → <meshbotDir>/skills/browser
├── src/
│   ├── args.js               # 极简 argv 解析（无三方库）
│   ├── humanize.js           # actionDelay / typingIntervals / RateLimiter / mousePath（纯）
│   ├── browser.js            # profileDir / assertChrome / launch / detectBlocked
│   ├── platforms/x.js        # X：loginUrl / isLoggedIn / post / parseComments（选择器现场发现）
│   ├── login.js              # verb
│   ├── post.js               # verb（dry-run 预览 → --confirm 发布）
│   └── comments.js           # verb（→ JSON 落盘 + 摘要）
└── tests/
    ├── fixtures/             # 保存的 HTML 样本（X 评论页、本地表单页）
    └── *.test.js             # vitest
```

**测试分层**：默认 `vitest run` 跑纯单测（无浏览器、无网络）；浏览器/在线测试用 `describe.skipIf(!process.env.BROWSER_E2E)` 等环境开关隔离，手动 opt-in。

---

## Task 0：脚手架

**Files:**
- Create: `tools/browser/package.json`
- Create: `tools/browser/.gitignore`
- Create: `tools/browser/tests/smoke.test.js`

- [ ] **Step 1: 写 `tools/browser/package.json`**

```json
{
  "name": "@meshbot/browser-skill",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "bin": { "browser": "./cli.js" },
  "scripts": {
    "test": "vitest run",
    "e2e": "BROWSER_E2E=1 vitest run",
    "online": "BROWSER_ONLINE=1 vitest run"
  },
  "dependencies": { "patchright": "^1.60" },
  "devDependencies": { "vitest": "^4" }
}
```

- [ ] **Step 2: 写 `tools/browser/.gitignore`**

```gitignore
node_modules/
profiles/
debug/
*.log
```

- [ ] **Step 3: 写占位单测 `tools/browser/tests/smoke.test.js`**

```js
import { test, expect } from "vitest";

test("vitest runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: 装依赖**

Run:
```bash
cd tools/browser
npm install
npx patchright install chrome --dry-run 2>/dev/null || true   # 不强制；channel=chrome 用系统 Chrome
```
Expected: 安装成功（patchright + vitest）。不下载浏览器二进制。

- [ ] **Step 5: 确认系统真 Chrome 在（skill 运行前提）**

Run（macOS）：`ls -d "/Applications/Google Chrome.app" && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version`
Expected: 打印 `Google Chrome <版本>`。（缺则 SKILL.md 提示用户装；不静默回落。）

- [ ] **Step 6: 跑空套件**

Run: `cd tools/browser && npm test`
Expected: 1 passed。

- [ ] **Step 7: Commit**

```bash
git add tools/browser/package.json tools/browser/.gitignore tools/browser/tests/smoke.test.js
git commit -m "chore(browser): skill 脚手架（package.json + vitest）"
```

---

## Task 1：`src/args.js`（极简 argv 解析）

**Files:**
- Create: `tools/browser/src/args.js`
- Test: `tools/browser/tests/args.test.js`

- [ ] **Step 1: 写失败测试 `tools/browser/tests/args.test.js`**

```js
import { test, expect } from "vitest";
import { parseArgs } from "../src/args.js";

test("verb + flags + value flags", () => {
  const r = parseArgs(["post", "--site", "x", "--text", "hi there", "--confirm"]);
  expect(r.verb).toBe("post");
  expect(r.flags.site).toBe("x");
  expect(r.flags.text).toBe("hi there");
  expect(r.flags.confirm).toBe(true);
});

test("missing verb", () => {
  expect(parseArgs([]).verb).toBeUndefined();
});

test("repeated flag collects array", () => {
  const r = parseArgs(["post", "--image", "a.png", "--image", "b.png"]);
  expect(r.flags.image).toEqual(["a.png", "b.png"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/browser && npx vitest run tests/args.test.js`
Expected: FAIL（找不到 parseArgs）。

- [ ] **Step 3: 实现 `tools/browser/src/args.js`**

```js
/** 极简 argv 解析：第一个非 --flag 为 verb；--k v 取值，--k（后面是 flag 或无）为 true；重复 --k 收集成数组。 */
export function parseArgs(argv) {
  const flags = {};
  let verb;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith("--") ? (i++, next) : true;
      if (key in flags) {
        flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
      } else {
        flags[key] = value;
      }
    } else if (verb === undefined) {
      verb = a;
    }
  }
  return { verb, flags };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd tools/browser && npx vitest run tests/args.test.js`
Expected: 3 passed。

- [ ] **Step 5: Commit**

```bash
git add tools/browser/src/args.js tools/browser/tests/args.test.js
git commit -m "feat(browser): args 极简 argv 解析 + 单测"
```

---

## Task 2：`src/humanize.js`（人类节奏，纯函数）

**Files:**
- Create: `tools/browser/src/humanize.js`
- Test: `tools/browser/tests/humanize.test.js`

- [ ] **Step 1: 写失败测试 `tools/browser/tests/humanize.test.js`**

```js
import { test, expect } from "vitest";
import { actionDelay, typingIntervals, RateLimiter, mousePath } from "../src/humanize.js";

test("actionDelay within bounds + varies", () => {
  const vals = new Set();
  for (let i = 0; i < 200; i++) {
    const d = actionDelay(0.4, 1.5);
    expect(d).toBeGreaterThanOrEqual(0.4);
    expect(d).toBeLessThanOrEqual(1.5);
    vals.add(Math.round(d * 1000));
  }
  expect(vals.size).toBeGreaterThan(20);
});

test("typingIntervals length + bounds", () => {
  const iv = typingIntervals("hello");
  expect(iv).toHaveLength(5);
  expect(iv.every((x) => x >= 0.02 && x <= 0.5)).toBe(true);
});

test("RateLimiter sliding window + per key + eviction", () => {
  let now = 100;
  const rl = new RateLimiter(1, 10, () => now);
  expect(rl.allow("x")).toBe(true);
  expect(rl.allow("x")).toBe(false);
  expect(rl.allow("y")).toBe(true);
  now = 111;
  expect(rl.allow("x")).toBe(true);
});

test("mousePath starts/ends right + has intermediate steps", () => {
  const p = mousePath({ x: 0, y: 0 }, { x: 100, y: 50 }, 6);
  expect(p[0]).toEqual({ x: 0, y: 0 });
  expect(p[p.length - 1]).toEqual({ x: 100, y: 50 });
  expect(p.length).toBe(7);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/browser && npx vitest run tests/humanize.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 `tools/browser/src/humanize.js`**

```js
/** 人类节奏：动作延迟、打字间隔、限速、鼠标轨迹。纯函数 / 可注入时钟。 */

function gauss(mu, sigma) {
  // Box-Muller
  const u = 1 - Math.random();
  const v = Math.random();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 两次动作间随机延迟（秒），偏区间中段的对数正态。 */
export function actionDelay(lo = 0.4, hi = 1.5) {
  const mu = (Math.log(lo) + Math.log(hi)) / 2;
  const sigma = (Math.log(hi) - Math.log(lo)) / 4;
  return Math.max(lo, Math.min(hi, Math.exp(gauss(mu, sigma))));
}

/** 逐字输入间隔（秒），含偶发空格停顿。 */
export function typingIntervals(text, base = 0.08) {
  const out = [];
  for (const ch of text) {
    const jitter = 0.6 + Math.random();
    const pause = ch === " " && Math.random() < 0.2 ? 0.25 : 0;
    out.push(Math.min(0.5, Math.max(0.02, base * jitter + pause)));
  }
  return out;
}

/** 鼠标从 from 到 to 的分段轨迹（含微抖动），共 steps+1 个点，端点精确。 */
export function mousePath(from, to, steps = 12) {
  const pts = [{ x: from.x, y: from.y }];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const jx = (Math.random() - 0.5) * 4;
    const jy = (Math.random() - 0.5) * 4;
    pts.push({ x: from.x + (to.x - from.x) * t + jx, y: from.y + (to.y - from.y) * t + jy });
  }
  pts.push({ x: to.x, y: to.y });
  return pts;
}

/** 滑动窗口限速，每 key 独立。可注入时钟（毫秒/秒一致即可）。 */
export class RateLimiter {
  constructor(maxPerWindow, windowS, now = () => Date.now() / 1000) {
    this._max = maxPerWindow;
    this._window = windowS;
    this._now = now;
    this._hits = new Map();
  }
  allow(key) {
    const t = this._now();
    const dq = this._hits.get(key) ?? [];
    while (dq.length && t - dq[0] > this._window) dq.shift();
    if (dq.length >= this._max) {
      this._hits.set(key, dq);
      return false;
    }
    dq.push(t);
    this._hits.set(key, dq);
    return true;
  }
}

/** 睡眠 helper（秒）。 */
export const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd tools/browser && npx vitest run tests/humanize.test.js`
Expected: 4 passed。

- [ ] **Step 5: Commit**

```bash
git add tools/browser/src/humanize.js tools/browser/tests/humanize.test.js
git commit -m "feat(browser): humanize 节奏（延迟/打字/限速/鼠标轨迹）+ 单测"
```

---

## Task 3：`src/browser.js`（启动真 Chrome + Chrome 必装 + 被挡检测）

`profileDir`、`detectBlocked` 是纯函数（单测）；`launch`/`assertChrome` 需真 Chrome（浏览器 e2e）。

**Files:**
- Create: `tools/browser/src/browser.js`
- Test: `tools/browser/tests/browser.test.js`

- [ ] **Step 1: 写失败测试 `tools/browser/tests/browser.test.js`**

```js
import { test, expect, describe } from "vitest";
import { profileDir, detectBlocked, launch } from "../src/browser.js";

test("profileDir under root", () => {
  expect(profileDir("/root", "my-x")).toBe("/root/my-x");
});

test("profileDir rejects traversal", () => {
  for (const bad of ["", ".", "..", "a/b", "a\\b"]) {
    expect(() => profileDir("/root", bad)).toThrow();
  }
});

test("detectBlocked matches markers", () => {
  expect(detectBlocked("Please verify you are human")).toBe(true);
  expect(detectBlocked("请完成安全验证")).toBe(true);
  expect(detectBlocked("normal page content")).toBe(false);
});

describe.skipIf(!process.env.BROWSER_E2E)("real chrome", () => {
  test("launch headless + navigator.webdriver hidden", async () => {
    const { context, page } = await launch("/tmp/browser-skill-test", { headless: true });
    try {
      await page.goto("about:blank");
      const wd = await page.evaluate(() => navigator.webdriver);
      expect(wd === false || wd === undefined).toBe(true);
    } finally {
      await context.close();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/browser && npx vitest run tests/browser.test.js`
Expected: FAIL（纯单测部分找不到导出）。

- [ ] **Step 3: 实现 `tools/browser/src/browser.js`**

```js
import path from "node:path";
import { chromium } from "patchright";

const BLOCK_MARKERS = [
  "captcha", "verify you are human", "are you a robot", "access denied",
  "checking your browser", "请完成安全验证", "请稍候",
];

/** 解析账号 profile 目录，拒绝路径穿越。 */
export function profileDir(root, name) {
  if (name.includes("/") || name.includes("\\") || ["", ".", ".."].includes(name)) {
    throw new Error(`非法 profile 名: ${JSON.stringify(name)}`);
  }
  return path.join(root, name);
}

/** body 文本是否疑似被反爬挡。 */
export function detectBlocked(bodyText) {
  const lo = (bodyText || "").toLowerCase();
  return BLOCK_MARKERS.some((m) => lo.includes(m));
}

/** 启动系统真 Chrome 的持久 context。Chrome 缺失 → 抛清晰错误。 */
export async function launch(userDataDir, { headless = false } = {}) {
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless,
      viewport: null,
    });
  } catch (e) {
    if (/executable|channel|chrome|not found/i.test(String(e?.message))) {
      throw new Error(
        "需要安装 Google Chrome（patchright 用系统真 Chrome，channel=chrome）。" +
          "装好 Chrome 后重试。原始错误：" + e.message,
      );
    }
    throw e;
  }
  const page = context.pages()[0] || (await context.newPage());
  return { context, page };
}
```

- [ ] **Step 4: 跑纯单测确认通过**

Run: `cd tools/browser && npx vitest run tests/browser.test.js`
Expected: 3 passed（real chrome describe 被 skip）。

- [ ] **Step 5: 跑浏览器 e2e 确认真 Chrome 启动 + webdriver 隐藏**

Run: `cd tools/browser && BROWSER_E2E=1 npx vitest run tests/browser.test.js`
Expected: 4 passed（含真 Chrome）。若报缺 Chrome：先装 Google Chrome。

- [ ] **Step 6: Commit**

```bash
git add tools/browser/src/browser.js tools/browser/tests/browser.test.js
git commit -m "feat(browser): browser 启真 Chrome 持久 context + Chrome 必装检查 + 被挡检测 + 测"
```

---

## Task 4：`src/login.js` + `cli.js`（dispatch + login 动词）

login 走平台无关骨架：用持久 profile 启 headed Chrome，导航平台 loginUrl，轮询 `platform.isLoggedIn(page)` 直到成功或超时（用户在窗口里人工登录）。X 适配器在 Task 6 提供；本任务先放一个最小 stub 平台供 CLI 跑通。

**Files:**
- Create: `tools/browser/src/platforms/index.js`
- Create: `tools/browser/src/login.js`
- Create: `tools/browser/cli.js`
- Test: `tools/browser/tests/cli.test.js`

- [ ] **Step 1: 写失败测试 `tools/browser/tests/cli.test.js`**

```js
import { test, expect } from "vitest";
import { resolvePlatform } from "../src/platforms/index.js";

test("resolvePlatform known/unknown", () => {
  expect(resolvePlatform("x")).toBeTruthy();
  expect(() => resolvePlatform("nope")).toThrow();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/browser && npx vitest run tests/cli.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 `tools/browser/src/platforms/index.js`**

```js
import * as x from "./x.js";

const REGISTRY = { x };

/** 按 --site 取平台适配器；未知则报错列出支持项。 */
export function resolvePlatform(site) {
  const p = REGISTRY[site];
  if (!p) throw new Error(`未知 --site=${site}；支持：${Object.keys(REGISTRY).join(", ")}`);
  return p;
}
```

- [ ] **Step 4: 建临时 X stub 让 CLI/login 可跑通（Task 6 会替换为真实实现）**

写 `tools/browser/src/platforms/x.js`（占位，Task 6 填真实选择器）：
```js
export const loginUrl = "https://x.com/login";
export const homeUrl = "https://x.com/home";
/** 占位：Task 6 用真实选择器替换。 */
export async function isLoggedIn(page) {
  return !/\/login|\/i\/flow\/login/.test(page.url());
}
export async function post() {
  throw new Error("x.post 未实现（Task 6）");
}
export async function parseComments() {
  throw new Error("x.parseComments 未实现（Task 6）");
}
```

- [ ] **Step 5: 实现 `tools/browser/src/login.js`**

```js
import { launch } from "./browser.js";
import { sleep } from "./humanize.js";

/** login 动词：headed 启 Chrome，导航登录页，轮询 isLoggedIn 直到成功或超时（用户人工登录）。 */
export async function login({ profileDir: dir, platform, timeoutS = 300 }) {
  const { context, page } = await launch(dir, { headless: false });
  try {
    await page.goto(platform.homeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (await platform.isLoggedIn(page)) return { ok: true, already: true };
    await page.goto(platform.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline) {
      if (await platform.isLoggedIn(page)) return { ok: true, already: false };
      await sleep(2);
    }
    return { ok: false, reason: "登录超时（未在窗口完成登录）" };
  } finally {
    await context.close();
  }
}
```

- [ ] **Step 6: 实现 `tools/browser/cli.js`**

```js
#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { parseArgs } from "./src/args.js";
import { resolvePlatform } from "./src/platforms/index.js";
import { profileDir } from "./src/browser.js";
import { login } from "./src/login.js";

const PROFILES_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "profiles");

function meshbotWorkspace() {
  const base = process.env.MESHBOT_DIR || path.join(os.homedir(), ".meshbot");
  return path.join(base, "workspace", "browser");
}

async function main() {
  const { verb, flags } = parseArgs(process.argv.slice(2));
  if (!verb) {
    console.error("用法: browser <login|post|comments> --site <x> [...]");
    process.exit(2);
  }
  const site = flags.site;
  if (!site) {
    console.error("缺 --site");
    process.exit(2);
  }
  const platform = resolvePlatform(site);
  const dir = profileDir(PROFILES_ROOT, site);

  if (verb === "login") {
    const r = await login({ profileDir: dir, platform });
    console.log(r.ok ? `[login] ok${r.already ? "（已登录）" : ""}` : `[login] FAIL: ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }
  // post / comments 在 Task 5 / 7 接入
  console.error(`未实现的 verb: ${verb}`);
  process.exit(2);
}

main().catch((e) => {
  console.error("[browser] ERROR:", e.message);
  process.exit(1);
});
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd tools/browser && npx vitest run tests/cli.test.js`
Expected: 1 passed。

- [ ] **Step 8: Commit**

```bash
git add tools/browser/src/platforms/index.js tools/browser/src/platforms/x.js tools/browser/src/login.js tools/browser/cli.js tools/browser/tests/cli.test.js
git commit -m "feat(browser): cli dispatch + login 动词 + 平台注册 + X stub"
```

---

## Task 5：`src/post.js`（dry-run 预览 → --confirm 发布；本地 fixture 验证）

post 走平台无关骨架：`platform.post(page, {text, images, confirm})` 负责填内容；`confirm=false` 时填好但不发、截图返回预览；`confirm=true` 发布。本任务用本地 fixture 表单页验证骨架（不打 X），X 真实 post 在 Task 6。

**Files:**
- Create: `tools/browser/src/post.js`
- Create: `tools/browser/tests/fixtures/compose.html`
- Modify: `tools/browser/cli.js`（接 post 分支）
- Test: `tools/browser/tests/post.test.js`

- [ ] **Step 1: 写本地 fixture `tools/browser/tests/fixtures/compose.html`**

```html
<!doctype html><html><head><meta charset="utf-8"></head><body>
<textarea id="editor" placeholder="说点什么"></textarea>
<button id="publish" onclick="document.getElementById('done').innerText='published'">发布</button>
<p id="done"></p>
</body></html>
```

- [ ] **Step 2: 写失败测试 `tools/browser/tests/post.test.js`**

```js
import { test, expect, describe } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launch } from "../src/browser.js";

const FIXTURE = pathToFileURL(path.resolve("tests/fixtures/compose.html")).href;

// 用 fixture 平台适配器验证 post 骨架的 dry-run/confirm 语义
const fixturePlatform = {
  async post(page, { text, confirm }) {
    await page.fill("#editor", text);
    if (!confirm) return { published: false, preview: text };
    await page.click("#publish");
    return { published: true };
  },
};

describe.skipIf(!process.env.BROWSER_E2E)("post skeleton on fixture", () => {
  test("dry-run fills but does not publish", async () => {
    const { context, page } = await launch("/tmp/browser-skill-post", { headless: true });
    try {
      await page.goto(FIXTURE);
      const r = await fixturePlatform.post(page, { text: "hi", confirm: false });
      expect(r.published).toBe(false);
      expect(await page.inputValue("#editor")).toBe("hi");
      expect(await page.innerText("#done")).toBe("");
    } finally {
      await context.close();
    }
  });

  test("confirm publishes", async () => {
    const { context, page } = await launch("/tmp/browser-skill-post", { headless: true });
    try {
      await page.goto(FIXTURE);
      await fixturePlatform.post(page, { text: "hi", confirm: true });
      expect(await page.innerText("#done")).toBe("published");
    } finally {
      await context.close();
    }
  });
});
```

- [ ] **Step 3: 跑确认失败/skip**

Run: `cd tools/browser && BROWSER_E2E=1 npx vitest run tests/post.test.js`
Expected: FAIL（`src/post.js` 还没有，import 报错）—— 先建空文件让其余通过；见下。

- [ ] **Step 4: 实现 `tools/browser/src/post.js`**

```js
import os from "node:os";
import path from "node:path";
import { launch, detectBlocked } from "./browser.js";

/**
 * post 动词：用持久 profile 启 Chrome，确认已登录，调 platform.post。
 * confirm=false（默认）→ 填内容、截图、返回预览，不发布。
 * confirm=true → 发布。
 */
export async function post({ profileDir: dir, platform, text, images = [], confirm = false, headless = false }) {
  const { context, page } = await launch(dir, { headless });
  try {
    await page.goto(platform.homeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!(await platform.isLoggedIn(page))) return { ok: false, reason: "未登录，请先 login" };
    const body = await page.innerText("body").catch(() => "");
    if (detectBlocked(body)) return { ok: false, reason: "BLOCKED: 疑似被反爬挡" };

    const r = await platform.post(page, { text, images, confirm });
    if (!confirm) {
      const shot = path.join(os.tmpdir(), `browser-post-preview-${process.pid}.png`);
      await page.screenshot({ path: shot });
      return { ok: true, published: false, preview: r.preview ?? text, screenshot: shot };
    }
    return { ok: true, published: true };
  } finally {
    await context.close();
  }
}
```

- [ ] **Step 5: cli.js 接 post 分支**

在 `cli.js` 的 `if (verb === "login")` 块后加：
```js
  if (verb === "post") {
    const { post } = await import("./src/post.js");
    const r = await post({
      profileDir: dir, platform,
      text: flags.text || "",
      images: flags.image ? [].concat(flags.image) : [],
      confirm: flags.confirm === true,
    });
    if (!r.ok) { console.error(`[post] FAIL: ${r.reason}`); process.exit(1); }
    if (r.published) console.log("[post] 已发布");
    else console.log(`[post] 预览（未发布）:\n${r.preview}\n截图: ${r.screenshot}\n确认后加 --confirm 重跑发布`);
    process.exit(0);
  }
```

- [ ] **Step 6: 跑浏览器 e2e 确认骨架语义**

Run: `cd tools/browser && BROWSER_E2E=1 npx vitest run tests/post.test.js`
Expected: 2 passed。

- [ ] **Step 7: Commit**

```bash
git add tools/browser/src/post.js tools/browser/tests/fixtures/compose.html tools/browser/tests/post.test.js tools/browser/cli.js
git commit -m "feat(browser): post 动词骨架（dry-run/confirm）+ 本地 fixture e2e"
```

---

## Task 6：X 适配器（现场发现选择器 + 实现 + 评论解析器单测）

⚠️ **本任务需登录态 X**。X 的 compose/publish/评论 DOM 是登录后才可见、且会变，**不能盲写**。流程：先用 `login --site x` 登录，再用 headed 浏览器打开真实页面、用 DevTools/`page.locator` 试探出稳定选择器，填进 `x.js`，并保存一份评论页 HTML 作 fixture 给解析器写单测。

**Files:**
- Modify: `tools/browser/src/platforms/x.js`（替换 Task 4 的 stub）
- Create: `tools/browser/tests/fixtures/x_comments.html`（现场保存）
- Test: `tools/browser/tests/x.test.js`

- [ ] **Step 1: 登录并捕获评论页 fixture**

```bash
cd tools/browser
node cli.js login --site x          # 在弹出窗口人工登录
```
然后写一个一次性脚本用持久 profile 打开"你某条推的评论区"，`page.content()` 存到 `tests/fixtures/x_comments.html`（保存真实 DOM 供解析单测，不打网络）。把该脚本也留在 `tools/browser/scripts/capture-x.js`（开发工具）。

- [ ] **Step 2: 写解析器失败测试 `tools/browser/tests/x.test.js`**（基于你 Step 1 保存的 fixture 的真实结构）

```js
import { test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseCommentsFromHtml } from "../src/platforms/x.js";

test("parseCommentsFromHtml extracts comment items", () => {
  const html = fs.readFileSync(path.resolve("tests/fixtures/x_comments.html"), "utf8");
  const items = parseCommentsFromHtml(html);
  expect(Array.isArray(items)).toBe(true);
  expect(items.length).toBeGreaterThan(0);
  // 按你 fixture 里第一条评论的真实内容断言（实现时填真实期望值）
  expect(items[0]).toHaveProperty("text");
  expect(items[0]).toHaveProperty("author");
});
```

> 注：`parseCommentsFromHtml(html)` 用一个 DOM 解析库（如内置 `linkedom`/或正则）从静态 HTML 抽取，便于无浏览器单测；`parseComments(page)` 在浏览器里滚动加载后取 `page.content()` 再喂它。Step 3 决定具体实现。

- [ ] **Step 3: 实现 `tools/browser/src/platforms/x.js`（用现场发现的真实选择器）**

实现以下导出（选择器以你 Step 1 现场试出的为准；下面是结构，**选择器占位需替换为现场验证值**）：
```js
import { linkedom } from "...";   // 或用正则/page 内 evaluate；实现者按 fixture 决定
import { actionDelay, typingIntervals, mousePath, sleep } from "../humanize.js";

export const loginUrl = "https://x.com/login";
export const homeUrl = "https://x.com/home";

export async function isLoggedIn(page) {
  // 现场验证：登录后侧边有 [data-testid="SideNav_AccountSwitcher_Button"] 之类
  return (await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').count()) > 0;
}

export async function post(page, { text, confirm }) {
  // 现场验证：compose 框 [data-testid="tweetTextarea_0"]，发布键 [data-testid="tweetButtonInline"]
  const box = page.locator('[data-testid="tweetTextarea_0"]');
  await box.click();
  for (const ch of text) { await box.pressSequentially(ch, { delay: 0 }); await sleep(typingIntervals(ch)[0]); }
  await sleep(actionDelay());
  if (!confirm) return { published: false, preview: text };
  await page.locator('[data-testid="tweetButtonInline"]').click();
  await sleep(actionDelay(1, 2));
  return { published: true };
}

export function parseCommentsFromHtml(html) {
  // 用 fixture 真实结构实现：抽取每条评论的 {author, text}
  // 实现者按保存的 DOM 写；返回数组
  // ...
}

export async function parseComments(page, max = 50) {
  // 滚动加载，定期取 page.content() → parseCommentsFromHtml，去重直到 max 或无更多
  // ...
}
```

> **实现纪律**：每个选择器都在现场（headed 真 X）用 `page.locator(sel).count()` 验证 > 0 才写进来；`isLoggedIn`/`post` 各跑一次真实验证（发一条测试推到自己小号，dry-run 先看预览再 --confirm）。

- [ ] **Step 4: 跑解析器单测**

Run: `cd tools/browser && npx vitest run tests/x.test.js`
Expected: PASS（基于真实 fixture）。

- [ ] **Step 5: 手动验证 X post（自有小号）**

```bash
node cli.js post --site x --text "test from meshbot browser skill"   # 先看预览
node cli.js post --site x --text "test from meshbot browser skill" --confirm   # 确认后发
```
Expected: 预览截图正确；--confirm 后推文真实发出。

- [ ] **Step 6: Commit**

```bash
git add tools/browser/src/platforms/x.js tools/browser/tests/fixtures/x_comments.html tools/browser/tests/x.test.js tools/browser/scripts/capture-x.js
git commit -m "feat(browser): X 适配器（isLoggedIn/post/评论解析）+ 现场 fixture 解析单测"
```

---

## Task 7：`src/comments.js`（评论落盘 + 摘要）+ cli 接入

**Files:**
- Create: `tools/browser/src/comments.js`
- Modify: `tools/browser/cli.js`
- Test: `tools/browser/tests/comments.test.js`

- [ ] **Step 1: 写失败测试 `tools/browser/tests/comments.test.js`**

```js
import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeCommentsFile } from "../src/comments.js";

test("writeCommentsFile writes json + returns summary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmt-"));
  const items = [{ author: "a", text: "好" }, { author: "b", text: "一般" }];
  const r = writeCommentsFile(items, { outDir: dir, site: "x" });
  expect(r.count).toBe(2);
  expect(fs.existsSync(r.file)).toBe(true);
  expect(JSON.parse(fs.readFileSync(r.file, "utf8"))).toHaveLength(2);
});
```

- [ ] **Step 2: 跑确认失败**

Run: `cd tools/browser && npx vitest run tests/comments.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 `tools/browser/src/comments.js`**

```js
import fs from "node:fs";
import path from "node:path";
import { launch, detectBlocked } from "./browser.js";

/** 把评论数组写 JSON 到 outDir，返回 {count,file,sample}。落盘时间戳由调用方传入（避免直接用 Date）。 */
export function writeCommentsFile(items, { outDir, site, stamp = "latest" }) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${site}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(items, null, 2), "utf8");
  return { count: items.length, file, sample: items.slice(0, 3) };
}

/** comments 动词：启 Chrome，导航 url，platform.parseComments → 落盘。 */
export async function comments({ profileDir: dir, platform, url, max = 50, outDir, stamp, headless = false }) {
  const { context, page } = await launch(dir, { headless });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const body = await page.innerText("body").catch(() => "");
    if (detectBlocked(body)) return { ok: false, reason: "BLOCKED: 疑似被反爬挡" };
    const items = await platform.parseComments(page, max);
    return { ok: true, ...writeCommentsFile(items, { outDir, site: "x", stamp }) };
  } finally {
    await context.close();
  }
}
```

- [ ] **Step 4: cli.js 接 comments 分支**

在 post 分支后加：
```js
  if (verb === "comments") {
    const { comments } = await import("./src/comments.js");
    const stamp = String(process.hrtime.bigint());   // 进程内单调时间戳，避免 Date
    const r = await comments({
      profileDir: dir, platform, url: flags.url,
      max: flags.max ? Number(flags.max) : 50,
      outDir: meshbotWorkspace(), stamp,
    });
    if (!r.ok) { console.error(`[comments] FAIL: ${r.reason}`); process.exit(1); }
    console.log(`[comments] ${r.count} 条 → ${r.file}\n样本: ${JSON.stringify(r.sample, null, 2)}`);
    process.exit(0);
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd tools/browser && npx vitest run tests/comments.test.js`
Expected: 1 passed。

- [ ] **Step 6: 手动验证 comments（你的某条推 url）**

Run: `node cli.js comments --site x --url <你某条推的链接> --max 30`
Expected: 打印 N 条 + 文件路径 + 样本；JSON 落到 `<meshbotDir>/workspace/browser/`。

- [ ] **Step 7: Commit**

```bash
git add tools/browser/src/comments.js tools/browser/tests/comments.test.js tools/browser/cli.js
git commit -m "feat(browser): comments 动词（评论落盘 + 摘要）+ 单测"
```

---

## Task 8：SKILL.md + 安装软链

**Files:**
- Create: `tools/browser/SKILL.md`
- Create: `tools/browser/install.js`

- [ ] **Step 1: 写 `tools/browser/SKILL.md`**

````markdown
---
name: browser
description: 用真实 Chrome 自动操作社交平台（发帖、看评论），登录态持久。当前支持 X。发帖默认只预览，需用户确认。
---

# browser skill

用系统真 Google Chrome（patchright 驱动，反检测）自动完成需登录的浏览器任务。登录态持久（每平台一个 profile），登录一次复用。**当前仅 X。**

## 前提
- 系统装了 Google Chrome（缺会报错）。
- 首次每平台需人工登录一次。

## 怎么用（`[skill dir]` 是 skill_load 返回的绝对路径）
- 登录（弹窗人工登录一次）：`node [skill dir]/cli.js login --site x`
- 看评论：`node [skill dir]/cli.js comments --site x --url <推文链接> --max 30`
  → 评论写到 `<meshbotDir>/workspace/browser/`，返回条数+路径+样本。
- 发帖（**两步，必须人在环**）：
  1. 预览：`node [skill dir]/cli.js post --site x --text "正文"` → 返回预览文本 + 截图路径，**不发布**。
  2. **把预览呈现给用户，得到明确确认后**才发布：`node [skill dir]/cli.js post --site x --text "正文" --confirm`

## 注意
- **发帖前必须先 dry-run 预览并让用户确认**，不要直接 `--confirm`。
- headed 默认（窗口可见）。无显示环境设 `BROWSER_AGENT_HEADLESS=1`（隐蔽性略降）。
- 被反爬挡时命令以非 0 退出并打印 `BLOCKED:`，不要反复重试硬刚。
- 仅操作用户自有账号，遵守平台 ToS / 速率。
````

- [ ] **Step 2: 写 `tools/browser/install.js`（软链进 `<meshbotDir>/skills/browser`）**

```js
#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = path.dirname(new URL(import.meta.url).pathname);
const base = process.env.MESHBOT_DIR || path.join(os.homedir(), ".meshbot");
const skillsDir = path.join(base, "skills");
const dest = path.join(skillsDir, "browser");

fs.mkdirSync(skillsDir, { recursive: true });
try {
  const st = fs.lstatSync(dest);
  if (st.isSymbolicLink() || st.isDirectory()) fs.rmSync(dest, { recursive: true, force: true });
} catch {}
fs.symlinkSync(src, dest, "dir");
console.log(`[install] linked ${dest} -> ${src}`);
console.log(`skill 'browser' 已装；重启 server-agent 后 skill_list 可见。`);
```

- [ ] **Step 3: 装并验证 skill 可见**

Run:
```bash
cd tools/browser && node install.js
ls -la "${MESHBOT_DIR:-$HOME/.meshbot}/skills/browser/SKILL.md"
```
Expected: 软链建立，SKILL.md 可达。（开发态如用 repo/.meshbot，先 `export MESHBOT_DIR=<repo>/.meshbot`。）

- [ ] **Step 4: Commit**

```bash
git add tools/browser/SKILL.md tools/browser/install.js
git commit -m "docs(browser): SKILL.md + 安装软链脚本"
```

---

## Task 9：反检测验收（intoli，headed，opt-in）

**Files:**
- Test: `tools/browser/tests/stealth.test.js`

- [ ] **Step 1: 写验收测试 `tools/browser/tests/stealth.test.js`**

```js
import { test, expect, describe } from "vitest";
import { launch } from "../src/browser.js";

const URL =
  "https://intoli.com/blog/not-possible-to-block-chrome-headless/chrome-headless-test.html";

describe.skipIf(!process.env.BROWSER_ONLINE)("stealth (headed)", () => {
  test("webdriver hidden + no webdriver failures", async () => {
    // 必须 headed：headless 会泄露 HeadlessChrome UA
    const { context, page } = await launch("/tmp/browser-skill-stealth", { headless: false });
    try {
      await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
      const wd = await page.evaluate(() => navigator.webdriver);
      expect(wd === false || wd === undefined).toBe(true);
      const failed = await page.$$eval(".failed", (els) => els.map((e) => e.id || e.innerText));
      expect(failed.join(" ").toLowerCase()).not.toContain("webdriver");
    } finally {
      await context.close();
    }
  });
});
```

- [ ] **Step 2: 跑验收（headed，需联网，手动 opt-in）**

Run: `cd tools/browser && BROWSER_ONLINE=1 npx vitest run tests/stealth.test.js`
Expected: 1 passed（spike 已证实 headed 下 0 webdriver 失败）。

- [ ] **Step 3: Commit**

```bash
git add tools/browser/tests/stealth.test.js
git commit -m "test(browser): 反检测验收（intoli, headed, opt-in）"
```

---

## 首切片三关验收（手动）

1. **纯单测**：`cd tools/browser && npm test` 全绿（args/humanize/browser-pure/cli/comments）。
2. **浏览器 e2e**：`BROWSER_E2E=1 npm run e2e` 全绿（真 Chrome 启动、webdriver 隐藏、post 骨架 dry-run/confirm）。
3. **反检测验收**：`BROWSER_ONLINE=1 npm run online` 绿（intoli headed）。
4. **真实 X 链路**（手动）：`login` → `comments --url …` 出评论 → `post`(预览) → 确认 → `post --confirm` 发出。

跨过即闭环；小红书/猫途鹰 = 加 `src/platforms/<p>.js` 适配器，零新机制。

---

## 迁移收尾（验证 OK 后）

- 删 `tools/browser-agent`（Python/Camoufox 版）+ 其 venv；旧 spec 标注 superseded。
- 本 skill 零 core 改动、无 mcp.json。

---

## Self-Review（计划对 spec 覆盖）

- skill 形态 + tools/browser + 软链装 `<meshbotDir>/skills/browser` → Task 0/8 ✓
- patchright 真 Chrome + Chrome 必装 + headed + 持久 profile → Task 3 ✓
- 动词 login/post/comments + dry-run/--confirm 护栏 → Task 4/5/7 ✓；SKILL.md 写明"先预览后确认" → Task 8 ✓
- humanize（延迟/打字/鼠标/限速）→ Task 2 ✓
- 被挡即停 detectBlocked → Task 3，post/comments 用之 → Task 5/7 ✓
- extract 落盘 `<meshbotDir>/workspace/browser/` → Task 7 ✓
- 反检测验收 headed intoli → Task 9 ✓
- 测试 vitest 分层（纯/e2e/online）→ 各任务 ✓
- **X 选择器现场发现**（不可盲写）→ Task 6 明确为"登录→试探→填→fixture 单测"，是计划里唯一依赖真实登录态的部分（诚实标注，非遗漏）
- 限速 RateLimiter 已实现（humanize），首切片动词内未强制接（跨次一次性进程较弱，spec 已注明 v1 流程内控节奏）——如需接，post/comments 调用前 `rl.allow(site)`。已显式说明。
