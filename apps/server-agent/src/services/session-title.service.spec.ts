import { type SessionSummary, SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SessionTitleService } from "./session-title.service";

/** 收集 emit 事件的 EventEmitter2 wrapper。 */
function spyEmitter() {
  const events: { name: string; payload: unknown }[] = [];
  const emitter = new EventEmitter2();
  emitter.onAny((name, payload) =>
    events.push({ name: String(name), payload }),
  );
  return { emitter, events };
}

/** 内存版 SessionService 替身（仅实现 SessionTitleService 用到的 2 个方法）。 */
function fakeSessionService(initialTitleGenerated = false) {
  const summary: SessionSummary = {
    id: "s1",
    title: "old",
    status: "idle",
    pinned: false,
    pinnedAt: null,
    titleGenerated: initialTitleGenerated,
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
  return {
    summary,
    async findSessionOrFail() {
      return summary;
    },
    async patchIfNotGenerated(_id: string, title: string) {
      if (summary.titleGenerated) return null;
      summary.title = title;
      summary.titleGenerated = true;
      return { ...summary };
    },
  };
}

/** 假 PromptService —— 仅 getPrompt。 */
function fakePromptService(content?: string) {
  return {
    getPrompt(_name: string) {
      return content;
    },
  };
}

/** 假 GraphService —— 仅 getTitleModel，返一个 invoke 假 model。 */
function fakeGraph(content: string) {
  return {
    async getTitleModel() {
      return {
        async invoke(_prompt: string) {
          return { content };
        },
      };
    },
  };
}

function fakeGraphError(err: Error) {
  return {
    async getTitleModel() {
      return {
        async invoke(_prompt: string) {
          throw err;
        },
      };
    },
  };
}

/** 等所有 fire-and-forget setImmediate 跑完。 */
async function flushPromises(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("SessionTitleService", () => {
  it("LLM 返清晰 title → patchIfNotGenerated + emit titleUpdated", async () => {
    const sess = fakeSessionService();
    const { emitter, events } = spyEmitter();
    const svc = new SessionTitleService(
      fakeGraph("会话标题") as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    svc.schedule("s1", "first user content");
    await flushPromises();
    expect(sess.summary.title).toBe("会话标题");
    expect(sess.summary.titleGenerated).toBe(true);
    expect(events.map((e) => e.name)).toContain(SESSION_WS_EVENTS.titleUpdated);
    const evt = events.find((e) => e.name === SESSION_WS_EVENTS.titleUpdated);
    expect(evt?.payload).toEqual({ sessionId: "s1", title: "会话标题" });
  });

  it("LLM 返空白 → 不写库 + 不 emit", async () => {
    const sess = fakeSessionService();
    const { emitter, events } = spyEmitter();
    const svc = new SessionTitleService(
      fakeGraph("   \n  ") as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    svc.schedule("s1", "content");
    await flushPromises();
    expect(sess.summary.title).toBe("old");
    expect(sess.summary.titleGenerated).toBe(false);
    expect(
      events.find((e) => e.name === SESSION_WS_EVENTS.titleUpdated),
    ).toBeUndefined();
  });

  it("LLM 返带引号 → sanitize 后写库", async () => {
    const sess = fakeSessionService();
    const { emitter } = spyEmitter();
    const svc = new SessionTitleService(
      fakeGraph('"quoted title"') as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    svc.schedule("s1", "content");
    await flushPromises();
    expect(sess.summary.title).toBe("quoted title");
  });

  it("LLM 返 > 30 字 → 硬截断", async () => {
    const sess = fakeSessionService();
    const { emitter } = spyEmitter();
    const long = "a".repeat(50);
    const svc = new SessionTitleService(
      fakeGraph(long) as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    svc.schedule("s1", "content");
    await flushPromises();
    expect(sess.summary.title.length).toBe(30);
  });

  it("入口 titleGenerated 已 true → 不调 LLM", async () => {
    const sess = fakeSessionService(true);
    const { emitter, events } = spyEmitter();
    let invoked = false;
    const svc = new SessionTitleService(
      {
        async getTitleModel() {
          return {
            async invoke() {
              invoked = true;
              return { content: "shouldn't run" };
            },
          };
        },
      } as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    svc.schedule("s1", "content");
    await flushPromises();
    expect(invoked).toBe(false);
    expect(sess.summary.title).toBe("old");
    expect(
      events.find((e) => e.name === SESSION_WS_EVENTS.titleUpdated),
    ).toBeUndefined();
  });

  it("LLM 期间外部 mark titleGenerated=true → patchIfNotGenerated 返 null → 不 emit", async () => {
    const sess = fakeSessionService();
    const { emitter, events } = spyEmitter();
    // 模拟 race：findSessionOrFail 看到 false 通过、然后 LLM invoke 期间用户改名
    // → patchIfNotGenerated 看到 titleGenerated=true 返 null → 不 emit。
    const svc = new SessionTitleService(
      {
        async getTitleModel() {
          return {
            async invoke(_prompt: string) {
              // LLM "调用" 期间外部改 titleGenerated=true（模拟用户改名落库）
              sess.summary.titleGenerated = true;
              sess.summary.title = "user 改的";
              return { content: "LLM 想覆盖" };
            },
          };
        },
      } as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    svc.schedule("s1", "content");
    await flushPromises();
    expect(sess.summary.title).toBe("user 改的");
    expect(
      events.find((e) => e.name === SESSION_WS_EVENTS.titleUpdated),
    ).toBeUndefined();
  });

  it("LLM 抛错 → schedule 不抛、不 emit", async () => {
    const sess = fakeSessionService();
    const { emitter, events } = spyEmitter();
    const svc = new SessionTitleService(
      fakeGraphError(new Error("network")) as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    expect(() => svc.schedule("s1", "content")).not.toThrow();
    await flushPromises();
    expect(sess.summary.title).toBe("old");
    expect(
      events.find((e) => e.name === SESSION_WS_EVENTS.titleUpdated),
    ).toBeUndefined();
  });

  it("PromptService 返 prompt → buildPrompt 用模板替换 {{content}}", async () => {
    const sess = fakeSessionService();
    const { emitter } = spyEmitter();
    let capturedPrompt = "";
    const svc = new SessionTitleService(
      {
        async getTitleModel() {
          return {
            async invoke(prompt: string) {
              capturedPrompt = prompt;
              return { content: "T" };
            },
          };
        },
      } as never,
      sess as never,
      fakePromptService("Title: {{content}}") as never,
      emitter,
    );
    svc.schedule("s1", "USER MSG");
    await flushPromises();
    expect(capturedPrompt).toBe("Title: USER MSG");
  });
});
