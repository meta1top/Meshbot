import { launch } from "./browser.js";
import { sleep } from "./humanize.js";

/** login 动词：headed 启 Chrome，导航登录页，轮询 isLoggedIn 直到成功或超时（用户人工登录）。 */
export async function login({ profileDir: dir, platform, timeoutS = 300 }) {
  const { context, page } = await launch(dir, { headless: false });
  try {
    await page.goto(platform.homeUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    if (await platform.isLoggedIn(page)) return { ok: true, already: true };
    await page.goto(platform.loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
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
