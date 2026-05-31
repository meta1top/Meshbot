import { actionDelay, sleep, typingIntervals } from "../humanize.js";

export const loginUrl = "https://x.com/login";
export const homeUrl = "https://x.com/home";

// 登录态主导航元素（仅登录后存在）。实测：登出态这些 testid count 全为 0，
// 故"任一存在"= 已登录。URL 判断不可靠（登出态会落在 https://x.com/ 根，不含 /login）。
const LOGGED_IN_MARKERS = [
  '[data-testid="SideNav_AccountSwitcher_Button"]',
  '[data-testid="SideNav_NewTweet_Button"]',
  '[data-testid="AppTabBar_Home_Link"]',
];

// 首页内联发帖框 + 发布键（实测 home 上 count 各为 1）。
const COMPOSE_BOX = '[data-testid="tweetTextarea_0"]';
const PUBLISH_BTN = '[data-testid="tweetButtonInline"]';

/** 真实登录态判断：等任一登录态主导航元素出现（最长 ~4s），出现即已登录。 */
export async function isLoggedIn(page) {
  try {
    await page.waitForSelector(LOGGED_IN_MARKERS.join(", "), { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 在首页内联发帖框发推。confirm=false 仅填内容（不发，供预览）；confirm=true 点发布。
 * 调用方（post.js）已先 goto homeUrl 并校验登录态。
 */
export async function post(page, { text, confirm = false }) {
  // images：首切片纯文本，post.js 会传 images 但此处暂不处理（后补）。
  const box = page.locator(COMPOSE_BOX).first();
  await box.waitFor({ timeout: 15000 });
  await box.click();
  await sleep(actionDelay(0.3, 0.9));
  const intervals = typingIntervals(text);
  let i = 0;
  for (const ch of text) {
    await box.pressSequentially(ch, { delay: 0 });
    await sleep(intervals[i++] ?? 0.05);
  }
  await sleep(actionDelay(0.4, 1.0));
  if (!confirm) return { published: false, preview: text };
  const btn = page.locator(PUBLISH_BTN).first();
  await btn.waitFor({ state: "visible", timeout: 10000 });
  // click 自带 enabled 可点等待（正文为空时按钮 disabled，此处已输入故可点）。
  await btn.click();
  // 不轻信点击：发布成功后首页内联框会清空——等它清空才算真发出；
  // 否则（按钮没生效/发布失败）这里抛超时，由上层报错，绝不假报 published。
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return el && (el.innerText || "").trim() === "";
    },
    COMPOSE_BOX,
    { timeout: 10000 },
  );
  await sleep(actionDelay(0.5, 1.2));
  return { published: true };
}

// 在页面内抽取推文/回复条目。回复页与时间线同构：article[data-testid="tweet"]。
// User-Name 的 innerText 形如 "显示名\n@handle\n·\n时间"；tweetText 是正文。
function extractInPage() {
  const arts = Array.from(
    document.querySelectorAll('article[data-testid="tweet"]'),
  );
  return arts
    .map((a) => {
      const un = a.querySelector('[data-testid="User-Name"]');
      const unText = un ? un.innerText || "" : "";
      const name = unText.split("\n")[0].trim();
      const hm = unText.match(/@\w+/);
      const tx = a.querySelector('[data-testid="tweetText"]');
      return {
        author: name,
        handle: hm ? hm[0] : "",
        text: tx ? (tx.innerText || "").trim() : "",
      };
    })
    .filter((r) => r.text || r.author);
}

/** 把当前页面里的推文/回复条目抽成 [{author, handle, text}]（供 parseComments 与单测共用）。 */
export async function extractTweets(page) {
  return page.evaluate(extractInPage);
}

/**
 * 拉取评论：调用方已 goto 目标推文 url。滚动加载、去重收集，直到 max 或连续 3 轮无新增。
 * 注：状态页首条 article 是原推本身，其余为回复。
 */
export async function parseComments(page, max = 50) {
  await page
    .waitForSelector('article[data-testid="tweet"]', { timeout: 15000 })
    .catch(() => {});
  const seen = new Set();
  const out = [];
  let stale = 0;
  while (out.length < max && stale < 3) {
    const batch = await extractTweets(page);
    let added = 0;
    for (const r of batch) {
      const key = `${r.handle}|${r.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(r);
        added += 1;
      }
    }
    stale = added === 0 ? stale + 1 : 0;
    if (out.length >= max) break;
    await page.mouse.wheel(0, 2200);
    await sleep(actionDelay(0.8, 1.6));
  }
  return out.slice(0, max);
}
