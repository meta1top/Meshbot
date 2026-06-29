import { driveFetchShareSchema } from "@meshbot/types-agent";
import { describe, expect, it, vi } from "vitest";
import { DriveFetchShareTool } from "./drive-fetch-share.tool";

describe("DriveFetchShareTool", () => {
  it("透传 token/destPath/password 给 port.fetchShare", async () => {
    const port = {
      fetchShare: vi
        .fn()
        .mockResolvedValue(
          '{"status":"downloaded","path":"downloads/file.txt"}',
        ),
    } as any;
    const ctx = {} as any;

    await new DriveFetchShareTool(port).execute(
      { token: "tk1", destPath: "downloads/file.txt", password: "pw" },
      ctx,
    );

    expect(port.fetchShare).toHaveBeenCalledWith(
      "tk1",
      "downloads/file.txt",
      "pw",
    );
  });
});

describe("driveFetchShareSchema", () => {
  it("接受无 password", () => {
    const result = driveFetchShareSchema.safeParse({
      token: "tk1",
      destPath: "out.txt",
    });
    expect(result.success).toBe(true);
  });
});
