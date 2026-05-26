import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { GraphService } from "../../src/graph/graph.service";
import { PromptService } from "../../src/prompt/prompt.service";
import { ToolRegistry } from "../../src/tools/tool-registry";

describe("GraphService compaction hooks", () => {
  let testDir: string;
  let graphService: GraphService;
  let invokeCalls: { messages: { content: string }[]; config: unknown }[];

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-compact-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    const configService = new MeshbotConfigService();
    (configService as unknown as Record<string, string>).meshbotDir = testDir;
    const promptService = new PromptService(testDir);
    invokeCalls = [];
    const fakeModel = {
      stream: async () => {
        async function* gen() {
          yield new AIMessage({ id: "fake-a", content: "stream-ack" });
        }
        return gen();
      },
      invoke: async (messages: { content: string }[], config?: unknown) => {
        invokeCalls.push({ messages, config });
        return new AIMessage({ id: "summary-resp", content: "MOCK_SUMMARY" });
      },
    };
    const toolRegistry = new ToolRegistry({ getProviders: () => [] } as never);
    graphService = new GraphService(
      configService,
      promptService,
      toolRegistry,
      new EventEmitter2(),
      () => Promise.resolve(fakeModel as never),
      { providerType: "fake", model: "fake-model" },
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("getMessagesSnapshot 空 thread 返空数组", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    const msgs = await graphService.getMessagesSnapshot(threadId);
    expect(msgs).toEqual([]);
  });

  it("getMessagesSnapshot 在 streamMessage 后返非空", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    for await (const _ of graphService.streamMessage(threadId, [
      { id: "h1", content: "hi" },
    ])) {
      // drain
    }
    const msgs = await graphService.getMessagesSnapshot(threadId);
    expect(msgs.length).toBeGreaterThan(0);
  });

  it("summarize 调 model.invoke 传 system + user 并返字符串", async () => {
    const out = await graphService.summarize("[user] hi\n[assistant] hello", {
      systemPrompt: "SYS",
      timeoutMs: 1000,
      maxTokens: 100,
    });
    expect(out).toBe("MOCK_SUMMARY");
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].messages[0].content).toBe("SYS");
    expect(invokeCalls[0].messages[1].content).toContain("hi");
  });

  it("applyCompaction 删指定 id + 注入新 SystemMessage", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    for await (const _ of graphService.streamMessage(threadId, [
      { id: "h1", content: "hi" },
    ])) {
      // drain
    }
    const before = await graphService.getMessagesSnapshot(threadId);
    const ids = before
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    expect(ids.length).toBeGreaterThan(0);

    await graphService.applyCompaction(threadId, {
      removeIds: ids,
      summaryText: "COMPRESSED_SUMMARY",
    });

    const after = await graphService.getMessagesSnapshot(threadId);
    // 原 messages 已被 RemoveMessage 删，只剩注入的 SystemMessage
    const summaryRows = after.filter(
      (m) =>
        m._getType() === "system" &&
        typeof m.content === "string" &&
        m.content.includes("COMPRESSED_SUMMARY"),
    );
    expect(summaryRows.length).toBe(1);
    // 原 id 应该不在 after 里
    for (const id of ids) {
      expect(after.find((m) => m.id === id)).toBeUndefined();
    }
  });
});
