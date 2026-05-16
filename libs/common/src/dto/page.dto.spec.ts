import "reflect-metadata";
import { PageRequestSchema } from "@meshbot/types";

import { pageify } from "./page.dto";

describe("PageRequestSchema", () => {
  it("默认 page=1 size=20", () => {
    const parsed = PageRequestSchema.parse({});
    expect(parsed).toEqual({ page: 1, size: 20 });
  });

  it("coerce 字符串 query 为 number", () => {
    const parsed = PageRequestSchema.parse({ page: "3", size: "50" });
    expect(parsed).toEqual({ page: 3, size: 50 });
  });

  it("page 越界（0）报错", () => {
    expect(() => PageRequestSchema.parse({ page: 0 })).toThrow();
  });

  it("size 越界（>100）报错", () => {
    expect(() => PageRequestSchema.parse({ size: 200 })).toThrow();
  });

  it("page 越界（>10000）报错", () => {
    expect(() => PageRequestSchema.parse({ page: 99999 })).toThrow();
  });
});

describe("pageify", () => {
  it("打包 items + total", () => {
    expect(pageify([{ id: "a" }, { id: "b" }], 42)).toEqual({
      items: [{ id: "a" }, { id: "b" }],
      total: 42,
    });
  });

  it("空数组也 OK", () => {
    expect(pageify([], 0)).toEqual({ items: [], total: 0 });
  });
});
