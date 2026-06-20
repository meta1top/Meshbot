import type { GraphService } from "@meshbot/agent";
import { CheckpointerCleanupService } from "./checkpointer-cleanup.service";

describe("CheckpointerCleanupService", () => {
  it("deleteThread 委托 GraphService.clearThread(threadId)", async () => {
    const clearThread = jest.fn();
    const service = new CheckpointerCleanupService({
      clearThread,
    } as unknown as GraphService);

    await service.deleteThread("t1");

    expect(clearThread).toHaveBeenCalledWith("t1");
  });

  it("deleteThread 返回 Promise<void>", async () => {
    const service = new CheckpointerCleanupService({
      clearThread: jest.fn(),
    } as unknown as GraphService);

    await expect(service.deleteThread("nope")).resolves.toBeUndefined();
  });
});
