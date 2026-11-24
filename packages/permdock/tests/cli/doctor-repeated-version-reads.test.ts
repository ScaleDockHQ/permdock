import { describe, expect, it } from "vitest";

import { pd130 } from "../../src/cli/doctor/repeated-version-reads.ts";

const FOR = `import { permdockFor } from "better-supabase/next";
export const resolve = permdockFor(policy, { memberships });
`;
const OWN = `import { getPermDock } from "permdock";
export const instance = (claims) =>
  getPermDock(policy, claims, { memberships, intent: "write" });
`;
const PLAIN = `export const instance = (claims) => getPermDock(policy, claims, { tenant });\n`;

describe("PD130 repeated version reads", () => {
  it("flags an instance with its own sources next to permdockFor", () => {
    const findings = pd130([
      { file: "lib/for.ts", text: FOR },
      { file: "lib/own.ts", text: OWN },
    ]);
    expect(findings.map((finding) => finding.target)).toStrictEqual([
      "lib/own.ts:3",
    ]);
    expect(findings[0]?.message).toContain("own memberships");
  });

  it("stays quiet without permdockFor, and for an instance that takes no source", () => {
    expect(pd130([{ file: "lib/own.ts", text: OWN }])).toStrictEqual([]);
    expect(
      pd130([
        { file: "lib/for.ts", text: FOR },
        { file: "lib/plain.ts", text: PLAIN },
      ]),
    ).toStrictEqual([]);
  });
});
