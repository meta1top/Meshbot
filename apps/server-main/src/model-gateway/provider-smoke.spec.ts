import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Provider 构建期冒烟测（不联网）——jest 外壳。
 *
 * 真实断言在 provider-smoke.runner.mjs（独立 Node 子进程）：
 * langchain 1.x 的 `initChatModel` 内部用原生动态 `import()` 加载厂商包，
 * jest 的 CJS VM 沙箱不支持（"A dynamic import callback was invoked without
 * --experimental-vm-modules"），而 Node 运行时原生支持——生产路径无碍。
 * 为保住「真的去动态 import 厂商包」这一冒烟测的全部价值（typecheck 对
 * initChatModel 的 Partial<Record<string,any>> 签名完全失明），断言下沉到
 * 子进程跑真实运行时，jest 只负责调起与判定。
 *
 * runner 覆盖：5 provider 构建（动态 import / invoke / stream / bindTools）
 * + openai/deepseek 两条 configuration.fetch 接线（云网关地基）。
 */
describe("provider 构建期冒烟（不联网，子进程真实运行时）", () => {
  it("runner 7 条断言全 PASS（5 构建 + 2 fetch 线）", () => {
    const runner = join(__dirname, "provider-smoke.runner.mjs");
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, [runner], {
        encoding: "utf8",
        timeout: 60_000,
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(
        `provider-smoke runner 失败：\n${err.stdout ?? ""}\n${err.stderr ?? ""}`,
      );
    }
    const passes = stdout.match(/^PASS /gm) ?? [];
    const fails = stdout.match(/^FAIL .*/gm) ?? [];
    expect(fails).toEqual([]);
    expect(passes).toHaveLength(7);
  });
});
