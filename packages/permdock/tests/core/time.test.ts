import { describe, expect, it } from "vitest";

import {
  assertDuration,
  durationOf,
  instantOf,
  isRfc3339,
  nowSeconds,
  rfc3339,
  secondsOf,
} from "../../src/core/time.ts";

describe("durationOf", () => {
  it.each([[1], [30], [14_400], [Number.MAX_SAFE_INTEGER]])(
    "takes %o as whole seconds",
    (input) => {
      expect(durationOf(input)).toBe(input);
    },
  );

  it.each([
    ["4h"],
    ["30"],
    [0],
    [-1],
    [1.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.MAX_SAFE_INTEGER + 1],
    [null],
    [undefined],
    [{ seconds: 5 }],
  ])("fails closed on %o", (input) => {
    expect(durationOf(input)).toBeUndefined();
  });
});

describe("assertDuration", () => {
  it("passes whole seconds above zero", () => {
    expect(() =>
      assertDuration(60, "approval.ttl on 'post.delete'"),
    ).not.toThrow();
  });

  it.each([["4h"], [0], [-60], [0.5]])(
    "throws on %o with the label",
    (input) => {
      expect(() =>
        assertDuration(input, "approval.ttl on 'post.delete'"),
      ).toThrow(
        /approval\.ttl on 'post\.delete' must be a whole number of seconds above 0/u,
      );
    },
  );
});

describe("RFC 3339", () => {
  it("round-trips whole seconds", () => {
    expect(rfc3339(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(secondsOf("2023-11-14T22:13:20Z")).toBe(1_700_000_000);
    expect(secondsOf("2023-11-14T23:13:20+01:00")).toBe(1_700_000_000);
  });

  it.each([
    ["2023-11-14"],
    ["2023-11-14 22:13:20Z"],
    ["2023-11-14T22:13:20"],
    ["2023-13-14T22:13:20Z"],
    [1_700_000_000],
    [""],
  ])("rejects %o", (input) => {
    expect(isRfc3339(input)).toBe(false);
    expect(secondsOf(input)).toBeUndefined();
  });
});

describe("instantOf", () => {
  it("reads an RFC 3339 string or an instant", () => {
    expect(instantOf("2023-11-14T22:13:20Z")).toBe(1_700_000_000);
    expect(instantOf({ epochMilliseconds: 1_700_000_000_999 })).toBe(
      1_700_000_000,
    );
  });

  it.each([
    [1_700_000_000],
    ["tomorrow"],
    [{ epochMilliseconds: Number.NaN }],
    [null],
  ])("rejects %o", (input) => {
    expect(instantOf(input)).toBeUndefined();
  });
});

describe("nowSeconds", () => {
  it("reads the instant when given, else the clock", () => {
    expect(nowSeconds({ epochMilliseconds: 1_700_000_000_500 })).toBe(
      1_700_000_000,
    );
    expect(nowSeconds()).toBeGreaterThan(1_700_000_000);
  });
});
