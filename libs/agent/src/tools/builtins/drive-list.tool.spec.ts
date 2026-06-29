import { describe, expect, it, vi } from "vitest";
import { DriveListTool } from "./drive-list.tool";

describe("DriveListTool", () => {
  it("透传 parentId 给 port.list", async () => {
    const port = { list: vi.fn().mockResolvedValue('{"nodes":[]}') } as any;
    const tool = new DriveListTool(port);
    const res = await tool.execute({ parentId: "p1" }, {} as any);
    expect(port.list).toHaveBeenCalledWith("p1");
    expect(res).toBe('{"nodes":[]}');
  });

  it("parentId 缺省 → null", async () => {
    const port = { list: vi.fn().mockResolvedValue("{}") } as any;
    await new DriveListTool(port).execute({}, {} as any);
    expect(port.list).toHaveBeenCalledWith(null);
  });
});
