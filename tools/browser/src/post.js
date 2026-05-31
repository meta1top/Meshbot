import os from "node:os";
import path from "node:path";
import { detectBlocked, launch } from "./browser.js";

/**
 * post 动词：用持久 profile 启 Chrome，确认已登录，调 platform.post。
 * confirm=false（默认）→ 填内容、截图、返回预览，不发布。
 * confirm=true → 发布。
 */
export async function post({
  profileDir: dir,
  platform,
  text,
  images = [],
  confirm = false,
  headless = false,
}) {
  const { context, page } = await launch(dir, { headless });
  try {
    await page.goto(platform.homeUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    if (!(await platform.isLoggedIn(page)))
      return { ok: false, reason: "未登录，请先 login" };
    const body = await page.innerText("body").catch(() => "");
    if (detectBlocked(body))
      return { ok: false, reason: "BLOCKED: 疑似被反爬挡" };

    const r = await platform.post(page, { text, images, confirm });
    if (!confirm) {
      const shot = path.join(
        os.tmpdir(),
        `browser-post-preview-${process.pid}.png`,
      );
      await page.screenshot({ path: shot });
      return {
        ok: true,
        published: false,
        preview: r.preview ?? text,
        screenshot: shot,
      };
    }
    return { ok: true, published: true };
  } finally {
    await context.close();
  }
}
