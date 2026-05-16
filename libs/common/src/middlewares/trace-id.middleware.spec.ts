import "reflect-metadata";

import { TRACE_ID_HEADER, traceIdMiddleware } from "./trace-id.middleware";

function makeReqRes(headers: Record<string, string | string[]> = {}) {
  const req: any = { headers };
  const setHeader = jest.fn();
  const res = { setHeader };
  return { req, res, setHeader };
}

describe("traceIdMiddleware", () => {
  it("无 x-trace-id header 时生成新 UUID", () => {
    const { req, res, setHeader } = makeReqRes();
    const next = jest.fn();
    traceIdMiddleware(req, res, next);
    expect(req.traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(setHeader).toHaveBeenCalledWith(TRACE_ID_HEADER, req.traceId);
    expect(next).toHaveBeenCalled();
  });

  it("透传上游 x-trace-id（字符串）", () => {
    const { req, res, setHeader } = makeReqRes({ "x-trace-id": "trace-abc" });
    traceIdMiddleware(req, res, () => {});
    expect(req.traceId).toBe("trace-abc");
    expect(setHeader).toHaveBeenCalledWith(TRACE_ID_HEADER, "trace-abc");
  });

  it("透传上游 x-trace-id（数组取第一个）", () => {
    const { req, res, setHeader } = makeReqRes({
      "x-trace-id": ["first", "second"],
    });
    traceIdMiddleware(req, res, () => {});
    expect(req.traceId).toBe("first");
    expect(setHeader).toHaveBeenCalledWith(TRACE_ID_HEADER, "first");
  });

  it("空字符串 header 视为无 → 生成新 UUID", () => {
    const { req } = makeReqRes({ "x-trace-id": "" });
    traceIdMiddleware(req, { setHeader: () => {} }, () => {});
    expect(req.traceId).toMatch(/^[0-9a-f-]+$/);
    expect(req.traceId.length).toBeGreaterThan(8);
  });
});
