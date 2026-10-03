import { describe, expect, it } from "vitest";

import { parseDuration } from "../../src/core/duration.ts";

describe("parseDuration", () => {
  it.each([
    ["30s", 30],
    ["15m", 900],
    [" 4h ", 14_400],
    ["7d", 604_800],
    ["2w", 1_209_600],
    [90, 90],
    [1.9, 1],
  ])("parses %o as %o seconds", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each([
    ["0s"],
    ["-5m"],
    ["5y"],
    ["5"],
    ["1.5h"],
    [""],
    [0],
    [-1],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [null],
    [{ seconds: 5 }],
  ])("fails closed on %o", (input) => {
    expect(parseDuration(input)).toBeUndefined();
  });
});
