import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";

interface AccountStore {
  cloudUserId: string;
}

/**
 * 进程内「当前账号上下文」（v3 请求级隔离）。
 * - 请求路径：JWT 鉴权后由拦截器注入 sub（= cloudUserId）。
 * - 后台路径（cron / runner）：执行前显式 run(cloudUserId, fn)。
 * 基于 AsyncLocalStorage，异步连续体自动继承。
 */
@Injectable()
export class AccountContextService {
  private readonly als = new AsyncLocalStorage<AccountStore>();

  /** 在指定账号上下文中运行 fn（同步或异步）。 */
  run<T>(cloudUserId: string, fn: () => T): T {
    return this.als.run({ cloudUserId }, fn);
  }

  /** 当前账号；无上下文返回 null。 */
  get(): string | null {
    return this.als.getStore()?.cloudUserId ?? null;
  }

  /**
   * 当前账号；无上下文抛错（内部不变量：作用域查询/文件访问必须在账号上下文内，
   * 触发说明存在编程错误 → 抛普通 Error，由全局错误过滤器映射为 500）。
   */
  getOrThrow(): string {
    const id = this.get();
    if (!id) {
      throw new Error(
        "AccountContext: 当前无活跃账号上下文（作用域查询/文件访问运行在账号上下文之外）",
      );
    }
    return id;
  }
}
