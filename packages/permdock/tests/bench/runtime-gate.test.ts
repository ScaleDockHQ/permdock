import { describe, expect, it } from "vitest";

import { compareCell } from "./runtime-gate.ts";

const BASELINE = {
  instanceBuild: { medianMs: 1, runs: 100 },
  can: { medianMs: 0.01, runs: 100 },
  where: { medianMs: 2, runs: 100 },
  snapshotFor: { medianMs: 4, runs: 10 },
  snapshotBytes: 1000,
  filter100k: { measured: 100_000, totalMs: 500 },
  mayUse300: { measured: 300, totalMs: 300 },
  decideIds1000: { measured: 1000, totalMs: 20 },
};

describe("runtime gate", () => {
  it("passes a cell at the baseline and within 10%", () => {
    expect(compareCell("m1", BASELINE, BASELINE, true).failures).toStrictEqual(
      [],
    );
    const within = {
      ...BASELINE,
      instanceBuild: { medianMs: 1.1, runs: 100 },
      snapshotBytes: 1100,
      filter100k: { measured: 100_000, totalMs: 549 },
    };
    expect(compareCell("m1", BASELINE, within, true).failures).toStrictEqual(
      [],
    );
  });

  it("fails a per-call timing, a per-item timing and a snapshot over the margin", () => {
    const slower = {
      ...BASELINE,
      where: { medianMs: 2.4, runs: 100 },
      mayUse300: { measured: 300, totalMs: 400 },
      snapshotBytes: 1101,
    };
    const { failures } = compareCell("m1", BASELINE, slower, true);
    expect(failures).toHaveLength(3);
    expect(failures.join("\n")).toContain("m1 where");
    expect(failures.join("\n")).toContain("m1 mayUse300");
    expect(failures.join("\n")).toContain("m1 snapshotBytes 1101");
  });

  it("compares a capped measurement per item when it covered fewer rows", () => {
    const capped = {
      ...BASELINE,
      filter100k: { measured: 50_000, totalMs: 250 },
    };
    expect(compareCell("m1", BASELINE, capped, true).failures).toStrictEqual(
      [],
    );
    const slow = {
      ...BASELINE,
      filter100k: { measured: 50_000, totalMs: 400 },
    };
    expect(compareCell("m1", BASELINE, slow, true).failures).toHaveLength(1);
  });

  it("allows a sub-millisecond call the noise floor", () => {
    const noisy = { ...BASELINE, can: { medianMs: 0.05, runs: 100 } };
    expect(compareCell("m1", BASELINE, noisy, true).failures).toStrictEqual([]);
  });

  it("reports timings as notes on another machine and still fails the bytes", () => {
    const slower = {
      ...BASELINE,
      where: { medianMs: 9, runs: 100 },
      snapshotBytes: 2000,
    };
    const verdict = compareCell("m1", BASELINE, slower, false);
    expect(verdict.notes).toHaveLength(1);
    expect(verdict.failures).toHaveLength(1);
  });
});
