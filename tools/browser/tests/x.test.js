import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { launch } from "../src/browser.js";
import { extractTweets } from "../src/platforms/x.js";

// 用保存并 strip 掉 <script> 的真实 X 时间线 DOM（与回复同构 article[data-testid="tweet"]）
// 作 hermetic fixture：file:// 静态加载、不联网不登录，验证抽取选择器对真实 DOM 有效。
const FIXTURE = pathToFileURL(
  path.resolve("tests/fixtures/x_timeline.html"),
).href;

describe.skipIf(!process.env.BROWSER_E2E)(
  "x.extractTweets on saved fixture",
  () => {
    test("extracts tweet articles with author/handle/text", async () => {
      const { context, page } = await launch("/tmp/x-fixture-test", {
        headless: true,
      });
      try {
        await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
        const items = await extractTweets(page);
        expect(items.length).toBeGreaterThanOrEqual(3);
        expect(items[0].text.length).toBeGreaterThan(0);
        expect(items.some((i) => i.handle.startsWith("@"))).toBe(true);
      } finally {
        await context.close();
      }
    });
  },
);
