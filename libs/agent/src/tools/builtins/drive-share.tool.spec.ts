import { describe, expect, it, vi } from "vitest";
import { DriveShareTool } from "./drive-share.tool";

describe("DriveShareTool", () => {
  it("透传 nodeId/shareWith/permission + ctx 给 port.share", async () => {
    const port = {
      share: vi.fn().mockResolvedValue('{"status":"shared"}'),
    } as any;
    const ctx = {
      sessionId: "s1",
      toolCallId: "t1",
      signal: new AbortController().signal,
    } as any;

    await new DriveShareTool(port).execute(
      { nodeId: "n1", shareWith: "org", permission: "viewer" },
      ctx,
    );

    expect(port.share).toHaveBeenCalledWith(
      {
        nodeId: "n1",
        shareWith: "org",
        permission: "viewer",
        sessionId: "s1",
        toolCallId: "t1",
      },
      ctx.signal,
    );
  });
});
