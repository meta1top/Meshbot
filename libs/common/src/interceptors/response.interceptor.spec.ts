import "reflect-metadata";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { firstValueFrom, of } from "rxjs";

import {
  ResponseInterceptor,
  SKIP_RESPONSE_ENVELOPE,
} from "./response.interceptor";

function makeCtx(url = "/api/foo", traceId = "trace-1"): ExecutionContext {
  const req = { url, traceId };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => null,
    }),
    getHandler: () => () => null,
    getClass: () => class Stub {},
  } as unknown as ExecutionContext;
}

function makeNext(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

describe("ResponseInterceptor", () => {
  let reflector: Reflector;
  let interceptor: ResponseInterceptor;

  beforeEach(() => {
    reflector = new Reflector();
    interceptor = new ResponseInterceptor(reflector);
  });

  it("普通返回包成 envelope（success:true / code:0 / data 透传）", async () => {
    const ctx = makeCtx();
    const out = await firstValueFrom(
      interceptor.intercept(ctx, makeNext({ id: "u1", email: "a@b.io" })),
    );
    expect(out).toMatchObject({
      success: true,
      code: 0,
      message: "success",
      data: { id: "u1", email: "a@b.io" },
      path: "/api/foo",
      traceId: "trace-1",
    });
  });

  it("返回 undefined → data = null（避免序列化丢字段）", async () => {
    const ctx = makeCtx();
    const out = await firstValueFrom(
      interceptor.intercept(ctx, makeNext(undefined)),
    );
    expect((out as { data: unknown }).data).toBeNull();
  });

  it("@SkipResponseEnvelope() 标记的端点原样返回", async () => {
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockImplementation((key) => key === SKIP_RESPONSE_ENVELOPE);
    const ctx = makeCtx();
    const raw = { status: "up", details: { db: "ok" } };
    const out = await firstValueFrom(interceptor.intercept(ctx, makeNext(raw)));
    expect(out).toEqual(raw);
  });
});
