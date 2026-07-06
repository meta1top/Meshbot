import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * 启动本地打包产物（desktop），注入 MESHBOT_CLOUD_URL 便于本地测试。
 *
 * 为什么不用双击 / `open`：macOS 双击/`open` 不继承 shell env，
 * MESHBOT_CLOUD_URL 传不进去；直接跑 .app 内的二进制才会继承。
 *
 * cloud URL：优先取环境变量 MESHBOT_CLOUD_URL，默认与 dev server-agent 一致
 * （127.0.0.1:3200），这样打包版可与 dev 连同一个 server-main、在同一台机器上
 * 模拟「两台设备（dev 数据目录 repo/.meshbot + 打包 ~/.meshbot）+ 同账号」。
 *
 * 用法：
 *   pnpm pkg:app                          # 先打包
 *   pnpm run:local                        # 连 127.0.0.1:3200
 *   MESHBOT_CLOUD_URL=https://api.meshbot.app pnpm run:local  # 覆盖
 */
const CLOUD_URL = process.env.MESHBOT_CLOUD_URL ?? "http://127.0.0.1:3200";
const releaseDir = path.resolve(process.cwd(), "apps/desktop/release");

/** 按平台/arch 定位打包出的可执行文件（未找到返回 null）。 */
function resolveBinary(): string | null {
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    const dirs =
      process.arch === "arm64" ? ["mac-arm64", "mac"] : ["mac", "mac-arm64"];
    for (const d of dirs)
      candidates.push(
        path.join(releaseDir, d, "Meshbot.app/Contents/MacOS/Meshbot"),
      );
  } else if (process.platform === "win32") {
    candidates.push(path.join(releaseDir, "win-unpacked", "Meshbot.exe"));
  } else {
    candidates.push(path.join(releaseDir, "linux-unpacked", "meshbot"));
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

const bin = resolveBinary();
if (!bin) {
  console.error(
    `未找到本地打包产物。先执行 \`pnpm pkg:app\` 打包。\n查找目录：${releaseDir}`,
  );
  process.exit(1);
}

console.log(`启动本地产物：${bin}`);
console.log(`MESHBOT_CLOUD_URL=${CLOUD_URL}`);
const res = spawnSync(bin, [], {
  stdio: "inherit",
  env: { ...process.env, MESHBOT_CLOUD_URL: CLOUD_URL },
});
process.exit(res.status ?? 0);
