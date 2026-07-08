import type { AccountContextService } from "@meshbot/lib-agent";
import { ConfirmationService } from "./confirmation.service";
import { AskQuestionService } from "./ask-question.service";

function make(outcome: unknown) {
  const confirmation = {
    waitForDecision: jest.fn().mockResolvedValue(outcome),
  } as unknown as ConfirmationService;
  const account = { getOrThrow: () => "u1" } as AccountContextService;
  return new AskQuestionService(confirmation, account);
}
const params = { sessionId: "s1", toolCallId: "tc1" };

describe("AskQuestionService.ask", () => {
  it("answered → 返回 status answered + answers", async () => {
    const svc = make({ answers: [{ selected: ["A"], other: "" }] });
    const out = JSON.parse(await svc.ask(params, new AbortController().signal));
    expect(out.status).toBe("answered");
    expect(out.answers).toEqual([{ selected: ["A"], other: "" }]);
  });
  it("timeout → status timeout", async () => {
    const out = JSON.parse(
      await make("timeout").ask(params, new AbortController().signal),
    );
    expect(out.status).toBe("timeout");
  });
  it("aborted → status interrupted", async () => {
    const out = JSON.parse(
      await make("aborted").ask(params, new AbortController().signal),
    );
    expect(out.status).toBe("interrupted");
  });
});
