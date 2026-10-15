import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DecisionSink } from "../../src/core/interfaces.ts";
import type { PrincipalSource } from "../../src/core/principal-source.ts";
import type { Principal, Subject } from "../../src/core/subject.ts";

import { allow } from "../../src/core/grant-builders.ts";
import { limits, memoryLimitStore } from "../../src/core/limits.ts";
import { memoryMembershipSource } from "../../src/core/memory-sources.ts";
import { createPermDock, fromSnapshot } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { memoryPrincipalSource } from "../../src/core/principal-source.ts";
import { role } from "../../src/core/role-builder.ts";

const Invoice = z.object({ id: z.string(), orgId: z.string() });

const permissions = definePermissions({
  invoice: resource(Invoice, {
    id: "id",
    actions: ["read", "send", "refund", "void"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role(
      "member",
      [
        allow(permissions.invoice.read),
        allow(permissions.invoice.send, { limit: { count: 1, per: 3600 } }),
        allow(permissions.invoice.void, { approval: "human" }),
      ],
      { on: "tenant" },
    ),
    role(
      "billing",
      [
        allow(permissions.invoice.read),
        allow(permissions.invoice.refund),
        allow(permissions.invoice.send, { limit: { count: 1, per: 3600 } }),
      ],
      { on: "tenant" },
    ),
  ],
  subject: (user: Principal | null) => user,
});

const inO1 = { id: "i_1", orgId: "o1" };
const alsoO1 = { id: "i_2", orgId: "o1" };
const inO2 = { id: "i_3", orgId: "o2" };

const member = (id: string, ...grants: [string, string][]): Principal => ({
  id,
  kind: "user",
  memberships: grants.map(([tenant, name]) => ({
    scope: "tenant",
    id: tenant,
    roles: [name],
  })),
});

const alice = member("alice", ["o1", "member"]);
const bob = member("bob", ["o1", "billing"], ["o2", "billing"]);
const carol = member("carol", ["o2", "billing"]);

const principals = memoryPrincipalSource({ principals: [alice, bob, carol] });

const subjectOf = (principal: Principal): Subject => ({
  principal: { ...principal, tenant: "o1" },
  context: {},
});

describe("decideEach", () => {
  it("returns one decision per row, in row order, as decide would", async () => {
    const permdock = await createPermDock(policy, subjectOf(alice));
    const decisions = permdock.decideEach(permissions.invoice.read, [
      inO1,
      inO2,
      alsoO1,
    ]);
    expect(decisions.map((decision) => decision.outcome)).toEqual([
      "granted",
      "denied",
      "granted",
    ]);
    expect(Object.isFrozen(decisions)).toBe(true);
    expect(permdock.decideEach(permissions.invoice.read, [])).toEqual([]);
  });

  it("consumes a limit once per granted row, in row order", async () => {
    const counter = memoryLimitStore();
    const permdock = await createPermDock(policy, subjectOf(alice), {
      limits: limits(counter),
    });
    const decisions = permdock.decideEach(permissions.invoice.send, [
      inO1,
      alsoO1,
    ]);
    expect(decisions[0]?.outcome).toBe("granted");
    expect(decisions[1]?.outcome).toBe("denied");
    expect(
      decisions[1]?.outcome === "denied"
        ? decisions[1].denials[0]?.reason
        : undefined,
    ).toBe("limit");
  });

  it("gives each approval-required row its own token", async () => {
    const permdock = await createPermDock(policy, subjectOf(alice));
    const [first, second] = permdock.decideEach(permissions.invoice.void, [
      inO1,
      alsoO1,
    ]);
    expect(first?.outcome).toBe("approval-required");
    expect(second?.outcome).toBe("approval-required");
    if (
      first?.outcome === "approval-required" &&
      second?.outcome === "approval-required"
    ) {
      expect(first.token).not.toBe(second.token);
    }
  });

  it("validates each row like decide", async () => {
    const permdock = await createPermDock(policy, subjectOf(alice));
    const [bad] = permdock.decideEach(permissions.invoice.read, [
      { id: 1, orgId: "o1" },
    ]);
    expect(bad?.outcome === "denied" ? bad.denials[0]?.reason : undefined).toBe(
      "validation",
    );
  });
});

describe("decideFor", () => {
  it("decides for another principal in the caller's tenant without widening the caller", async () => {
    const permdock = await createPermDock(policy, subjectOf(alice), {
      principals,
    });
    const forBob = await permdock.decideFor(
      "bob",
      permissions.invoice.refund,
      inO1,
    );
    expect(forBob.outcome).toBe("granted");
    expect(permdock.decide(permissions.invoice.refund, inO1).outcome).toBe(
      "denied",
    );
    expect(permdock.subject.principal?.id).toBe("alice");
  });

  it("asks the source with the caller's active tenant and follows tenant()", async () => {
    const asked: unknown[] = [];
    const source: PrincipalSource = {
      principal(id, options) {
        asked.push([id, options]);
        return principals.principal(id);
      },
    };
    const both = member("alice", ["o1", "member"], ["o2", "member"]);
    const permdock = await createPermDock(policy, subjectOf(both), {
      principals: source,
    });
    expect(
      (await permdock.decideFor("bob", permissions.invoice.refund, inO2))
        .outcome,
    ).toBe("denied");
    const inTwo = permdock.tenant("o2");
    expect(
      (await inTwo.decideFor("bob", permissions.invoice.refund, inO2)).outcome,
    ).toBe("granted");
    expect(asked).toEqual([
      ["bob", { tenant: "o1" }],
      ["bob", { tenant: "o2" }],
    ]);
  });

  it("denies a target outside the caller's tenant with tenant-mismatch", async () => {
    const permdock = await createPermDock(policy, subjectOf(alice), {
      principals,
    });
    const decision = await permdock.decideFor(
      "carol",
      permissions.invoice.read,
      inO2,
    );
    expect(decision.outcome).toBe("denied");
    expect(
      decision.outcome === "denied" ? decision.denials[0]?.reason : undefined,
    ).toBe("tenant-mismatch");
    expect(decision.outcome === "denied" ? decision.permission : "").toBe(
      "invoice.read",
    );
  });

  it("never consumes a limit", async () => {
    const counter = memoryLimitStore();
    const permdock = await createPermDock(policy, subjectOf(alice), {
      principals,
      limits: limits(counter),
    });
    for (let index = 0; index < 3; index += 1) {
      expect(
        (await permdock.decideFor("bob", permissions.invoice.send, inO1))
          .outcome,
      ).toBe("granted");
    }
    const asBob = await createPermDock(policy, subjectOf(bob), {
      limits: limits(counter),
    });
    expect(asBob.decide(permissions.invoice.send, inO1).outcome).toBe(
      "granted",
    );
    expect(
      (await permdock.decideFor("bob", permissions.invoice.send, inO1)).outcome,
    ).toBe("denied");
  });

  it("evaluates the target with no actor and no delegation", async () => {
    const permdock = await createPermDock(policy, subjectOf(alice), {
      principals,
      actor: { id: "agent_1", kind: "agent" },
      delegation: { scopes: [permissions.invoice.read.scope] },
    });
    expect(permdock.decide(permissions.invoice.send, inO1).outcome).toBe(
      "denied",
    );
    expect(
      (await permdock.decideFor("bob", permissions.invoice.refund, inO1))
        .outcome,
    ).toBe("granted");
  });

  it("reads memberships from the caller's membership source", async () => {
    const memberships = memoryMembershipSource({
      alice: [{ scope: "tenant", id: "o1", roles: ["member"] }],
      dave: [{ scope: "tenant", id: "o1", roles: ["billing"] }],
    });
    const permdock = await createPermDock(policy, subjectOf(alice), {
      memberships,
      principals: memoryPrincipalSource({
        principals: [{ id: "dave", kind: "user" }],
      }),
    });
    expect(
      (await permdock.decideFor("dave", permissions.invoice.refund, inO1))
        .outcome,
    ).toBe("granted");
  });

  it("never writes to the caller's sink", async () => {
    const written: unknown[] = [];
    const sink: DecisionSink = {
      write: (events) => {
        written.push(...events);
      },
    };
    const permdock = await createPermDock(policy, subjectOf(alice), {
      principals,
      sink,
    });
    await permdock.decideFor("bob", permissions.invoice.refund, inO1);
    expect(written).toEqual([]);
  });

  it("denies as anonymous without principals, for an unknown id, a throw or a rejection", async () => {
    const reasonOf = async (
      options: Parameters<typeof createPermDock>[2],
      id = "bob",
    ) => {
      const permdock = await createPermDock(policy, subjectOf(alice), options);
      const decision = await permdock.decideFor(
        id,
        permissions.invoice.read,
        inO1,
      );
      return decision.outcome === "denied"
        ? decision.denials[0]?.reason
        : decision.outcome;
    };
    expect(await reasonOf({})).toBe("anonymous");
    expect(await reasonOf({ principals }, "nobody")).toBe("anonymous");
    expect(await reasonOf({ principals }, "")).toBe("anonymous");
    expect(
      await reasonOf({
        principals: {
          principal: () => {
            throw new Error("down");
          },
        },
      }),
    ).toBe("anonymous");
    expect(
      await reasonOf({
        principals: { principal: () => Promise.reject(new Error("down")) },
      }),
    ).toBe("anonymous");
    const hostile: Principal = {
      id: "bob",
      get memberships(): never {
        throw new Error("getter");
      },
    };
    expect(await reasonOf({ principals: { principal: () => hostile } })).toBe(
      "anonymous",
    );
  });

  it("denies an anonymous caller", async () => {
    const permdock = await createPermDock(policy, null, { principals });
    const decision = await permdock.decideFor(
      "bob",
      permissions.invoice.read,
      inO1,
    );
    expect(
      decision.outcome === "denied" ? decision.denials[0]?.reason : undefined,
    ).toBe("anonymous");
  });

  it("derive replaces principals", async () => {
    const permdock = await createPermDock(policy, subjectOf(alice));
    const derived = await permdock.derive({ principals });
    expect(
      (await derived.decideFor("bob", permissions.invoice.refund, inO1))
        .outcome,
    ).toBe("granted");
    const kept = await derived.derive({});
    expect(
      (await kept.decideFor("bob", permissions.invoice.refund, inO1)).outcome,
    ).toBe("granted");
  });

  it("is unsupported on a snapshot instance; decideEach works there", async () => {
    const permdock = await createPermDock(policy, subjectOf(alice), {
      principals,
    });
    const offline = fromSnapshot(
      permdock.snapshot({ include: [permissions.invoice.read] }),
    );
    const decision = await offline.decideFor(
      "bob",
      permissions.invoice.read,
      inO1,
    );
    expect(
      decision.outcome === "denied" ? decision.denials[0]?.reason : undefined,
    ).toBe("unsupported");
    expect(
      offline
        .decideEach(permissions.invoice.read, [inO1, inO2])
        .map((each) => each.outcome),
    ).toEqual(["granted", "denied"]);
  });
});
