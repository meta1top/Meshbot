#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { parseArgs } from "./src/args.js";
import { profileDir } from "./src/browser.js";
import { login } from "./src/login.js";
import { resolvePlatform } from "./src/platforms/index.js";

const PROFILES_ROOT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "profiles",
);

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
    console.log(
      r.ok
        ? `[login] ok${r.already ? "（已登录）" : ""}`
        : `[login] FAIL: ${r.reason}`,
    );
    process.exit(r.ok ? 0 : 1);
  }
  if (verb === "post") {
    const { post } = await import("./src/post.js");
    const r = await post({
      profileDir: dir,
      platform,
      text: flags.text || "",
      images: flags.image ? [].concat(flags.image) : [],
      confirm: flags.confirm === true,
    });
    if (!r.ok) {
      console.error(`[post] FAIL: ${r.reason}`);
      process.exit(1);
    }
    if (r.published) console.log("[post] 已发布");
    else
      console.log(
        `[post] 预览（未发布）:\n${r.preview}\n截图: ${r.screenshot}\n确认后加 --confirm 重跑发布`,
      );
    process.exit(0);
  }
  // comments 在 Task 7 接入
  console.error(`未实现的 verb: ${verb}`);
  process.exit(2);
}

main().catch((e) => {
  console.error("[browser] ERROR:", e.message);
  process.exit(1);
});
