import { generateSnowflakeId } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { AccountContextService } from "../account/account-context.service";
import { createSqliteCheckpointer } from "../checkpoint/sqlite-checkpointer";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { ToolRegistry } from "../tools/tool-registry";
import { buildSupervisorGraph } from "./graph.builder";
import { ModelResolver } from "./model-resolver.service";

/**
 * 按账号缓存 {graph, checkpointer} 并维护 msgIdMap 的共享底座。
 *
 * 必须是单例（DI singleton）：checkpointer 与 msgIdMap 均为进程全局状态；
 * supervisor 节点（写 checkpointer）与 runGraphStream（发事件）共享同一个
 * resolveMessageId 实例，确保 checkpointer / session_messages / WS 事件三处
 * id 收口一致。
 */
@Injectable()
export class AccountGraphProvider {
  /** 按账号缓存的主图 {graph, checkpointer}：checkpointer 指向该账号 accounts/<id>/agent.db。 */
  private readonly graphsByAccount = new Map<
    string,
    {
      graph: ReturnType<typeof buildSupervisorGraph>;
      checkpointer: ReturnType<typeof createSqliteCheckpointer>;
    }
  >();

  /** 子 Agent 子图（排除 dispatch_subagent），按账号缓存，共用同账号 checkpointer。 */
  private readonly subGraphsByAccount = new Map<
    string,
    { graph: ReturnType<typeof buildSupervisorGraph> }
  >();

  /** 排除集：子 Agent 不绑定 dispatch 工具，天然不能再派（一层）。 */
  private static readonly SUBAGENT_EXCLUDE = new Set(["dispatch_subagent"]);

  /** 模型生成的 AIMessage UUID -> 我方雪花。node 与 runGraphStream 共享，保证一致。 */
  private readonly msgIdMap = new Map<string, string>();

  /** 取/建某条 AIMessage 的雪花 id（get-or-create，幂等）。
   *  supervisor 节点（写 checkpointer）与 runGraphStream（发事件）解析同一雪花，
   *  使 checkpointer / session_messages / WS 事件三处 id 收口一致。 */
  readonly resolveMessageId = (modelId: string): string => {
    let s = this.msgIdMap.get(modelId);
    if (!s) {
      s = generateSnowflakeId();
      this.msgIdMap.set(modelId, s);
    }
    return s;
  };

  constructor(
    private readonly config: MeshbotConfigService,
    private readonly account: AccountContextService,
    private readonly toolRegistry: ToolRegistry,
    private readonly eventEmitter: EventEmitter2,
    private readonly modelResolver: ModelResolver,
  ) {}

  /**
   * 解析当前账号的 graph+checkpointer（首次建、之后缓存）。须在账号上下文内调用。
   *
   * 缓存常驻进程生命周期、不主动关闭——与改造前「单例 checkpointer 从不关闭」一致：
   * 同账号登出再登录复用同一连接（无重登双连接、无连接泄漏、无 use-after-close）；
   * 本地轨账号数有限，每账号一条常驻 SqliteSaver 连接的开销可接受。
   */
  accountGraph(): {
    graph: ReturnType<typeof buildSupervisorGraph>;
    checkpointer: ReturnType<typeof createSqliteCheckpointer>;
  } {
    const acct = this.account.getOrThrow();
    let entry = this.graphsByAccount.get(acct);
    if (!entry) {
      const checkpointer = createSqliteCheckpointer(
        this.config.getAccountCheckpointDbPath(),
      );
      const graph = buildSupervisorGraph(
        checkpointer,
        this.modelResolver.provider(),
        this.toolRegistry,
        this.eventEmitter,
        this.resolveMessageId,
      );
      entry = { graph, checkpointer };
      this.graphsByAccount.set(acct, entry);
    }
    return entry;
  }

  /**
   * 解析当前账号的子图（复用 accountGraph 的 checkpointer；首次建、之后缓存）。
   *
   * 子 Agent 用去掉 dispatch_subagent 的子图运行，天然不能再派（一层嵌套上限）。
   */
  subAgentGraph(): { graph: ReturnType<typeof buildSupervisorGraph> } {
    const acct = this.account.getOrThrow();
    let entry = this.subGraphsByAccount.get(acct);
    if (!entry) {
      const { checkpointer } = this.accountGraph();
      const graph = buildSupervisorGraph(
        checkpointer,
        this.modelResolver.provider(),
        this.toolRegistry,
        this.eventEmitter,
        this.resolveMessageId,
        AccountGraphProvider.SUBAGENT_EXCLUDE,
      );
      entry = { graph };
      this.subGraphsByAccount.set(acct, entry);
    }
    return entry;
  }

  /**
   * 从 msgIdMap 批量删除指定 id，供 runGraphStream 末尾清理本 run 见过的模型 UUID。
   */
  deleteMsgIds(ids: Iterable<string>): void {
    for (const id of ids) this.msgIdMap.delete(id);
  }
}
