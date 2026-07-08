import type { AccountContextService } from "@meshbot/lib-agent";
import type { ImRelayClientService } from "../cloud/im-relay-client.service";
import { type AwaitOutcome, ConfirmationService } from "./confirmation.service";
import { ImSendService } from "./im-send.service";

function make(outcome: AwaitOutcome, sendImpl?: () => void) {
  const confirmation = {
    waitForDecision: jest.fn().mockResolvedValue(outcome),
  } as unknown as ConfirmationService;
  const relay = {
    send: jest.fn(sendImpl),
  } as unknown as ImRelayClientService;
  const account = { getOrThrow: () => "u1" } as AccountContextService;
  const svc = new ImSendService(confirmation, relay, account);
  return { svc, relay };
}

const params = {
  sessionId: "s1",
  toolCallId: "tc1",
  conversationId: "c1",
  content: "原稿",
};

describe("ImSendService.confirmAndSend", () => {
  it("send + 编辑后内容 → 经 relay 发编辑版，返回 sent", async () => {
    const { svc, relay } = make({ action: "send", content: "改后" });
    const out = JSON.parse(
      await svc.confirmAndSend(params, new AbortController().signal),
    );
    expect(out).toEqual({ status: "sent", content: "改后" });
    expect(relay.send).toHaveBeenCalledWith("u1", {
      conversationId: "c1",
      content: "改后",
    });
  });

  it("send 但无编辑内容 → 发原稿", async () => {
    const { svc, relay } = make({ action: "send" });
    await svc.confirmAndSend(params, new AbortController().signal);
    expect(relay.send).toHaveBeenCalledWith("u1", {
      conversationId: "c1",
      content: "原稿",
    });
  });

  it("cancel → 不发，返回 cancelled", async () => {
    const { svc, relay } = make({ action: "cancel" });
    const out = JSON.parse(
      await svc.confirmAndSend(params, new AbortController().signal),
    );
    expect(out.status).toBe("cancelled");
    expect(relay.send).not.toHaveBeenCalled();
  });

  it("timeout → 不发，返回 timeout", async () => {
    const { svc, relay } = make("timeout");
    const out = JSON.parse(
      await svc.confirmAndSend(params, new AbortController().signal),
    );
    expect(out.status).toBe("timeout");
    expect(relay.send).not.toHaveBeenCalled();
  });

  it("aborted → 返回 interrupted", async () => {
    const { svc } = make("aborted");
    const out = JSON.parse(
      await svc.confirmAndSend(params, new AbortController().signal),
    );
    expect(out.status).toBe("interrupted");
  });

  it("relay 抛错 → 返回 error", async () => {
    const { svc } = make({ action: "send" }, () => {
      throw new Error("boom");
    });
    const out = JSON.parse(
      await svc.confirmAndSend(params, new AbortController().signal),
    );
    expect(out.status).toBe("error");
  });
});
