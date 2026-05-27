import { vi } from "vitest";
import type { ToolContext } from "../tool.types";
import { ScheduleCreateTool } from "./schedule-create.tool";
import { ScheduleDeleteTool } from "./schedule-delete.tool";
import { ScheduleListTool } from "./schedule-list.tool";

function fakeCtx(sessionId: string): ToolContext {
  return {
    sessionId,
    messageId: "m1",
    toolCallId: "tc1",
    emitter: {} as never,
    signal: new AbortController().signal,
  };
}

describe("schedule tools", () => {
  it("schedule_create 用 ctx.sessionId 绑定；缺省 timezone = OS", async () => {
    const port = {
      create: vi.fn().mockResolvedValue({ id: "j1", nextFireAt: new Date() }),
      listBySession: vi.fn(),
      findOwnedBy: vi.fn(),
      delete: vi.fn(),
    };
    const tool = new ScheduleCreateTool(port);
    const out = await tool.execute(
      {
        title: "morning",
        kind: "cron",
        cronExpr: "0 7 * * *",
        prompt: "good morning",
      },
      fakeCtx("session-A"),
    );
    expect(port.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-A",
        timezone: expect.any(String),
      }),
    );
    expect(out).toMatch(/Created scheduled job j1/);
  });

  it("schedule_list 只列当前 session", async () => {
    const port = {
      create: vi.fn(),
      listBySession: vi.fn().mockResolvedValue([
        {
          id: "j1",
          sessionId: "session-A",
          title: "t",
          prompt: "p",
          kind: "cron",
          cronExpr: "0 7 * * *",
          timezone: "UTC",
          runAt: null,
          enabled: true,
          lastFiredAt: null,
          nextFireAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]),
      findOwnedBy: vi.fn(),
      delete: vi.fn(),
    };
    const tool = new ScheduleListTool(port);
    const out = await tool.execute({}, fakeCtx("session-A"));
    expect(port.listBySession).toHaveBeenCalledWith("session-A");
    expect(out).toMatch(/j1/);
  });

  it("schedule_delete 越权 → 返回 Error 字串", async () => {
    const port = {
      create: vi.fn(),
      listBySession: vi.fn(),
      findOwnedBy: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
    };
    const tool = new ScheduleDeleteTool(port);
    const out = await tool.execute({ id: "j-other" }, fakeCtx("session-A"));
    expect(out).toMatch(/Error: job j-other not found/);
    expect(port.delete).not.toHaveBeenCalled();
  });

  it("schedule_delete 合法删除", async () => {
    const port = {
      create: vi.fn(),
      listBySession: vi.fn(),
      findOwnedBy: vi.fn().mockResolvedValue({ id: "j1" }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const tool = new ScheduleDeleteTool(port);
    const out = await tool.execute({ id: "j1" }, fakeCtx("session-A"));
    expect(port.delete).toHaveBeenCalledWith("j1");
    expect(out).toMatch(/Deleted j1/);
  });
});
