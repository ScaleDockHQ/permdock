import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Instant } from "../../src/core/time.ts";

import { branchClauses } from "../../src/cli/sql/clauses.ts";
import { compileGrants } from "../../src/cli/sql/compile.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  getPermDockSync,
  definePermissions,
  definePolicy,
  deny,
  fromSnapshot,
  resource,
  role,
} from "../../src/index.ts";
import { defined } from "../support/defined.ts";

const at = (seconds: number): Instant => ({
  epochMilliseconds: seconds * 1000,
});

const Doc = z.object({ id: z.string(), locked: z.boolean() });
const permissions = definePermissions({
  doc: resource(Doc, { id: "id", actions: ["read", "update", "delete"] }),
});
const doc = { id: "d1", locked: false };
const subject = (user: { id: string; roles: string[] }) => user;

const FROM = Date.parse("2026-03-01T00:00:00Z") / 1000;
const UNTIL = Date.parse("2026-04-01T00:00:00Z") / 1000;
const UNTIL_AT = "2026-04-01T00:00:00Z";
const UNTIL_INSTANT = { epochMilliseconds: UNTIL * 1000 };
const WINDOW = {
  from: "2026-03-01T00:00:00.000Z",
  until: "2026-04-01T00:00:00.000Z",
};
const before = FROM - 60;
const during = FROM + 60;
const after = UNTIL + 60;

const policy = definePolicy(permissions, {
  roles: [
    role("contractor", [
      allow(permissions.doc.read, {
        validFrom: "2026-03-01T00:00:00Z",
        validUntil: "2026-04-01T00:00:00Z",
      }),
      allow(permissions.doc.update, { validUntil: UNTIL_INSTANT }),
      allow(permissions.doc.delete),
      deny(permissions.doc.delete, { validUntil: UNTIL_AT, name: "freeze" }),
    ]),
  ],
  subject,
});

async function contractor() {
  return getPermDockSync(policy, { id: "u1", roles: ["contractor"] });
}

