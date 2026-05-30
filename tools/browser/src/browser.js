import path from "node:path";
import { chromium } from "patchright";

const BLOCK_MARKERS = [
  "captcha",
  "verify you are human",
  "are you a robot",
  "access denied",
  "checking your browser",
  "请完成安全验证",
  "请稍候",
];

/** 解析账号 profile 目录，拒绝路径穿越。 */
export function profileDir(root, name) {
  if (
    name.includes("/") ||
    name.includes("\\") ||
    ["", ".", ".."].includes(name)
  ) {
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
          "装好 Chrome 后重试。原始错误：" +
          e.message,
      );
    }
    throw e;
  }
  const page = context.pages()[0] || (await context.newPage());
  return { context, page };
}
