import { expect, test } from "vitest";
import { parseArgs } from "../src/args.js";

test("verb + flags + value flags", () => {
  const r = parseArgs([
    "post",
    "--site",
    "x",
    "--text",
    "hi there",
    "--confirm",
  ]);
  expect(r.verb).toBe("post");
  expect(r.flags.site).toBe("x");
  expect(r.flags.text).toBe("hi there");
  expect(r.flags.confirm).toBe(true);
});

test("missing verb", () => {
  expect(parseArgs([]).verb).toBeUndefined();
});

test("repeated flag collects array", () => {
  const r = parseArgs(["post", "--image", "a.png", "--image", "b.png"]);
  expect(r.flags.image).toEqual(["a.png", "b.png"]);
});
