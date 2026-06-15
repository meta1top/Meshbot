import { unwrapEnvelope } from "./client";

/**
 * unwrapEnvelope 单测。
 *
 * 约定（见 libs/common errors/error-code.ts）：业务错误走 HTTP 200 +
 * envelope `success:false`，前端按 `success` 字段统一判断。本函数即该判断的
 * 落点：`success:false` 必须抛出携带云端 message/code 的错误，调用方（如
 * login）才不会在失败时盲读 data。
 */
describe("unwrapEnvelope", () => {
  it("success:false 信封抛出携带 message 的错误", () => {
    expect(() =>
      unwrapEnvelope({
        success: false,
        code: 2002,
        message: "邮箱或密码错误",
        data: null,
      }),
    ).toThrow("邮箱或密码错误");
  });

  it("抛出的是 Error 实例（登录页据此取 message 展示）", () => {
    expect(() =>
      unwrapEnvelope({ success: false, code: 1, message: "x", data: null }),
    ).toThrow(Error);
  });

  it("抛出的错误携带云端 code", () => {
    let caught: unknown;
    try {
      unwrapEnvelope({ success: false, code: 2002, message: "x", data: null });
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: number }).code).toBe(2002);
  });

  it("success:true 信封解包返回内层 data", () => {
    expect(
      unwrapEnvelope({ success: true, code: 0, data: { access_token: "t" } }),
    ).toEqual({ access_token: "t" });
  });

  it("success:true 且 data 为 null（void 端点）原样返回 null", () => {
    expect(unwrapEnvelope({ success: true, code: 0, data: null })).toBeNull();
  });

  it("非信封响应（无 success/data 字段）原样返回", () => {
    expect(unwrapEnvelope({ id: 1, name: "x" })).toEqual({ id: 1, name: "x" });
  });
});
