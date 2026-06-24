import {
  QUICK_ASSISTANT_DEFAULT_NAME,
  QUICK_ASSISTANT_EVENTS,
} from "@meshbot/types-agent";
import type { EventEmitter2 } from "@nestjs/event-emitter";
import {
  QUICK_ASSISTANT_NAME_KEY,
  QuickAssistantService,
} from "./quick-assistant.service";
import type { SettingService } from "./setting.service";

function make() {
  const store = new Map<string, string>();
  const setting = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
  } as unknown as SettingService;
  const emit = jest.fn();
  const emitter = { emit } as unknown as EventEmitter2;
  return {
    svc: new QuickAssistantService(setting, emitter),
    setting,
    emit,
    store,
  };
}

describe("QuickAssistantService", () => {
  it("getName 未设置 → 返回默认名", async () => {
    const { svc } = make();
    expect(await svc.getName()).toBe(QUICK_ASSISTANT_DEFAULT_NAME);
  });

  it("setName 写 Setting + 发 renamed 事件；getName 返回新名", async () => {
    const { svc, setting, emit, store } = make();
    await svc.setName("小M");
    expect(setting.set).toHaveBeenCalledWith(QUICK_ASSISTANT_NAME_KEY, "小M");
    expect(store.get(QUICK_ASSISTANT_NAME_KEY)).toBe("小M");
    expect(emit).toHaveBeenCalledWith(QUICK_ASSISTANT_EVENTS.renamed, {
      name: "小M",
    });
    expect(await svc.getName()).toBe("小M");
  });
});
