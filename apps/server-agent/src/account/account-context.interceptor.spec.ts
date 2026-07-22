import { type CallHandler, type ExecutionContext } from "@nestjs/common";
import { defer, of } from "rxjs";
import { AccountContextService } from "@meshbot/lib-agent";
import { AccountContextInterceptor } from "./account-context.interceptor";

function makeExecutionContext(user?: { id: string }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
      getResponse: () => ({}),
      getNext: () => null,
    }),
  } as unknown as ExecutionContext;
}

function makeCallHandler(handle: CallHandler["handle"]): CallHandler {
  return { handle };
}

describe("AccountContextInterceptor", () => {
  it("把 request.user.id 注入上下文供下游读取", (done) => {
    const ctx = new AccountContextService();
    const interceptor = new AccountContextInterceptor(ctx);
    const exec = makeExecutionContext({ id: "u1" });
    const next = makeCallHandler(() => of(ctx.get()));
    interceptor.intercept(exec, next).subscribe((seen: unknown) => {
      expect(seen).toBe("u1");
      done();
    });
  });

  it("无 user 时不报错、原样放行", (done) => {
    const ctx = new AccountContextService();
    const interceptor = new AccountContextInterceptor(ctx);
    const exec = makeExecutionContext(undefined);
    const next = makeCallHandler(() => of("ok"));
    interceptor.intercept(exec, next).subscribe((v: unknown) => {
      expect(v).toBe("ok");
      done();
    });
  });

  it("异步 handler 的连续体内仍能读到账号上下文", (done) => {
    const ctx = new AccountContextService();
    const interceptor = new AccountContextInterceptor(ctx);
    const exec = makeExecutionContext({ id: "u7" });
    // next.handle() 返回一个 Observable，其值在 await 之后产生（跨异步边界）
    const next = makeCallHandler(() =>
      defer(async () => {
        await Promise.resolve();
        return ctx.get();
      }),
    );
    interceptor.intercept(exec, next).subscribe((seen: unknown) => {
      expect(seen).toBe("u7");
      done();
    });
  });
});
