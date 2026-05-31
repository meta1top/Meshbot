import { expect, test } from "vitest";
import { resolvePlatform } from "../src/platforms/index.js";

test("resolvePlatform known/unknown", () => {
  expect(resolvePlatform("x")).toBeTruthy();
  expect(() => resolvePlatform("nope")).toThrow();
});
