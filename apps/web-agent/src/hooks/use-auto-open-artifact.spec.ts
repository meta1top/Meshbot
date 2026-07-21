/**
 * @jest-environment jsdom
 */
// jotai 的 Provider/hooks 内部绑定着自己 node_modules 下解析到的 react 副本，
// 与 @testing-library/react 驱动渲染所用的 react-dom 不是同一份实例，混用会
// 在 renderHook 下炸「Cannot read properties of null (reading 'useRef')」
// （React hook dispatcher 按物理模块实例区分，双份 react 实例互不认识）。
// 本 hook 只用 useSetAtom 取 setter，不需要真实 store/Provider —— 桩掉整个
// jotai（同 use-global-events.spec.ts 的既有做法），真实 useEffect/useRef
// 仍走 react 本体，hook 生命周期照常被 renderHook 真实驱动。
// `atom` 也要桩（返回一个无意义占位对象即可）：`@/atoms/assistant-panel.ts`
// 同文件里其余 atom 声明在模块顶层调用真实 `atom(...)`，jotai 被整体替换后
// 不桩会在模块加载阶段就抛「atom is not a function」。
const setArtifact = jest.fn();
jest.mock("jotai", () => ({
  atom: jest.fn((init: unknown) => ({ init })),
  useSetAtom: jest.fn(() => setArtifact),
}));

import { renderHook } from "@testing-library/react";
import type { TimelineMessage } from "@/components/session/message-list";
import { useAutoOpenArtifact } from "./use-auto-open-artifact";

/**
 * 真机验收缺陷 3（主修）：`useAutoOpenArtifact` 原实现漏传 `remote`，远程会话
 * 的自动弹出产物恒走 `{path, agentId}` 本机分支——预览请求打在本机自己的
 * server-agent 上，本机 workspace 没有对端产出的文件，404 后被
 * `artifact-body.tsx` 归一成「产物已不存在或已变更」，排查方向被带偏到设备
 * 白名单上。
 */

/** 造一条携带 present_file 工具调用的时间线消息（其余字段本 hook 不读，桩最小集）。 */
function presentFileMessage(
  toolCallId: string,
  path: string,
  title?: string,
): TimelineMessage {
  return {
    id: `m-${toolCallId}`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        toolCallId,
        name: "present_file",
        status: "ok",
        args: { path, title },
      },
    ],
  } as TimelineMessage;
}

interface Props {
  messages: TimelineMessage[];
  running: boolean;
  agentId?: string;
  // 与 hook 签名一致：`remote` 必填（可为 null）。写成可选会让「调用点漏传」
  // 这个真实 bug（缺陷 3 的根因）在类型层悄悄过关——本文件正是守门的地方。
  remote: { deviceId: string; sessionId: string } | null;
}

function renderWithProps(initialProps: Props) {
  return renderHook(
    (props: Props) =>
      useAutoOpenArtifact(
        props.messages,
        props.running,
        props.agentId,
        props.remote,
      ),
    { initialProps },
  );
}

beforeEach(() => {
  setArtifact.mockClear();
});

describe("useAutoOpenArtifact（真机验收缺陷 3：远程会话产物预览打错机器）", () => {
  it("本机会话（remote 未传）→ setArtifact 走 {path,title,agentId}，不带 remote 字段", () => {
    renderWithProps({
      messages: [presentFileMessage("tc1", "a.md", "标题")],
      running: true,
      agentId: "agent-1",
      remote: null,
    });
    expect(setArtifact).toHaveBeenCalledTimes(1);
    const arg = setArtifact.mock.calls[0][0];
    expect(arg).toEqual({ path: "a.md", title: "标题", agentId: "agent-1" });
    expect(arg).not.toHaveProperty("remote");
  });

  it("远程会话（remote 已传）→ setArtifact 走 {path,title,remote}，不误带本机 agentId（主修点）", () => {
    const remote = { deviceId: "device-b", sessionId: "s1" };
    renderWithProps({
      messages: [presentFileMessage("tc1", "a.md", "标题")],
      running: true,
      // 刻意传一个非空 agentId：远程分支必须完全不使用它，否则回归成
      // 「本机 path 源打在自己 server-agent 上」的原 bug。
      agentId: "should-be-ignored-when-remote",
      remote,
    });
    expect(setArtifact).toHaveBeenCalledTimes(1);
    const arg = setArtifact.mock.calls[0][0];
    expect(arg).toEqual({ path: "a.md", title: "标题", remote });
    expect(arg).not.toHaveProperty("agentId");
  });

  it("running=false（历史加载/切会话）→ 远程会话也不自动弹（不打扰历史查看）", () => {
    renderWithProps({
      messages: [presentFileMessage("tc1", "a.md")],
      running: false,
      remote: { deviceId: "device-b", sessionId: "s1" },
    });
    expect(setArtifact).not.toHaveBeenCalled();
  });

  it("同一产物（toolCallId）已 seen → 不重复弹出，即使 running 仍为 true", () => {
    const remote = { deviceId: "device-b", sessionId: "s1" };
    const messages = [presentFileMessage("tc1", "a.md")];
    const { rerender } = renderWithProps({ messages, running: true, remote });
    expect(setArtifact).toHaveBeenCalledTimes(1);
    // 同一条 toolCallId 再次出现（如轮询/重渲染带来的相同内容）
    rerender({ messages: [...messages], running: true, remote });
    expect(setArtifact).toHaveBeenCalledTimes(1);
  });

  it("远程会话里没有新产物（streaming 状态的工具调用）→ 不弹，不误判", () => {
    const remote = { deviceId: "device-b", sessionId: "s1" };
    const streamingMessage: TimelineMessage = {
      id: "m1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          toolCallId: "tc1",
          name: "present_file",
          status: "streaming",
          argsText: '{"path":"a.',
        },
      ],
    } as TimelineMessage;
    renderWithProps({ messages: [streamingMessage], running: true, remote });
    expect(setArtifact).not.toHaveBeenCalled();
  });
});
