import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  checkHostedGrant,
  hostedGrantOptions,
} from "../../src/catalog/index.ts";
import { allow } from "../../src/core/grant-builders.ts";
import {
  mergeHostedGrants,
  parsePolicyDocument,
} from "../../src/core/hosted.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { definePlans } from "../../src/core/vocabulary.ts";

const permissions = definePermissions({
  invoice: resource(
    z.object({ id: z.string(), ownerId: z.string(), total: z.number() }),
    { id: "id", actions: ["read", "delete"], relations: { owner: "ownerId" } },
  ),
  report: resource(z.object({ id: z.string() }), {
    id: "id",
    actions: ["read"],
  }),
});

const policy = definePolicy(
  { permissions, plans: definePlans({ pro: {} }) },
  {
    roles: [
      role("member", [
        allow(permissions.invoice.read),
        allow(permissions.invoice.delete, { approval: "human" }),
      ]),
      role("auditor", []),
    ],
    subject: (user: { id: string }) => user,
    hostable: [permissions.invoice, permissions.report.read],
  },
);

describe("checkHostedGrant", () => {
  it("gives the drop reason mergeHostedGrants reports", () => {
    const cases: readonly unknown[] = [
      {
        id: "g1",
        permission: "invoice.read",
        to: { kind: "plan", plan: "pro" },
      },
      { id: "g2", permission: "nope.read", to: { kind: "plan", plan: "pro" } },
      {
        id: "g3",
        permission: "invoice.delete",
        to: { kind: "role", role: "auditor" },
      },
      { id: "g4", permission: "invoice.read", to: { kind: "role", role: "x" } },
      {
        id: "g5",
        permission: "invoice.read",
        to: { kind: "plan", plan: "pro" },
        where: { op: "opaque", sql: "true", fingerprint: "f" },
      },
      { id: "g6", permission: "invoice.read" },
    ];
    const document = parsePolicyDocument({
      v: 1,
      id: "doc",
      fingerprint: "fp",
      catalog: "cat",
      issuedAt: "1970-01-01T00:00:01Z",
      grants: cases,
    });
    const merged = mergeHostedGrants(policy, document);
    const dropped = new Map(
      merged.dropped.map((drop) => [drop.grant, drop.reason]),
    );
    expect(cases.map((grant) => checkHostedGrant(policy, grant))).toEqual([
      { ok: true },
      { ok: false, reason: "unknown-permission" },
      { ok: false, reason: "weaker-approval" },
      { ok: false, reason: "unknown-grantee" },
      { ok: false, reason: "non-portable" },
      { ok: false, reason: "invalid" },
    ]);
    for (const [index, grant] of cases.entries()) {
      const check = checkHostedGrant(policy, grant);
      expect(check.ok ? undefined : check.reason).toBe(
        dropped.get(`g${String(index + 1)}`),
      );
    }
  });
});

describe("hostedGrantOptions", () => {
  const options = hostedGrantOptions(policy);

  it("lists each hostable permission with its grantees, approvals and fields", () => {
    expect(options.map((option) => option.permission)).toEqual([
      "invoice.delete",
      "invoice.read",
      "report.read",
    ]);
    const remove = options.find(
      (option) => option.permission === "invoice.delete",
    );
    expect(remove).toMatchObject({
      resource: "invoice",
      grantees: {
        roles: [{ scope: "global", roles: ["member", "auditor"] }],
        plans: ["pro"],
        relations: [{ relation: "owner" }],
      },
      approval: { required: true, meets: ["human"], modes: ["human", "any"] },
      conditions: { portable: true },
    });
    expect(remove?.approval.fields).not.toContain("staleOn");
    expect(remove?.conditions.fields).toEqual(["id", "ownerId", "total"]);
  });

  it("builds only grants checkHostedGrant accepts", () => {
    for (const option of options) {
      const approval = option.approval.required ? "human" : undefined;
      const grantees = [
        ...option.grantees.roles.flatMap((group) =>
          group.roles.map((name) => ({ kind: "role", role: name })),
        ),
        ...option.grantees.plans.map((plan) => ({ kind: "plan", plan })),
        ...option.grantees.relations.map((relation) => ({
          kind: "relation",
          resource: option.resource,
          ...relation,
        })),
      ];
      for (const to of grantees) {
        expect(
          checkHostedGrant(policy, {
            id: "g",
            permission: option.permission,
            to,
            ...(approval === undefined ? {} : { approval }),
          }),
        ).toEqual({ ok: true });
      }
    }
  });
});
