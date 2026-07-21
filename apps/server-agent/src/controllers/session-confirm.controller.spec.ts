import type { AccountContextService } from "@meshbot/lib-agent";
import { ConfirmationService } from "../services/confirmation.service";
import { SessionController } from "./session.controller";

describe("SessionController.confirm", () => {
  it("按 cloudUserId:sessionId:toolCallId resolve，透传 decision+content，meta.by='local'（Task 17 关卡广播）", () => {
    const confirmation = new ConfirmationService({ emit: jest.fn() } as never);
    const resolveSpy = jest
      .spyOn(confirmation, "resolve")
      .mockReturnValue(true);
    const account = { getOrThrow: () => "u1" } as AccountContextService;
    // 仅注入本端点用到的依赖；其余传 undefined（该方法不触达）。
    const ctrl = Object.assign(Object.create(SessionController.prototype), {
      confirmation,
      account,
    }) as SessionController;

    const res = ctrl.confirm("s1", {
      toolCallId: "tc1",
      decision: "send",
      content: "改后",
    } as never);

    expect(res).toEqual({ ok: true });
    expect(resolveSpy).toHaveBeenCalledWith(
      "u1:s1:tc1",
      { action: "send", content: "改后" },
      { sessionId: "s1", toolCallId: "tc1", by: "local" },
    );
  });
});

describe("SessionController.answer", () => {
  it("按 cloudUserId:sessionId:toolCallId resolve，透传 answers，meta.by='local'（Task 17 关卡广播）", () => {
    const confirmation = new ConfirmationService({ emit: jest.fn() } as never);
    const resolveSpy = jest
      .spyOn(confirmation, "resolve")
      .mockReturnValue(true);
    const account = { getOrThrow: () => "u1" } as AccountContextService;
    const ctrl = Object.assign(Object.create(SessionController.prototype), {
      confirmation,
      account,
    }) as SessionController;

    const answers = [{ selected: ["A"], other: undefined }];
    const res = ctrl.answer("s1", { toolCallId: "tc1", answers } as never);

    expect(res).toEqual({ ok: true });
    expect(resolveSpy).toHaveBeenCalledWith(
      "u1:s1:tc1",
      { answers },
      { sessionId: "s1", toolCallId: "tc1", by: "local" },
    );
  });
});
