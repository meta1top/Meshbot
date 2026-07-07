import type { AccountContextService } from "@meshbot/agent";
import type { RemoteDeviceQueryService } from "../cloud/remote-device-query.service";
import type { RemoteRunService } from "../cloud/remote-run.service";
import { RemoteDeviceController } from "./remote-device.controller";

/**
 * 回归测试：confirm/answer 端点组装正确的控制帧委托给
 * `RemoteRunService.sendControl`；GET runs 按 streamId/sessionId
 * 分派到 Task 4 的 `findRunByStreamId`/`findRunBySession`。
 */
describe("RemoteDeviceController（confirm/answer/runs）", () => {
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
    const controller = new RemoteDeviceController(query, remoteRun, account);
    return { controller, remoteRun };
  };

  it("run/confirm → sendControl 组 confirm 帧", () => {
    const { controller, remoteRun } = makeController();
    controller.confirm("dB", {
      streamId: "st1",
      sessionId: "sess1",
      toolCallId: "tc1",
      decision: "send",
      content: "c",
    } as never);
    expect(remoteRun.sendControl).toHaveBeenCalledWith("u1", {
      streamId: "st1",
      targetDeviceId: "dB",
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
    controller.answer("dB", {
      streamId: "st1",
      sessionId: "sess1",
      toolCallId: "tc1",
      answers,
    } as never);
    expect(remoteRun.sendControl).toHaveBeenCalledWith("u1", {
      streamId: "st1",
      targetDeviceId: "dB",
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
    expect(controller.runs("dB", { streamId: "st1" } as never)).toEqual({
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
    expect(controller.runs("dB", { sessionId: "sess1" } as never)).toEqual({
      streamId: "st1",
      sessionId: "sess1",
    });
  });
});
