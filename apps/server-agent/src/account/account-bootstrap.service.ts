import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { CloudIdentityService } from "../services/cloud-identity.service";
import { AccountRuntimeRegistry } from "./account-runtime.registry";

/**
 * D9 重启恢复：进程启动时，为每个已登录账号重建运行时（重连 MCP/云、恢复缓存）。
 * 单账号恢复失败不拖垮整体（try/catch + 日志）。
 */
@Injectable()
export class AccountBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccountBootstrapService.name);
  constructor(
    private readonly identity: CloudIdentityService,
    private readonly runtime: AccountRuntimeRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const accounts = await this.identity.listLoggedIn();
    for (const a of accounts) {
      try {
        await this.runtime.createRuntime(a.cloudUserId);
        this.logger.log(`恢复账号 ${a.cloudUserId} 运行时`);
      } catch (err) {
        this.logger.error(`恢复账号 ${a.cloudUserId} 运行时失败`, err as Error);
      }
    }
  }
}
