import { expect, test } from "vitest";
import {
  actionDelay,
  mousePath,
  RateLimiter,
  typingIntervals,
} from "../src/humanize.js";

test("actionDelay within bounds + varies", () => {
  const vals = new Set();
  for (let i = 0; i < 200; i++) {
    const d = actionDelay(0.4, 1.5);
    expect(d).toBeGreaterThanOrEqual(0.4);
    expect(d).toBeLessThanOrEqual(1.5);
    vals.add(Math.round(d * 1000));
  }
  expect(vals.size).toBeGreaterThan(20);
});

test("typingIntervals length + bounds", () => {
  const iv = typingIntervals("hello");
  expect(iv).toHaveLength(5);
  expect(iv.every((x) => x >= 0.02 && x <= 0.5)).toBe(true);
});

test("RateLimiter sliding window + per key + eviction", () => {
  let now = 100;
  const rl = new RateLimiter(1, 10, () => now);
  expect(rl.allow("x")).toBe(true);
  expect(rl.allow("x")).toBe(false);
  expect(rl.allow("y")).toBe(true);
  now = 111;
  expect(rl.allow("x")).toBe(true);
});

test("mousePath starts/ends right + has intermediate steps", () => {
  const p = mousePath({ x: 0, y: 0 }, { x: 100, y: 50 }, 6);
  expect(p[0]).toEqual({ x: 0, y: 0 });
  expect(p[p.length - 1]).toEqual({ x: 100, y: 50 });
  expect(p.length).toBe(7);
});
