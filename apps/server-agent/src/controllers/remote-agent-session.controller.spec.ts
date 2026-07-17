import type { AccountContextService } from "@meshbot/lib-agent";
import type { RemoteDeviceQueryService } from "../cloud/remote-device-query.service";
import type { RemoteRunService } from "../cloud/remote-run.service";
import { RemoteAgentSessionController } from "./remote-agent-session.controller";

/**
 * 回归测试：confirm/answer 端点组装正确的控制帧委托给
 * `RemoteRunService.sendControl`；GET runs 按 streamId/sessionId
 * 分派到 Task 4 的 `findRunByStreamId`/`findRunBySession`；
 * run/sessions 端点透传路径 agentId 作为寻址值 targetAgentId（Task 2）。
 */
describe("RemoteAgentSessionController（confirm/answer/runs）", () => {
  const makeController = () => {
    // 本组测试不触达 query（sessions/history 端点），bare mock 即可。
    const query = {} as RemoteDeviceQueryService;
    const remoteRun = {
      sendControl: jest.fn(),
      findRunByStreamId: jest.fn(),
      findRunBySession: jest.fn(),
    } as unknown as RemoteRunService;
    const account = {
      getOrThrow: () => "u1",
    } as AccountContextService;
    const controller = new RemoteAgentSessionController(
      query,
      remoteRun,
      account,
    );
    return { controller, remoteRun };
  };

  it("run/confirm → sendControl 组 confirm 帧", () => {
    const { controller, remoteRun } = makeController();
    controller.confirm("agentB", {
      streamId: "st1",
      sessionId: "sess1",
      toolCallId: "tc1",
      decision: "send",
      content: "c",
    } as never);
    expect(remoteRun.sendControl).toHaveBeenCalledWith("u1", {
      streamId: "st1",
      targetAgentId: "agentB",
      sessionId: "sess1",
      kind: "confirm",
      toolCallId: "tc1",
      decision: "send",
      content: "c",
    });
  });

  it("run/answer → sendControl 组 answer 帧", () => {
    const { controller, remoteRun } = makeController();
    const answers = [{ selected: ["A"], other: "o" }];
    controller.answer("agentB", {
      streamId: "st1",
      sessionId: "sess1",
      toolCallId: "tc1",
      answers,
    } as never);
    expect(remoteRun.sendControl).toHaveBeenCalledWith("u1", {
      streamId: "st1",
      targetAgentId: "agentB",
      sessionId: "sess1",
      kind: "answer",
      toolCallId: "tc1",
      answers,
    });
  });

  it("GET runs?streamId → findRunByStreamId", () => {
    const { controller, remoteRun } = makeController();
    (remoteRun.findRunByStreamId as jest.Mock).mockReturnValue({
      streamId: "st1",
      sessionId: "sess1",
    });
    expect(controller.runs("agentB", { streamId: "st1" } as never)).toEqual({
      streamId: "st1",
      sessionId: "sess1",
    });
  });

  it("GET runs?sessionId → findRunBySession", () => {
    const { controller, remoteRun } = makeController();
    (remoteRun.findRunBySession as jest.Mock).mockReturnValue({
      streamId: "st1",
      sessionId: "sess1",
    });
    expect(controller.runs("agentB", { sessionId: "sess1" } as never)).toEqual({
      streamId: "st1",
      sessionId: "sess1",
    });
  });

  it("POST run → startRun 收到路径 agentId 作为 targetAgentId", async () => {
    const query = {} as RemoteDeviceQueryService;
    const remoteRun = {
      startRun: jest.fn().mockReturnValue({ streamId: "st1" }),
    } as unknown as RemoteRunService;
    const account = { getOrThrow: () => "u1" } as AccountContextService;
    const controller = new RemoteAgentSessionController(
      query,
      remoteRun,
      account,
    );

    await controller.run("agentB", {
      mode: "create",
      sessionId: null,
      content: "hi",
    } as never);

    expect(remoteRun.startRun).toHaveBeenCalledWith(
      "u1",
      "agentB",
      "create",
      null,
      "hi",
    );
  });

  it("GET sessions → query.query 收到路径 agentId 作为 targetAgentId", async () => {
    const query = {
      query: jest.fn().mockResolvedValue([]),
    } as unknown as RemoteDeviceQueryService;
    const remoteRun = {} as RemoteRunService;
    const account = { getOrThrow: () => "u1" } as AccountContextService;
    const controller = new RemoteAgentSessionController(
      query,
      remoteRun,
      account,
    );

    await controller.sessions("agentB");

    expect(query.query).toHaveBeenCalledWith("u1", "agentB", "sessions", {});
  });
});
