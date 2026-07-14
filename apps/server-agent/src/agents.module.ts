import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { Agent } from "./entities/agent.entity";
import { AgentService } from "./services/agent.service";

/**
 * Agent 元数据叶子模块：`AgentService` 归属于此，供 `AppModule` 与
 * `SessionModule` 分别 import（`SessionController`/`RemoteRunInboundService`
 * 建会话时需要 `AgentService.ensureDefault()` 兜底取默认 Agent）。
 *
 * 之所以单独抽出（而非直接在 `AppModule.providers` 里注册），是因为
 * `AppModule` 本身 import 了 `SessionModule`——若 `AgentService` 只挂在
 * `AppModule` 上，`SessionModule` 没有安全路径拿到它（`SessionModule` import
 * `AppModule` 会形成模块级循环依赖）。抽成叶子模块后两边各自 import 即可。
 *
 * 注意：与 `@meshbot/lib-agent` 导出的 `AgentModule`（图/工具编排基础设施）
 * 是完全不同的两个东西，纯属命名相近，无继承关系。
 */
@Module({
  imports: [TxTypeOrmModule.forFeature([Agent])],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentsModule {}
