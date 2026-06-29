import { driveCreateShareSchema } from "@meshbot/types-agent";
import { describe, expect, it, vi } from "vitest";
import { DriveCreateShareTool } from "./drive-create-share.tool";

describe("DriveCreateShareTool", () => {
  it("透传 nodeId/expiresInDays/password + ctx 给 port.createShare", async () => {
    const port = {
      createShare: vi
        .fn()
        .mockResolvedValue(
          '{"status":"shared","token":"tk1","url":"https://x"}',
        ),
    } as any;
    const ctx = {
      sessionId: "s1",
      toolCallId: "t1",
      signal: new AbortController().signal,
    } as any;

    await new DriveCreateShareTool(port).execute(
      { nodeId: "n1", expiresInDays: 7, password: "pw" },
      ctx,
    );

    expect(port.createShare).toHaveBeenCalledWith(
      {
        nodeId: "n1",
        expiresInDays: 7,
        password: "pw",
        sessionId: "s1",
        toolCallId: "t1",
      },
      ctx.signal,
    );
  });
});

describe("driveCreateShareSchema", () => {
  it("接受 expiresInDays=null（永不过期）", () => {
    const result = driveCreateShareSchema.safeParse({
      nodeId: "n1",
      expiresInDays: null,
    });
    expect(result.success).toBe(true);
  });

  it("接受无 password（不加密）", () => {
    const result = driveCreateShareSchema.safeParse({ nodeId: "n1" });
    expect(result.success).toBe(true);
  });
});
