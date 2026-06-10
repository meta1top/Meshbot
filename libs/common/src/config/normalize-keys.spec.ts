import { normalizeKeys } from "./normalize-keys";

describe("normalizeKeys", () => {
  it("kebab-case key 递归转 camelCase，值不变", () => {
    const input = {
      "access-key-id": "ak",
      nested: { "account-name": "noreply@x.com", port: 3200 },
      list: [{ "a-b": 1 }],
    };
    expect(normalizeKeys(input)).toEqual({
      accessKeyId: "ak",
      nested: { accountName: "noreply@x.com", port: 3200 },
      list: [{ aB: 1 }],
    });
  });

  it("已是 camelCase / 无连字符的 key 不变", () => {
    expect(normalizeKeys({ accountName: "x", port: 1 })).toEqual({
      accountName: "x",
      port: 1,
    });
  });
});
