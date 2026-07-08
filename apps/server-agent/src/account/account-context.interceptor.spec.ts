import { defer, of } from "rxjs";
import { AccountContextService } from "@meshbot/lib-agent";
import { AccountContextInterceptor } from "./account-context.interceptor";

describe("AccountContextInterceptor", () => {
  it("把 request.user.id 注入上下文供下游读取", (done) => {
    const ctx = new AccountContextService();
    const interceptor = new AccountContextInterceptor(ctx);
    const exec: any = {
      switchToHttp: () => ({ getRequest: () => ({ user: { id: "u1" } }) }),
    };
    const next: any = { handle: () => of(ctx.get()) };
    interceptor.intercept(exec, next).subscribe((seen: unknown) => {
      expect(seen).toBe("u1");
      done();
    });
  });

  it("无 user 时不报错、原样放行", (done) => {
    const ctx = new AccountContextService();
    const interceptor = new AccountContextInterceptor(ctx);
    const exec: any = { switchToHttp: () => ({ getRequest: () => ({}) }) };
    const next: any = { handle: () => of("ok") };
    interceptor.intercept(exec, next).subscribe((v: unknown) => {
      expect(v).toBe("ok");
      done();
    });
  });

  it("异步 handler 的连续体内仍能读到账号上下文", (done) => {
    const ctx = new AccountContextService();
    const interceptor = new AccountContextInterceptor(ctx);
    const exec: any = {
      switchToHttp: () => ({ getRequest: () => ({ user: { id: "u7" } }) }),
    };
    // next.handle() 返回一个 Observable，其值在 await 之后产生（跨异步边界）
    const next: any = {
      handle: () =>
        defer(async () => {
          await Promise.resolve();
          return ctx.get();
        }),
    };
    interceptor.intercept(exec, next).subscribe((seen: unknown) => {
      expect(seen).toBe("u7");
      done();
    });
  });
});
