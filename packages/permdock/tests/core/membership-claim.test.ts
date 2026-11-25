import { describe, expect, it } from "vitest";

import { claimsSize } from "../../src/cli/claims-size.ts";
import {
  compactMemberships,
  expandMemberships,
  longId,
  shortId,
} from "../../src/core/membership-claim.ts";
import { readMemberships } from "../../src/core/read-memberships.ts";

const UUID = "8f14e45f-ceea-467a-9575-1a5d8d3b6c1e";

describe("compact memberships claim", () => {
  it("writes a UUID as 22 characters and keeps any other id", () => {
    expect(shortId(UUID)).toHaveLength(22);
    expect(longId(shortId(UUID))).toBe(UUID);
    expect(shortId("org-1")).toBe("=org-1");
    expect(longId("=org-1")).toBe("org-1");
    expect(longId("not an id")).toBeUndefined();
  });

  it("round-trips plain entries and keeps richer ones as objects", () => {
    const entries = [
      { scope: "organization", id: UUID, roles: ["owner", "admin"] },
      { scope: "project", id: "p-1", roles: ["viewer"], via: "staff" },
      {
        scope: "project",
        id: "p-2",
        roles: ["viewer"],
        within: { organization: UUID },
      },
    ];
    const claim = compactMemberships(entries);
    expect(claim).toMatchObject({ s: ["organization", "project"] });
    expect(JSON.stringify(claim).length).toBeLessThan(
      JSON.stringify(entries).length,
    );
    const back = readMemberships(claim).memberships;
    expect(back).toHaveLength(3);
    expect(back[0]).toMatchObject({ scope: "organization", id: UUID });
    expect(back[0]?.roles).toStrictEqual(["owner", "admin"]);
    expect(back[1]).toMatchObject({ id: "p-1", via: "staff" });
    expect(back[2]?.within).toStrictEqual({ organization: UUID });
  });

  it("leaves an array claim and an empty claim as they are", () => {
    const array = [{ scope: "organization", id: "a", roles: ["owner"] }];
    expect(expandMemberships(array)).toBe(array);
    expect(compactMemberships([])).toStrictEqual([]);
  });

  it("drops a row whose index does not resolve", () => {
    const read = readMemberships({
      s: ["organization"],
      r: ["owner"],
      e: [[3, "=a", -1, 0]],
    });
    expect(read.memberships).toStrictEqual([]);
    expect(read.dropped).toStrictEqual([0]);
  });

  it("fits more memberships of the claims-size model than the array", () => {
    const report = claimsSize({
      memberships: 100,
      roles: 1,
      scope: "organization",
      budget: 1024,
    });
    expect(report.compactFits).toBeGreaterThan(report.fits * 2);
  });
});
