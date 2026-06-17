import { type CandidateMessage, latestAssistantCandidate } from "./companion";

const m = (
  p: Partial<CandidateMessage> & { role: CandidateMessage["role"] },
): CandidateMessage => ({
  content: "",
  ...p,
});

describe("latestAssistantCandidate", () => {
  it("空列表返回 null", () => {
    expect(latestAssistantCandidate([])).toBeNull();
  });
  it("取最后一条已定稿 assistant 的 content", () => {
    expect(
      latestAssistantCandidate([
        m({ role: "user", content: "在吗" }),
        m({ role: "assistant", content: "第一版" }),
        m({ role: "user", content: "再改改" }),
        m({ role: "assistant", content: "第二版" }),
      ]),
    ).toBe("第二版");
  });
  it("跳过 streaming / loading / failed / 空内容的 assistant", () => {
    expect(
      latestAssistantCandidate([
        m({ role: "assistant", content: "已定稿" }),
        m({ role: "assistant", content: "流式中", streaming: true }),
        m({ role: "assistant", content: "", loading: true }),
        m({ role: "assistant", content: "失败了", failed: true }),
        m({ role: "assistant", content: "   " }),
      ]),
    ).toBe("已定稿");
  });
  it("只有 user 消息返回 null", () => {
    expect(
      latestAssistantCandidate([m({ role: "user", content: "x" })]),
    ).toBeNull();
  });
});