describe("grant validity", () => {
  it("normalises RFC 3339 and Instant bounds to seconds", () => {
    const [read, update] = policy.grants.filter(
      (grant) => grant.effect === "allow" && grant.role === "contractor",
    );
    expect(read?.validity).toStrictEqual({ from: FROM, until: UNTIL });
    expect(update?.validity).toStrictEqual({ until: UNTIL });
    expect(Object.isFrozen(read?.validity)).toBe(true);
  });

  it("rejects a bound that does not parse", () => {
    expect(() =>
      definePolicy(permissions, {
        roles: [
          role("r", [allow(permissions.doc.read, { validFrom: "tomorrow" })]),
        ],
        subject,
      }),
    ).toThrow(
      "validFrom on 'doc.read' must be an RFC 3339 string or an Instant",
    );
    expect(() =>
      definePolicy(permissions, {
        roles: [
          role("r", [
            // SAFETY: Unix seconds are what a caller without types might still pass.
            allow(permissions.doc.read, { validUntil: UNTIL as never }),
          ]),
        ],
        subject,
      }),
    ).toThrow("validUntil on 'doc.read'");
    expect(() =>
      definePolicy(permissions, {
        roles: [
          role("r", [
            allow(permissions.doc.read, {
              validUntil: { epochMilliseconds: Number.NaN },
            }),
          ]),
        ],
        subject,
      }),
    ).toThrow("validUntil on 'doc.read'");
  });

  it("rejects a window that ends before it starts", () => {
    expect(() =>
      definePolicy(permissions, {
        roles: [
          role("r", [
            allow(permissions.doc.read, {
              validFrom: UNTIL_AT,
              validUntil: "2026-03-01T00:00:00Z",
            }),
          ]),
        ],
        subject,
      }),
    ).toThrow("must be after validFrom");
  });

  it("grants inside the window, from inclusive and until exclusive", async () => {
    const permdock = await contractor();
    expect(permdock.can(permissions.doc.read, doc, { now: at(FROM) })).toBe(
      true,
    );
    expect(permdock.can(permissions.doc.read, doc, { now: at(during) })).toBe(
      true,
    );
    expect(permdock.can(permissions.doc.read, doc, { now: at(UNTIL) })).toBe(
      false,
    );
  });

  it("denies an inactive allow with inactive-grant and the window", async () => {
    const permdock = await contractor();
    for (const now of [before, after]) {
      const decision = permdock.decide(permissions.doc.read, doc, {
        now: at(now),
      });
      expect(decision.outcome).toBe("denied");
      if (decision.outcome === "denied") {
        expect(decision.denials).toStrictEqual([
          { role: "contractor", reason: "inactive-grant", detail: WINDOW },
        ]);
      }
    }
  });

  it("does not apply an expired deny and records it as skipped", async () => {
    const permdock = await contractor();
    expect(permdock.can(permissions.doc.delete, doc, { now: at(during) })).toBe(
      false,
    );
    const explained = permdock.explain(permissions.doc.delete, doc, {
      now: at(after),
    });
    expect(explained.outcome).toBe("granted");
    expect(explained.trace.skipped).toStrictEqual([
      {
        role: "contractor",
        permission: "doc.delete",
        effect: "deny",
        why: "validity",
      },
    ]);
  });

  it("takes a Temporal.Instant as now", async () => {
    const permdock = await contractor();
    const inside = Temporal.Instant.fromEpochMilliseconds(during * 1000);
    expect(permdock.can(permissions.doc.read, doc, { now: inside })).toBe(true);
  });

  it.each<[string, unknown]>([
    ["Unix seconds", during],
    ["a Date", new Date(during * 1000)],
    ["a NaN instant", { epochMilliseconds: Number.NaN }],
  ])("denies with validation when now is %s", async (_, now) => {
    const permdock = await contractor();
    // SAFETY: the values test what a caller without types can pass.
    const options = { now: now as Instant };
    const decision = permdock.decide(permissions.doc.read, doc, options);
    expect(decision.outcome).toBe("denied");
    if (decision.outcome === "denied") {
      expect(decision.denials[0]?.reason).toBe("validation");
    }
    expect(permdock.can(permissions.doc.update, doc, options)).toBe(false);
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("unsigned snapshot expected");
    }
    const client = fromSnapshot(snapshot);
    expect(client.decide(permissions.doc.read, doc, options).outcome).toBe(
      "denied",
    );
    expect(client.can(permissions.doc.update, doc, options)).toBe(false);
  });

  it("reads the whole simulate batch as of now", async () => {
    const permdock = await contractor();
    const checks = [
      [permissions.doc.read, doc],
      [permissions.doc.update, doc],
    ] as const;
    expect(
      permdock.simulate(checks, { now: at(during) }).map((d) => d.outcome),
    ).toStrictEqual(["granted", "granted"]);
    expect(
      permdock.simulate(checks, { now: at(after) }).map((d) => d.outcome),
    ).toStrictEqual(["denied", "denied"]);
  });

  it("carries validity into the snapshot and evaluates it there", async () => {
    const permdock = await contractor();
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("unsigned snapshot expected");
    }
    const read = snapshot.grants.find(
      (grant) => grant.permission === "doc.read",
    );
    expect(read?.validity).toStrictEqual(WINDOW);
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.doc.read, doc, { now: at(during) })).toBe(
      true,
    );
    const decision = client.decide(permissions.doc.read, doc, {
      now: at(after),
    });
    expect(decision.outcome).toBe("denied");
    if (decision.outcome === "denied") {
      expect(decision.denials[0]?.reason).toBe("inactive-grant");
    }
    expect(
      client.simulate([[permissions.doc.read, doc]], { now: at(before) })[0]
        ?.outcome,
    ).toBe("denied");
    expect(client.can(permissions.doc.delete, doc, { now: at(after) })).toBe(
      true,
    );
  });

  it("keeps a deny with a malformed wire window in force on the client", async () => {
    const permdock = await contractor();
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("unsigned snapshot expected");
    }
    const grants = snapshot.grants.filter((grant) => grant.effect !== "deny");
    for (const grant of snapshot.grants) {
      if (grant.effect === "deny") {
        grants.push(Object.assign({}, grant, { validity: { until: "x" } }));
      }
    }
    const corrupted = { ...snapshot, grants };
    const client = fromSnapshot(corrupted);
    expect(client.can(permissions.doc.delete, doc, { now: at(during) })).toBe(
      false,
    );
    expect(client.can(permissions.doc.delete, doc, { now: at(after) })).toBe(
      false,
    );
  });

  it("drops inactive grants from where()", async () => {
    const expired = definePolicy(permissions, {
      roles: [
        role("contractor", [
          allow(permissions.doc.read, { validUntil: "2000-01-01T00:00:00Z" }),
          allow(permissions.doc.update),
          deny(permissions.doc.update, {
            where: { locked: true },
            validUntil: "2000-01-01T00:00:00Z",
          }),
        ]),
      ],
      subject,
    });
    const permdock = getPermDockSync(expired, {
      id: "u1",
      roles: ["contractor"],
    });
    expect(permdock.where(permissions.doc.read).condition).toStrictEqual({
      op: "or",
      conditions: [],
    });
    expect(
      JSON.stringify(permdock.where(permissions.doc.update)),
    ).not.toContain("locked");
  });

  it("includes validity in the policy fingerprint", () => {
    const other = definePolicy(permissions, {
      roles: [
        role("contractor", [
          allow(permissions.doc.read, {
            validFrom: "2026-03-01T00:00:00Z",
            validUntil: "2026-05-01T00:00:00Z",
          }),
          allow(permissions.doc.update, { validUntil: UNTIL_INSTANT }),
          allow(permissions.doc.delete),
          deny(permissions.doc.delete, {
            validUntil: UNTIL_AT,
            name: "freeze",
          }),
        ]),
      ],
      subject,
    });
    expect(other.fingerprint).not.toBe(policy.fingerprint);
  });

  it("compiles the window into the RLS access check", () => {
    const { branches } = compileGrants(
      policy,
      {
        dialect: "supabase",
        tenantClaim: "tenant",
        scopes: scopeList(undefined),
        gucPrefix: "permdock",
      },
      undefined,
      [],
      false,
    );
    const read = branches.find(
      (branch) =>
        branch.permissionKey === "doc.read" && branch.command === "select",
    );
    const update = branches.find(
      (branch) => branch.permissionKey === "doc.update",
    );
    const freeze = branches.find(
      (branch) =>
        branch.permissionKey === "doc.delete" && branch.effect === "deny",
    );
    expect(read?.access).toContain(`now() >= to_timestamp(${FROM})`);
    expect(read?.access).toContain(`now() < to_timestamp(${UNTIL})`);
    expect(update?.access).toContain(`now() < to_timestamp(${UNTIL})`);
    expect(update?.access).not.toContain("now() >=");
    expect(freeze?.access).toContain(`now() < to_timestamp(${UNTIL})`);
    expect(branchClauses(defined(read)).using).toContain("to_timestamp");
  });
});
