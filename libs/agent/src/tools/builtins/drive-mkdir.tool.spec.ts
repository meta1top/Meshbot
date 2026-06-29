import { describe, expect, it, vi } from "vitest";
import { DriveMkdirTool } from "./drive-mkdir.tool";

describe("DriveMkdirTool", () => {
  it("透传 parentId + name 给 port.mkdir", async () => {
    const port = { mkdir: vi.fn().mockResolvedValue('{"id":"f1"}') } as any;
    const tool = new DriveMkdirTool(port);
    const res = await tool.execute(
      { parentId: "p1", name: "新文件夹" },
      {} as any,
    );
    expect(port.mkdir).toHaveBeenCalledWith("p1", "新文件夹");
    expect(res).toBe('{"id":"f1"}');
  });

  it("parentId 缺省 → null", async () => {
    const port = { mkdir: vi.fn().mockResolvedValue("{}") } as any;
    await new DriveMkdirTool(port).execute({ name: "test" }, {} as any);
    expect(port.mkdir).toHaveBeenCalledWith(null, "test");
  });
});
