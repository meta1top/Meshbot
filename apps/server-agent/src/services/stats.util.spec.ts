import {
  computeStreaks,
  localDateKey,
  pickPeakHour,
  rangeToSince,
} from "./stats.util";

describe("stats.util", () => {
  it("rangeToSince: all 返回 null；7d/30d 返回 now 往前 N 天", () => {
    const now = new Date("2026-05-27T10:00:00Z");
    expect(rangeToSince("all", now)).toBeNull();
    expect(rangeToSince("7d", now)?.toISOString()).toBe(
      new Date("2026-05-20T10:00:00Z").toISOString(),
    );
    expect(rangeToSince("30d", now)?.toISOString()).toBe(
      new Date("2026-04-27T10:00:00Z").toISOString(),
    );
  });

  it("localDateKey: 本地 YYYY-MM-DD", () => {
    const d = new Date(2026, 4, 7, 23, 30); // 本地 5/7
    expect(localDateKey(d)).toBe("2026-05-07");
  });

  it("computeStreaks: current 从今天往前数连续，longest 取全局最长", () => {
    const dates = ["2026-05-25", "2026-05-26", "2026-05-27", "2026-05-20"];
    expect(computeStreaks(dates, "2026-05-27")).toEqual({
      current: 3,
      longest: 3,
    });
  });

  it("computeStreaks: 今天无活动则 current=0", () => {
    const dates = ["2026-05-24", "2026-05-25"];
    expect(computeStreaks(dates, "2026-05-27")).toEqual({
      current: 0,
      longest: 2,
    });
  });

  it("computeStreaks: 空集合返回 0/0", () => {
    expect(computeStreaks([], "2026-05-27")).toEqual({
      current: 0,
      longest: 0,
    });
  });

  it("pickPeakHour: 取计数最大的小时；全 0 返回 null", () => {
    const byHour = Array.from({ length: 24 }, () => 0);
    expect(pickPeakHour(byHour)).toBeNull();
    byHour[18] = 5;
    byHour[9] = 3;
    expect(pickPeakHour(byHour)).toBe(18);
  });
});
