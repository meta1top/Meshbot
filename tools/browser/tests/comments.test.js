import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { writeCommentsFile } from "../src/comments.js";

test("writeCommentsFile writes json + returns summary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmt-"));
  const items = [
    { author: "a", text: "好" },
    { author: "b", text: "一般" },
  ];
  const r = writeCommentsFile(items, { outDir: dir, site: "x" });
  expect(r.count).toBe(2);
  expect(fs.existsSync(r.file)).toBe(true);
  expect(JSON.parse(fs.readFileSync(r.file, "utf8"))).toHaveLength(2);
});
