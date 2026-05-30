import { describe, expect, test } from "vitest";
import { detectBlocked, launch, profileDir } from "../src/browser.js";

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
    const { context, page } = await launch("/tmp/browser-skill-test", {
      headless: true,
    });
    try {
      await page.goto("about:blank");
      const wd = await page.evaluate(() => navigator.webdriver);
      expect(wd === false || wd === undefined).toBe(true);
    } finally {
      await context.close();
    }
  });
});
