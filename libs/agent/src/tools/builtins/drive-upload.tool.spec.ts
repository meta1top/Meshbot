import { describe, expect, it, vi } from "vitest";
import { DriveUploadTool } from "./drive-upload.tool";

describe("DriveUploadTool", () => {
  it("透传 path + parentId + name 给 port.upload", async () => {
    const port = { upload: vi.fn().mockResolvedValue('{"id":"file1"}') } as any;
    const tool = new DriveUploadTool(port);
    const res = await tool.execute(
      { path: "output/report.pdf", parentId: "p1", name: "report.pdf" },
      {} as any,
    );
    expect(port.upload).toHaveBeenCalledWith(
      "output/report.pdf",
      "p1",
      "report.pdf",
    );
    expect(res).toBe('{"id":"file1"}');
  });

  it("parentId 缺省 → null，name 缺省 → undefined", async () => {
    const port = { upload: vi.fn().mockResolvedValue("{}") } as any;
    await new DriveUploadTool(port).execute({ path: "out/a.txt" }, {} as any);
    expect(port.upload).toHaveBeenCalledWith("out/a.txt", null, undefined);
  });
});
