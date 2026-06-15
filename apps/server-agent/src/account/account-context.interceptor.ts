import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { AccountContextService } from "@meshbot/agent";

/**
 * 全局拦截器：在 JwtAuthGuard 之后运行，把 request.user.id（= JWT sub = cloudUserId）
 * 注入 AccountContext，使下游 service 的 ScopedRepository 自动按账号过滤。
 * 用手动 Observable 订阅确保订阅期（controller 同步调用 + 其异步连续体）处于 ALS 上下文内。
 */
@Injectable()
export class AccountContextInterceptor implements NestInterceptor {
  constructor(private readonly ctx: AccountContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ user?: { id?: string } }>();
    const cloudUserId = req?.user?.id;
    if (!cloudUserId) {
      return next.handle();
    }
    return new Observable((subscriber) => {
      this.ctx.run(cloudUserId, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
