import { describe, expect, it } from "vitest";

import { rowCheckFrom, rowCheckOf } from "../../src/conditions/row-check.ts";

describe("row checks", () => {
  it("tells a missing row from a denied one", () => {
    expect(rowCheckFrom([])).toEqual({ found: false });
    expect(rowCheckFrom([{ granted: true }])).toEqual({
      found: true,
      granted: true,
    });
    expect(rowCheckFrom([{ granted: 1 }])).toEqual({
      found: true,
      granted: true,
    });
    expect(rowCheckOf(false, true)).toEqual({ found: false });
  });

  it("grants only on true or 1", () => {
    for (const granted of [false, 0, "t", "true", null, undefined]) {
      expect(rowCheckFrom([{ granted }])).toEqual({
        found: true,
        granted: false,
      });
    }
  });

  it("throws when the key matches more than one row", () => {
    expect(() => rowCheckFrom([{ granted: true }, { granted: true }])).toThrow(
      /more than one row/u,
    );
  });
});
