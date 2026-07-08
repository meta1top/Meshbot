import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCloudUrl } from "../../src/utils/cloud-url.js";

describe("resolveCloudUrl", () => {
  it("显式 MESHBOT_CLOUD_URL 最高优先级", () => {
    expect(
      resolveCloudUrl({
        env: { MESHBOT_CLOUD_URL: "https://x.example" },
        cwd: tmpdir(),
      }),
    ).toBe("https://x.example");
  });

  it("monorepo 源码内（有 pnpm-workspace.yaml）→ 本地 3200", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ws-"));
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []");
    const sub = path.join(root, "apps", "cli");
    expect(resolveCloudUrl({ env: {}, cwd: sub })).toBe(
      "http://127.0.0.1:3200",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("分发安装版（无 workspace 标记）→ 生产 api-bot.meta1.top", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dist-"));
    expect(resolveCloudUrl({ env: {}, cwd: dir })).toBe(
      "https://api-bot.meta1.top",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("config.cloudUrl 优先于自动判定", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dist-"));
    expect(
      resolveCloudUrl({
        env: {},
        cwd: dir,
        configCloudUrl: "https://self-hosted.example",
      }),
    ).toBe("https://self-hosted.example");
    rmSync(dir, { recursive: true, force: true });
  });

  it("env 优先于 config.cloudUrl", () => {
    expect(
      resolveCloudUrl({
        env: { MESHBOT_CLOUD_URL: "https://env.example" },
        configCloudUrl: "https://config.example",
      }),
    ).toBe("https://env.example");
  });
});
