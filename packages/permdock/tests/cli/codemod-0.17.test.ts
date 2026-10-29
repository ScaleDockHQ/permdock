import { describe, expect, it } from "vitest";

import { rewriteLiterals017 } from "../../src/cli/codemod/shapes-0.17.ts";

describe("codemod 0.17 literals", () => {
  it("rewrites legacy membership literals under the scope aliases", () => {
    const input = `const user = {
  memberships: [
    { tenant: "acme", roles: ["admin"] },
    { tenant: org, team: "t1", roles: ["member"], via: "sso" },
    { scope: "organization", id: "acme", roles: [] },
  ],
};
const role = { name: "auditor", tenant: "acme", grants: [] };
const credential = { kind: "service", tenant: "acme", roles: [] };
const merged = { ...base, tenant, roles };
const row = { team: { id: "t2" }, roles: ["member"] };
`;
    const result = rewriteLiterals017("a.ts", input);
    expect(result.source).toBe(`const user = {
  memberships: [
    { scope: "tenant", id: "acme", roles: ["admin"] },
    { within: { tenant: org }, scope: "team", id: "t1", roles: ["member"], via: "sso" },
    { scope: "organization", id: "acme", roles: [] },
  ],
};
const role = { name: "auditor", tenant: "acme", grants: [] };
const credential = { kind: "service", tenant: "acme", roles: [] };
const merged = { ...base, tenant, roles };
const row = { team: { id: "t2" }, roles: ["member"] };
`);
    expect(result.changes).toHaveLength(3);
  });

  it("renames mode to combine and distinct to mode on approval options", () => {
    const input = `allow(p.refund, { approval: { stages: [{ by: role("cfo") }], mode: "sequential", distinct: false } });
allow(p.pay, { approval: { by: role("cfo"), distinct: true, quorum: 2 } });
allow(p.ship, { approval: { by: role("ops"), mode: "confirm" } });
allow(p.void, { approval: { by: role("ops"), distinct: flag } });
type M = ApprovalMode;
`;
    const result = rewriteLiterals017("b.ts", input);
    expect(result.source)
      .toBe(`allow(p.refund, { approval: { stages: [{ by: role("cfo") }], combine: "sequential", mode: "confirm" } });
allow(p.pay, { approval: { by: role("cfo"), quorum: 2 } });
allow(p.ship, { approval: { by: role("ops"), mode: "confirm" } });
allow(p.void, { approval: { by: role("ops"), distinct: flag } });
type M = ApprovalMode;
`);
    expect(result.followUps.map((item) => item.name)).toStrictEqual([
      "distinct",
      "ApprovalMode",
    ]);
  });

  it("leaves a file it cannot parse as it is", () => {
    const input = "const = {";
    expect(rewriteLiterals017("c.ts", input).source).toBe(input);
  });
});
