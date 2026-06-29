import { describe, expect, it, vi } from "vitest";
import { DriveDownloadTool } from "./drive-download.tool";

describe("DriveDownloadTool", () => {
  it("透传 fileId + destPath 给 port.download", async () => {
    const port = {
      download: vi.fn().mockResolvedValue('{"saved":"output/a.txt"}'),
    } as any;
    const tool = new DriveDownloadTool(port);
    const res = await tool.execute(
      { fileId: "f123", destPath: "output/a.txt" },
      {} as any,
    );
    expect(port.download).toHaveBeenCalledWith("f123", "output/a.txt");
    expect(res).toBe('{"saved":"output/a.txt"}');
  });
});
