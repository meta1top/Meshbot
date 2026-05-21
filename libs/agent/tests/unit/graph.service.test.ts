import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AIMessageChunk } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { GraphService } from "../../src/graph/graph.service";
import { PromptService } from "../../src/prompt/prompt.service";

describe("GraphService", () => {
  let testDir: string;
  let graphService: GraphService;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-graph-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    const configService = new MeshbotConfigService();
    (configService as unknown as Record<string, string>).meshbotDir = testDir;
    const promptService = new PromptService(testDir);
    // fakeModel 用 stream() 逐 token yield AIMessageChunk —— 与 supervisor 节点一致，
    // 各 chunk 共享同一 id，验证 streamMode:"messages" 下管道连通 + messageId 稳定。
    const fakeModel = {
      stream: async () => {
        async function* gen() {
          for (const c of ["你", "好"]) {
            yield new AIMessageChunk({ id: "fixed-msg-id", content: c });
          }
        }
        return gen();
      },
    };
    graphService = new GraphService(configService, promptService, () =>
      Promise.resolve(fakeModel as never),
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("starts a session and returns thread id", async () => {
    const threadId = await graphService.startSession({ model: "gpt-4" });
    expect(typeof threadId).toBe("string");
    expect(threadId.length).toBeGreaterThan(0);
  });

  it("streamMessage 逐 chunk 产出 token 与稳定 messageId", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    const chunks: { messageId: string; delta: string }[] = [];
    for await (const ev of graphService.streamMessage(threadId, "hi")) {
      chunks.push(ev);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.messageId === chunks[0].messageId)).toBe(true);
    expect(chunks.map((c) => c.delta).join("")).toBe("你好");
  });

  it("returns history after streamMessage", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    for await (const _ev of graphService.streamMessage(threadId, "hi")) {
      // 仅消费流以驱动 checkpointer 落盘
    }
    const history = await graphService.getHistory(threadId);
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
  });
});
