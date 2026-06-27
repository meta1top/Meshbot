import type { AccountContextService } from "@meshbot/agent";
import { ConfirmationService } from "../services/confirmation.service";
import { SessionController } from "./session.controller";

describe("SessionController.confirm", () => {
  it("按 cloudUserId:sessionId:toolCallId resolve，透传 decision+content", () => {
    const confirmation = new ConfirmationService();
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
    expect(resolveSpy).toHaveBeenCalledWith("u1:s1:tc1", {
      action: "send",
      content: "改后",
    });
  });
});
