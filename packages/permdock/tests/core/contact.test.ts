import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AccessReview } from "../../src/approvals/access-reviews/types.ts";
import type { Principal, Subject } from "../../src/core/subject.ts";

import {
  accessReviewerEligible,
  assertApprover,
  memoryApprovalStore,
  requestApproval,
} from "../../src/approvals/index.ts";
import { user as userApprover } from "../../src/core/approvers.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { authenticated } from "../../src/core/grantee.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { memoryPrincipalSource } from "../../src/core/principal-source.ts";
import { role } from "../../src/core/role-builder.ts";
import { isPrincipal } from "../../src/core/subject.ts";
import { decideCredential } from "../../src/index.ts";
import { describePolicy } from "../../src/testing/describe-policy.ts";
import { reasonOf } from "../fixtures/decisions.ts";

const Invoice = z.object({ id: z.string(), orgId: z.string() });

const permissions = definePermissions({
  invoice: resource(Invoice, {
    id: "id",
    actions: ["read", "comment", "pay", "archive"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  grants: [allow(permissions.invoice.archive, { to: authenticated() })],
  roles: [
    role(
      "member",
      [allow([permissions.invoice.read, permissions.invoice.pay])],
      { on: "tenant" },
    ),
    role("admin", [allow(permissions.invoice.pay)]),
    role(
      "customer",
      [allow([permissions.invoice.read, permissions.invoice.comment])],
      { on: permissions.invoice },
    ),
    role("payer", [allow(permissions.invoice.pay)], {
      on: permissions.invoice,
      for: ["contact"],
    }),
    role("staff-viewer", [allow(permissions.invoice.read)], {
      on: permissions.invoice,
      for: ["staff"],
    }),
  ],
  subject: (user: Principal | null) => user,
});

const i1 = { id: "i1", orgId: "o1" };
const i2 = { id: "i2", orgId: "o1" };

const contact: Principal = {
  id: "c_1",
  kind: "contact",
  tenant: "o1",
  roles: ["admin"],
  plans: ["pro"],
  memberships: [
    { scope: "tenant", id: "o1", roles: ["member"] },
    { on: { resource: "invoice", id: "i1" }, roles: ["customer", "payer"] },
    {
      on: { resource: "invoice", id: "i2" },
      roles: ["customer", "staff-viewer"],
      via: "staff",
      entitlements: ["seat"],
    },
  ],
};

describe("contact principals", () => {
  it("is a principal kind", () => {
    expect(isPrincipal({ id: "c_1", kind: "contact" })).toBe(true);
  });

  it("keeps only on memberships, as via contact, and drops roles, plans and the tenant", async () => {
    const permdock = getPermDockSync(policy, contact, {
      entitlements: { entitlementsFor: () => ["enterprise"] },
    });
    const principal = permdock.subject.principal;
    expect(principal?.roles).toStrictEqual([]);
    expect(principal?.plans).toBeUndefined();
    expect(principal?.tenant).toBeUndefined();
    expect(principal?.memberships).toStrictEqual([
      {
        on: { resource: "invoice", id: "i1" },
        roles: ["customer", "payer"],
        via: "contact",
      },
      {
        on: { resource: "invoice", id: "i2" },
        roles: ["customer"],
        via: "contact",
      },
    ]);
    expect(permdock.tenants()).toStrictEqual([]);
  });

  it("reads through a resource membership", async () => {
    const permdock = getPermDockSync(policy, contact);
    expect(permdock.decide(permissions.invoice.read, i1).outcome).toBe(
      "granted",
    );
    expect(permdock.decide(permissions.invoice.read, i2).outcome).toBe(
      "granted",
    );
    expect(
      permdock.decide(permissions.invoice.read, { id: "i3", orgId: "o1" })
        .outcome,
    ).toBe("denied");
  });

  it("is read-only unless a role whose for lists contact grants the write", async () => {
    const permdock = getPermDockSync(policy, contact);
    expect(reasonOf(permdock.decide(permissions.invoice.comment, i1))).toBe(
      "not-delegated",
    );
    expect(permdock.decide(permissions.invoice.pay, i1).outcome).toBe(
      "granted",
    );
    expect(reasonOf(permdock.decide(permissions.invoice.pay, i2))).not.toBe(
      undefined,
    );
    expect(reasonOf(permdock.decide(permissions.invoice.archive, i1))).toBe(
      "not-delegated",
    );
    expect(permdock.can(permissions.invoice.comment, i1)).toBe(false);
  });

  it("narrows where and snapshots the same way", async () => {
    const permdock = getPermDockSync(policy, contact);
    expect(permdock.where(permissions.invoice.comment).condition).toStrictEqual(
      { op: "or", conditions: [] },
    );
    expect(
      permdock.where(permissions.invoice.read).condition,
    ).not.toStrictEqual({ op: "or", conditions: [] });
    const offline = fromSnapshot(permdock.snapshot());
    expect(offline.can(permissions.invoice.read, i1)).toBe(true);
    expect(offline.can(permissions.invoice.comment, i1)).toBe(false);
    expect(offline.can(permissions.invoice.pay, i1)).toBe(true);
  });

  it("keeps a user with the same memberships unchanged", async () => {
    const user = getPermDockSync(policy, { ...contact, kind: "user" });
    expect(user.subject.principal?.roles).toStrictEqual(["admin"]);
    expect(user.decide(permissions.invoice.comment, i1).outcome).toBe(
      "granted",
    );
    expect(user.decide(permissions.invoice.archive, i1).outcome).toBe(
      "granted",
    );
  });

  it("decideFor evaluates a contact on its resource memberships in the caller's tenant", async () => {
    const member = getPermDockSync(
      policy,
      {
        id: "u_1",
        kind: "user",
        tenant: "o1",
        memberships: [{ scope: "tenant", id: "o1", roles: ["member"] }],
      },
      { principals: memoryPrincipalSource({ principals: [contact] }) },
    );
    const { outcome } = await member.decideFor(
      "c_1",
      permissions.invoice.read,
      i1,
    );
    expect(outcome).toBe("granted");
    expect(
      reasonOf(await member.decideFor("c_1", permissions.invoice.comment, i1)),
    ).toBe("not-delegated");
    expect(
      (
        await member.decideFor("c_1", permissions.invoice.read, {
          id: "i3",
          orgId: "o1",
        })
      ).outcome,
    ).toBe("denied");
  });

  it("never approves, reviews or creates keys", async () => {
    const approvals = definePolicy(permissions, {
      scopes: { tenant: { key: "orgId" } },
      roles: [
        role(
          "member",
          [
            allow(permissions.invoice.pay, {
              approval: { by: userApprover("c_1") },
            }),
          ],
          { on: "tenant" },
        ),
      ],
      subject: (person: Principal | null) => person,
    });
    const requester = getPermDockSync(approvals, {
      id: "u_1",
      tenant: "o1",
      memberships: [{ scope: "tenant", id: "o1", roles: ["member"] }],
    });
    const decision = requester.decide(permissions.invoice.pay, i1);
    if (decision.outcome !== "approval-required") {
      throw new Error(`expected approval-required, got ${decision.outcome}`);
    }
    const request = await requestApproval(memoryApprovalStore(), decision, {
      permission: permissions.invoice.pay,
      resource: { type: "invoice", id: "i1" },
      subject: requester.subject,
    });
    const by: Subject = {
      principal: { ...contact, tenant: "o1" },
      context: {},
    };
    expect(() => assertApprover(request, by, false)).toThrow(/contact/u);
    const review: AccessReview = {
      v: 1,
      id: "r1",
      tenant: "o1",
      permissions: ["invoice.pay"],
      reviewers: userApprover("c_1"),
      createdBy: "u_1",
      createdAt: "2026-10-01T00:00:00.000Z",
      dueAt: "2026-12-31T00:00:00.000Z",
      status: "open",
      complete: true,
    };
    expect(accessReviewerEligible(review, by)).toBe(false);
    expect(
      accessReviewerEligible(review, {
        ...by,
        principal: { ...contact, kind: "user", tenant: "o1" },
      }),
    ).toBe(true);
    const permdock = getPermDockSync(policy, contact);
    expect(
      await decideCredential(permdock, {
        kind: "user",
        id: "k",
        permissions: [permissions.invoice.read],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "exceeds-creator", detail: { creator: "contact" } }],
    });
  });
});

describePolicy(policy, {
  exhaustive: false,
  snapshot: true,
  subjects: { contact, user: { ...contact, kind: "user" } },
  fixtures: { i1, i2, i3: { id: "i3", orgId: "o1" } },
  matrix: {
    [permissions.invoice.read.key]: {
      i1: { contact: "granted", user: "granted" },
      i2: { contact: "granted", user: "granted" },
      i3: { contact: "denied", user: "granted" },
    },
    [permissions.invoice.comment.key]: {
      i1: { contact: "denied", user: "granted" },
    },
    [permissions.invoice.pay.key]: {
      i1: { contact: "granted", user: "granted" },
      i2: { contact: "denied", user: "granted" },
    },
    [permissions.invoice.archive.key]: {
      i1: { contact: "denied", user: "granted" },
    },
  },
});
