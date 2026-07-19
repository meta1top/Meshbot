/**
 * @jest-environment jsdom
 */
import { readExpandedKeys, writeExpandedKeys } from "./expanded-store";

const KEY = "test.expandedKeys";

describe("readExpandedKeys / writeExpandedKeys", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("正常往返：写入后原样读出", () => {
    writeExpandedKeys(KEY, ["a", "b", "c"]);
    expect(readExpandedKeys(KEY)).toEqual(new Set(["a", "b", "c"]));
  });

  it("无值 → 空集", () => {
    expect(readExpandedKeys(KEY)).toEqual(new Set());
  });

  it("坏 JSON → 空集，不抛", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(() => readExpandedKeys(KEY)).not.toThrow();
    expect(readExpandedKeys(KEY)).toEqual(new Set());
  });

  it("解析出非数组（如对象）→ 空集", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ a: 1 }));
    expect(readExpandedKeys(KEY)).toEqual(new Set());
  });

  it("数组含非 string 元素 → 过滤掉脏元素，保留合法 string", () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a", 1, null, "b", {}]));
    expect(readExpandedKeys(KEY)).toEqual(new Set(["a", "b"]));
  });

  it("覆盖写入：第二次写入替换而非合并", () => {
    writeExpandedKeys(KEY, ["a", "b"]);
    writeExpandedKeys(KEY, ["c"]);
    expect(readExpandedKeys(KEY)).toEqual(new Set(["c"]));
  });

  it("写入抛异常（如配额超限）不冒泡", () => {
    const spy = jest
      .spyOn(window.localStorage.__proto__, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });
    expect(() => writeExpandedKeys(KEY, ["a"])).not.toThrow();
    spy.mockRestore();
  });

  it("非浏览器环境（window undefined）→ 读返回空集、写不抛", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error 模拟非浏览器环境
    delete globalThis.window;
    try {
      expect(readExpandedKeys(KEY)).toEqual(new Set());
      expect(() => writeExpandedKeys(KEY, ["a"])).not.toThrow();
    } finally {
      globalThis.window = originalWindow;
    }
  });
});
