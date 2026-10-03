import { describe, expect, it } from "vitest";

import { shortDiff } from "../../src/cli/text-diff.ts";

function lines(count: number, prefix: string): string {
  return `${Array.from({ length: count }, (_, i) => `${prefix}${i}`).join("\n")}\n`;
}

describe("shortDiff", () => {
  it("labels both sides and drops the separator line", () => {
    const diff = shortDiff("a.sql", "one\n", "two\n");
    expect(diff).toContain("--- a.sql (on disk)");
    expect(diff).toContain("+++ a.sql (generated)");
    expect(diff).toContain("-one");
    expect(diff).toContain("+two");
    expect(diff).not.toContain("====");
  });

  it("caps a long diff and counts what it left out", () => {
    const many = shortDiff("a.sql", lines(30, "old"), lines(30, "new"));
    expect(many.split("\n")).toHaveLength(41);
    expect(many).toMatch(/… \d+ more diff lines$/u);
    const oneOver = shortDiff("a.sql", lines(19, "old"), lines(19, "new"));
    expect(oneOver).toMatch(/… 1 more diff line$/u);
  });
});
