import {
  QUICK_ASSISTANT_PORT,
  type QuickAssistantPort,
} from "@meshbot/lib-agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { Global, Module } from "@nestjs/common";
import { QuickAssistantController } from "./controllers/quick-assistant.controller";
import { Setting } from "./entities/setting.entity";
import { QuickAssistantService } from "./services/quick-assistant.service";
import { SettingService } from "./services/setting.service";

/**
 * @Global 随手问命名模块：名字读写 REST + 改名 tool 端口绑定。
 *
 * @Global 让 QUICK_ASSISTANT_PORT 被 AgentModule 内的 rename_quick_assistant tool 解析
 * （同 SkillModule 的 SKILL_TOOLS_PORT 范式）。改名 tool → port.rename → setName
 * （写 Setting + 发 ws renamed 事件）。
 */
@Global()
@Module({
  imports: [TxTypeOrmModule.forFeature([Setting])],
  controllers: [QuickAssistantController],
  providers: [
    SettingService,
    QuickAssistantService,
    {
      provide: QUICK_ASSISTANT_PORT,
      useFactory: (svc: QuickAssistantService): QuickAssistantPort => ({
        rename: (name: string) => svc.setName(name),
      }),
      inject: [QuickAssistantService],
    },
  ],
  exports: [QUICK_ASSISTANT_PORT, QuickAssistantService],
})
export class QuickAssistantModule {}
