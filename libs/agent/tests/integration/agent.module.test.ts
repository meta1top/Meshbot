import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AgentModule } from "../../src/agent.module";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { CLOUD_TOKEN_PORT } from "../../src/graph/cloud-token.port";
import { GraphRunner } from "../../src/graph/graph-runner.service";
import { RUNTIME_CONTEXT_PORT } from "../../src/graph/runtime-context.port";
import { PromptService } from "../../src/prompt/prompt.service";
import { ASK_QUESTION_PORT } from "../../src/tools/ask-question.port";
import { DISPATCH_SUBAGENT_PORT } from "../../src/tools/dispatch-subagent.port";
import { DRIVE_PORT } from "../../src/tools/drive.port";
import { IM_CONTEXT_PORT } from "../../src/tools/im-context.port";
import { IM_SEND_PORT } from "../../src/tools/im-send.port";
import { QUICK_ASSISTANT_PORT } from "../../src/tools/quick-assistant.port";
import { SCHEDULE_TOOLS_PORT } from "../../src/tools/schedule-tools.port";
import { SKILL_TOOLS_PORT } from "../../src/tools/skill-tools.port";
import { ToolRegistry } from "../../src/tools/tool-registry";

/**
 * AgentModule 的 port（IM/schedule/skill/dispatch/…）由宿主 server-agent 的
 * 模块注入，独立编译 AgentModule 时缺失 → DI 解析失败（曾是 4 条基线预挂）。
 * 测试给全部 port 最小 stub：只为让模块图可解析，不含任何行为。
 */
const HOST_PORTS = [
  ASK_QUESTION_PORT,
  CLOUD_TOKEN_PORT,
  DISPATCH_SUBAGENT_PORT,
  DRIVE_PORT,
  IM_CONTEXT_PORT,
  IM_SEND_PORT,
  QUICK_ASSISTANT_PORT,
  RUNTIME_CONTEXT_PORT,
  SCHEDULE_TOOLS_PORT,
  SKILL_TOOLS_PORT,
] as const;

/**
 * @Global 让 stub 对 AgentModule 内部的消费者（ScheduleCreateTool 等）可见——
 * overrideProvider 只能覆盖模块图里已存在的 provider，根 providers 又进不了
 * 子模块封装，宿主注入型 port 只能走全局模块。
 */
@Global()
@Module({
  providers: HOST_PORTS.map((port) => ({ provide: port, useValue: {} })),
  exports: [...HOST_PORTS],
})
class HostPortStubModule {}

async function compileAgentModule() {
  return Test.createTestingModule({
    imports: [HostPortStubModule, AgentModule],
  }).compile();
}

describe("AgentModule", () => {
  it("compiles and provides GraphRunner", async () => {
    const moduleRef = await compileAgentModule();
    expect(moduleRef.get(GraphRunner)).toBeDefined();
  });

  it("provides PromptService", async () => {
    const moduleRef = await compileAgentModule();
    expect(moduleRef.get(PromptService)).toBeDefined();
  });

  it("provides MeshbotConfigService", async () => {
    const moduleRef = await compileAgentModule();
    expect(moduleRef.get(MeshbotConfigService)).toBeDefined();
  });

  it("provides ToolRegistry", async () => {
    const moduleRef = await compileAgentModule();
    expect(moduleRef.get(ToolRegistry)).toBeDefined();
  });
});
