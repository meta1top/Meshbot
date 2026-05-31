import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { launch } from "../src/browser.js";

const FIXTURE = pathToFileURL(path.resolve("tests/fixtures/compose.html")).href;

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
    const { context, page } = await launch("/tmp/browser-skill-post", {
      headless: true,
    });
    try {
      await page.goto(FIXTURE);
      const r = await fixturePlatform.post(page, {
        text: "hi",
        confirm: false,
      });
      expect(r.published).toBe(false);
      expect(await page.inputValue("#editor")).toBe("hi");
      expect(await page.innerText("#done")).toBe("");
    } finally {
      await context.close();
    }
  });

  test("confirm publishes", async () => {
    const { context, page } = await launch("/tmp/browser-skill-post", {
      headless: true,
    });
    try {
      await page.goto(FIXTURE);
      await fixturePlatform.post(page, { text: "hi", confirm: true });
      expect(await page.innerText("#done")).toBe("published");
    } finally {
      await context.close();
    }
  });
});
