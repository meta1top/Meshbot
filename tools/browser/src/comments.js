import fs from "node:fs";
import path from "node:path";
import { detectBlocked, launch } from "./browser.js";

/** 把评论数组写 JSON 到 outDir，返回 {count,file,sample}。落盘时间戳由调用方传入（避免直接用 Date）。 */
export function writeCommentsFile(items, { outDir, site, stamp = "latest" }) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${site}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(items, null, 2), "utf8");
  return { count: items.length, file, sample: items.slice(0, 3) };
}

/** comments 动词：启 Chrome，导航 url，platform.parseComments → 落盘。 */
export async function comments({
  profileDir: dir,
  platform,
  url,
  max = 50,
  outDir,
  stamp,
  headless = false,
}) {
  const { context, page } = await launch(dir, { headless });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const body = await page.innerText("body").catch(() => "");
    if (detectBlocked(body))
      return { ok: false, reason: "BLOCKED: 疑似被反爬挡" };
    const items = await platform.parseComments(page, max);
    return {
      ok: true,
      ...writeCommentsFile(items, { outDir, site: "x", stamp }),
    };
  } finally {
    await context.close();
  }
}
