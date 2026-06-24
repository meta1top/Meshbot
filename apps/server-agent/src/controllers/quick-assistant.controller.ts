import type { QuickAssistantName } from "@meshbot/types-agent";
import { Body, Controller, Get, Patch } from "@nestjs/common";
import { RenameQuickAssistantDto } from "../dto/quick-assistant.dto";
import { QuickAssistantService } from "../services/quick-assistant.service";

/** 随手问命名 REST。瘦 Controller —— 逻辑在 QuickAssistantService。 */
@Controller("api/quick-assistant")
export class QuickAssistantController {
  constructor(private readonly service: QuickAssistantService) {}

  /** 取随手问当前名字（未设置返回默认名）。 */
  @Get("name")
  async getName(): Promise<QuickAssistantName> {
    return { name: await this.service.getName() };
  }

  /** 改随手问名字（持久化 + ws 实时推送，多窗口/agent 改名一致刷新）。 */
  @Patch("name")
  async rename(
    @Body() dto: RenameQuickAssistantDto,
  ): Promise<QuickAssistantName> {
    await this.service.setName(dto.name);
    return { name: dto.name };
  }
}
