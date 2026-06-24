import {
  QUICK_ASSISTANT_DEFAULT_NAME,
  QUICK_ASSISTANT_EVENTS,
  type QuickAssistantRenamedEvent,
} from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SettingService } from "./setting.service";

/** 随手问名字存储键（Setting，账号作用域）。 */
export const QUICK_ASSISTANT_NAME_KEY = "quick_assistant_name";

/**
 * 随手问命名服务：名字读写（基于账号级 Setting）+ 改名实时事件。
 *
 * 改名集中于 setName：写 Setting 后经 EventEmitter2 发 QUICK_ASSISTANT_EVENTS.renamed，
 * EventsGateway 据此下行到 acct 房间，浏览器 dock 标题实时刷新（agent 改名/UI 改名一致）。
 */
@Injectable()
export class QuickAssistantService {
  constructor(
    private readonly setting: SettingService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** 取随手问名字；未设置返回默认名。 */
  async getName(): Promise<string> {
    return (
      (await this.setting.get(QUICK_ASSISTANT_NAME_KEY)) ??
      QUICK_ASSISTANT_DEFAULT_NAME
    );
  }

  /**
   * 改名：写 Setting + 发 ws renamed 事件（实时刷新 dock 标题）。
   * 必须在账号上下文内调用（emit 经 EventsGateway 路由到当前账号 acct 房间）。
   * 单表（setting）写入，无需 @Transactional。
   */
  async setName(name: string): Promise<void> {
    await this.setting.set(QUICK_ASSISTANT_NAME_KEY, name);
    this.emitter.emit(QUICK_ASSISTANT_EVENTS.renamed, {
      name,
    } satisfies QuickAssistantRenamedEvent);
  }
}
