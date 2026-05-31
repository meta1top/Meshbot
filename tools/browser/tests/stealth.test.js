import { describe, expect, test } from "vitest";
import { launch } from "../src/browser.js";

const URL =
  "https://intoli.com/blog/not-possible-to-block-chrome-headless/chrome-headless-test.html";

describe.skipIf(!process.env.BROWSER_ONLINE)("stealth (headed)", () => {
  test("webdriver hidden + no webdriver failures", async () => {
    // 必须 headed：headless 会泄露 HeadlessChrome UA
    const { context, page } = await launch("/tmp/browser-skill-stealth", {
      headless: false,
    });
    try {
      await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
      const wd = await page.evaluate(() => navigator.webdriver);
      expect(wd === false || wd === undefined).toBe(true);
      const failed = await page.$$eval(".failed", (els) =>
        els.map((e) => e.id || e.innerText),
      );
      expect(failed.join(" ").toLowerCase()).not.toContain("webdriver");
    } finally {
      await context.close();
    }
  });
});
