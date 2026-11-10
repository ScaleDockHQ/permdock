import { describe, expect, it } from "vitest";

import { gzipOverCeiling } from "./ceiling.ts";

describe("gzip ceiling", () => {
  it("allows a growth of 1%", () => {
    expect(gzipOverCeiling({ entry: 101 }, { entry: 100 })).toStrictEqual([]);
  });

  it("rejects a growth past 1%", () => {
    expect(gzipOverCeiling({ entry: 102 }, { entry: 100 })).toStrictEqual([
      "entry: 102 gzip bytes is over 1% past the recorded 100",
    ]);
  });

  it("allows a shrink without a new record", () => {
    expect(gzipOverCeiling({ entry: 50 }, { entry: 100 })).toStrictEqual([]);
  });

  it("rejects an entry on only one side", () => {
    expect(gzipOverCeiling({ added: 10 }, { removed: 10 })).toStrictEqual([
      "removed: recorded, not measured",
      "added: measured, not recorded",
    ]);
  });
});
