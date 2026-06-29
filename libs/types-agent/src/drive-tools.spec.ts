import {
  driveDownloadSchema,
  driveListSchema,
  driveMkdirSchema,
  driveShareSchema,
  driveUploadSchema,
} from "./drive-tools";

describe("driveListSchema", () => {
  it("合法：parentId 为 null", () => {
    expect(() => driveListSchema.parse({ parentId: null })).not.toThrow();
  });
  it("合法：parentId 省略", () => {
    expect(() => driveListSchema.parse({})).not.toThrow();
  });
  it("合法：parentId 为字符串", () => {
    expect(() =>
      driveListSchema.parse({ parentId: "folder-id" }),
    ).not.toThrow();
  });
  it("非法：parentId 为数字", () => {
    expect(() => driveListSchema.parse({ parentId: 123 })).toThrow();
  });
});

describe("driveMkdirSchema", () => {
  it("合法：name 合法、parentId 省略", () => {
    expect(() => driveMkdirSchema.parse({ name: "新文件夹" })).not.toThrow();
  });
  it("非法：缺少 name", () => {
    expect(() => driveMkdirSchema.parse({ parentId: null })).toThrow();
  });
  it("非法：name 为空字符串", () => {
    expect(() => driveMkdirSchema.parse({ name: "" })).toThrow();
  });
  it("非法：name 超过 256 字符", () => {
    expect(() => driveMkdirSchema.parse({ name: "a".repeat(257) })).toThrow();
  });
});

describe("driveUploadSchema", () => {
  it("合法：path 合法、其余省略", () => {
    expect(() =>
      driveUploadSchema.parse({ path: "/workspace/a.txt" }),
    ).not.toThrow();
  });
  it("非法：path 为空字符串", () => {
    expect(() => driveUploadSchema.parse({ path: "" })).toThrow();
  });
  it("非法：缺少 path", () => {
    expect(() => driveUploadSchema.parse({})).toThrow();
  });
});

describe("driveDownloadSchema", () => {
  it("合法：fileId 和 destPath 均合法", () => {
    expect(() =>
      driveDownloadSchema.parse({
        fileId: "file-001",
        destPath: "/workspace/out.txt",
      }),
    ).not.toThrow();
  });
  it("非法：fileId 为空", () => {
    expect(() =>
      driveDownloadSchema.parse({ fileId: "", destPath: "/workspace/out.txt" }),
    ).toThrow();
  });
  it("非法：缺少 destPath", () => {
    expect(() => driveDownloadSchema.parse({ fileId: "file-001" })).toThrow();
  });
});

describe("driveShareSchema", () => {
  it("合法：permission 为 viewer", () => {
    expect(() =>
      driveShareSchema.parse({
        nodeId: "node-1",
        shareWith: "user@example.com",
        permission: "viewer",
      }),
    ).not.toThrow();
  });
  it("合法：permission 为 editor", () => {
    expect(() =>
      driveShareSchema.parse({
        nodeId: "node-1",
        shareWith: "user@example.com",
        permission: "editor",
      }),
    ).not.toThrow();
  });
  it("非法：permission 不在枚举内", () => {
    expect(() =>
      driveShareSchema.parse({
        nodeId: "node-1",
        shareWith: "user@example.com",
        permission: "owner",
      }),
    ).toThrow();
  });
  it("非法：缺少 nodeId", () => {
    expect(() =>
      driveShareSchema.parse({
        shareWith: "user@example.com",
        permission: "viewer",
      }),
    ).toThrow();
  });
});
