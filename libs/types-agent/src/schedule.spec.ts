import {
  CreateCronJobSchema,
  CronJobListResponseSchema,
  PatchCronJobSchema,
} from "./schedule";

describe("schedule schemas", () => {
  it("CreateCronJobSchema：kind=cron 缺 cronExpr → 报错", () => {
    const r = CreateCronJobSchema.safeParse({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
    });
    expect(r.success).toBe(false);
  });

  it("CreateCronJobSchema：kind=once 缺 runAt → 报错", () => {
    const r = CreateCronJobSchema.safeParse({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "once",
    });
    expect(r.success).toBe(false);
  });

  it("CreateCronJobSchema：cron 合法", () => {
    const r = CreateCronJobSchema.safeParse({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "Asia/Shanghai",
    });
    expect(r.success).toBe(true);
  });

  it("PatchCronJobSchema：全空 → 报错", () => {
    expect(PatchCronJobSchema.safeParse({}).success).toBe(false);
  });

  it("CronJobListResponseSchema：空列表合法", () => {
    expect(CronJobListResponseSchema.safeParse({ jobs: [] }).success).toBe(
      true,
    );
  });
});
