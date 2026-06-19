import { annotateRows } from "./message-rows";

// 用不同「日期 + 正午」时间，规避时区把同一天判成两天
const m = (senderId: string, date: string) => ({
  senderId,
  createdAt: `${date}T12:00:00.000Z`,
});

describe("annotateRows", () => {
  it("首条：分隔 + 头行", () => {
    expect(annotateRows([m("a", "2026-06-19")])).toEqual([
      { showDayDivider: true, showHeader: true },
    ]);
  });

  it("同天同发送者连续 → 后续为分组行（无分隔无头）", () => {
    const r = annotateRows([m("a", "2026-06-19"), m("a", "2026-06-19")]);
    expect(r[1]).toEqual({ showDayDivider: false, showHeader: false });
  });

  it("同天换发送者 → 头行（无分隔）", () => {
    const r = annotateRows([m("a", "2026-06-19"), m("b", "2026-06-19")]);
    expect(r[1]).toEqual({ showDayDivider: false, showHeader: true });
  });

  it("跨天 → 分隔 + 头行（即便同发送者）", () => {
    const r = annotateRows([m("a", "2026-06-19"), m("a", "2026-06-20")]);
    expect(r[1]).toEqual({ showDayDivider: true, showHeader: true });
  });
});
