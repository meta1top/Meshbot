import type { DriveNode } from "@/rest/drive";
import { sortNodes } from "./sort-nodes";

function node(p: Partial<DriveNode>): DriveNode {
  return {
    id: "1",
    type: "file",
    name: "a",
    sizeBytes: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...p,
  } as DriveNode;
}

describe("sortNodes", () => {
  it("文件夹始终排在文件前（asc）", () => {
    const r = sortNodes(
      [node({ type: "file", name: "a" }), node({ type: "folder", name: "z" })],
      "name",
      "asc",
    );
    expect(r[0].type).toBe("folder");
  });

  it("文件夹排序不受 dir 影响（desc 也在前）", () => {
    const r = sortNodes(
      [node({ type: "file", name: "a" }), node({ type: "folder", name: "z" })],
      "name",
      "desc",
    );
    expect(r[0].type).toBe("folder");
  });

  it("name asc / desc", () => {
    const asc = sortNodes(
      [node({ name: "b" }), node({ name: "a" })],
      "name",
      "asc",
    );
    expect(asc.map((n) => n.name)).toEqual(["a", "b"]);
    const desc = sortNodes(
      [node({ name: "a" }), node({ name: "b" })],
      "name",
      "desc",
    );
    expect(desc.map((n) => n.name)).toEqual(["b", "a"]);
  });

  it("size 数值序", () => {
    const r = sortNodes(
      [node({ sizeBytes: 100 }), node({ sizeBytes: 5 })],
      "size",
      "asc",
    );
    expect(r.map((n) => n.sizeBytes)).toEqual([5, 100]);
  });

  it("modified 按 updatedAt", () => {
    const r = sortNodes(
      [
        node({ name: "new", updatedAt: "2026-06-01T00:00:00Z" }),
        node({ name: "old", updatedAt: "2026-01-01T00:00:00Z" }),
      ],
      "modified",
      "asc",
    );
    expect(r.map((n) => n.name)).toEqual(["old", "new"]);
  });

  it("空数组", () => {
    expect(sortNodes([], "name", "asc")).toEqual([]);
  });
});
