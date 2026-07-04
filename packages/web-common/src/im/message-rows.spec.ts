import { annotateRows } from "./message-rows";

const byKey = (m: { key: string }) => m.key;

describe("annotateRows", () => {
  it("首条:显日期分隔 + 显头", () => {
    expect(
      annotateRows([{ createdAt: "2026-07-05T12:00:00", key: "a" }], byKey),
    ).toEqual([{ showDayDivider: true, showHeader: true }]);
  });

  it("同天同 key 连续第二条:并入(不显分隔、不显头)", () => {
    const out = annotateRows(
      [
        { createdAt: "2026-07-05T12:00:00", key: "a" },
        { createdAt: "2026-07-05T12:05:00", key: "a" },
      ],
      byKey,
    );
    expect(out[1]).toEqual({ showDayDivider: false, showHeader: false });
  });

  it("同天换 key:不显分隔但显头", () => {
    const out = annotateRows(
      [
        { createdAt: "2026-07-05T12:00:00", key: "a" },
        { createdAt: "2026-07-05T12:05:00", key: "b" },
      ],
      byKey,
    );
    expect(out[1]).toEqual({ showDayDivider: false, showHeader: true });
  });

  it("跨天(即使同 key):显分隔 + 显头", () => {
    const out = annotateRows(
      [
        { createdAt: "2026-07-05T12:00:00", key: "a" },
        { createdAt: "2026-07-06T12:00:00", key: "a" },
      ],
      byKey,
    );
    expect(out[1]).toEqual({ showDayDivider: true, showHeader: true });
  });

  it("空数组返回空", () => {
    expect(annotateRows([], byKey)).toEqual([]);
  });
});
