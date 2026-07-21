import { resolveRemoteSessionHeaderView } from "./remote-session-header";

const agent = {
  name: "研究助手",
  avatar: "🤖|#f97316",
  deviceName: "小明的 MacBook",
};
const session = { title: "聊聊季度计划" };
const fallbackTitle = "远程会话";

describe("resolveRemoteSessionHeaderView（真机验收缺陷 2：远程会话标题栏写死）", () => {
  it("agent + session 都已到位 → 真实 Agent 身份 + 真实会话标题", () => {
    const view = resolveRemoteSessionHeaderView({
      agent,
      session,
      fallbackTitle,
    });
    expect(view).toEqual({
      title: "聊聊季度计划",
      agent: {
        name: "研究助手",
        avatar: "🤖|#f97316",
        deviceName: "小明的 MacBook",
      },
    });
  });

  it("agent 未到位（远程 Agent 列表还在拉 / 未命中该 id）→ agent: null，但标题仍用真实 session 标题", () => {
    const view = resolveRemoteSessionHeaderView({
      agent: undefined,
      session,
      fallbackTitle,
    });
    expect(view.agent).toBeNull();
    expect(view.title).toBe("聊聊季度计划");
  });

  it("session 未到位（该远程 Agent 会话列表还没加载完 / 该会话尚未出现）→ 标题降级为 fallbackTitle，不是空字符串", () => {
    const view = resolveRemoteSessionHeaderView({
      agent,
      session: undefined,
      fallbackTitle,
    });
    expect(view.title).toBe(fallbackTitle);
    expect(view.title).not.toBe("");
    // agent 身份信息不受 session 未到位影响，能显示的先显示
    expect(view.agent).toEqual(agent);
  });

  it("agent 和 session 都未到位（原 bug 的起始态，现在只是过渡态）→ 降级为 fallbackTitle + 无身份徽标，不空白", () => {
    const view = resolveRemoteSessionHeaderView({
      agent: undefined,
      session: undefined,
      fallbackTitle,
    });
    expect(view).toEqual({ title: fallbackTitle, agent: null });
  });

  it("session.title 为空字符串（合法但边界值）→ 视为「未到位」以外的真实值，不被 fallback 顶替", () => {
    // ?? 只在 null/undefined 时才落到 fallback，空字符串标题本身不该发生
    // （会话标题不可能持久化成空串），但显式验证一次 ?? 的语义边界。
    const view = resolveRemoteSessionHeaderView({
      agent,
      session: { title: "" },
      fallbackTitle,
    });
    expect(view.title).toBe("");
  });
});
