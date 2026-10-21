import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ScanResult } from "../../src/cli/types.ts";
import type { Permission, Policy } from "../../src/index.ts";
import type { SaasScenario } from "../../src/testing/saas/index.ts";

import {
  PUSHED_POLICY_SCHEMA,
  parsePushedPolicy,
  policyFromCatalog,
  pushedPolicy,
  resourceSchemaFromJson,
} from "../../src/catalog/index.ts";
import { buildCatalog } from "../../src/cli/catalog-doc.ts";
import { findPermission } from "../../src/core/permission-registry.ts";
import {
  allow,
  getPermDockSync,
  definePermissions,
  definePolicy,
  deny,
  mergeHostedGrants,
  principal,
  resource,
  role,
} from "../../src/index.ts";
import {
  saasFolderScenarios,
  saasPermissions,
  saasPolicy,
  saasScenarioOptions,
  saasScenarios,
  saasUser,
} from "../../src/testing/saas/index.ts";

const scan: ScanResult = {
  roots: [],
  definitionFiles: {},
  usages: {},
  unknown: [],
  dynamic: [],
  roleNames: [],
  planNames: [],
  allowKeys: [],
  snapshots: [],
  unparsed: [],
};

function rebuild(policy: Policy): Policy {
  const catalog = buildCatalog(
    policy.permissions,
    scan,
    "2026-10-01T00:00:00Z",
    policy,
  );
  return policyFromCatalog(
    JSON.parse(JSON.stringify(catalog)),
    JSON.parse(JSON.stringify(pushedPolicy(policy))),
    { subject: (user) => policy.subject(user) },
  );
}

function leaf(policy: Policy, permission: Permission): Permission {
  const found = findPermission(policy.permissions, permission.key);
  if (found === undefined) {
    throw new Error(`missing ${permission.key}`);
  }
  return found;
}

function outcome(policy: Policy, scenario: SaasScenario): string {
  const permdock = getPermDockSync(
    policy,
    saasUser(scenario),
    saasScenarioOptions(scenario),
  );
  // SAFETY: each scenario pairs its permission with a row of that resource.
  return permdock.decide(
    leaf(policy, scenario.permission) as never,
    scenario.row as never,
  ).outcome;
}

describe("PUSHED_POLICY_SCHEMA", () => {
  it("matches schemas/pushed-policy-v1.json", () => {
    const file: unknown = JSON.parse(
      readFileSync(
        new URL("../../schemas/pushed-policy-v1.json", import.meta.url),
        "utf8",
      ),
    );
    expect(file).toStrictEqual(
      JSON.parse(JSON.stringify(PUSHED_POLICY_SCHEMA)),
    );
  });

  it("accepts what pushedPolicy builds and refuses unsafe keys", () => {
    const pushed = pushedPolicy(saasPolicy);
    expect(pushed.v).toBe(1);
    expect(parsePushedPolicy(JSON.stringify(pushed))).toStrictEqual(
      JSON.parse(JSON.stringify(pushed)),
    );
    const unsafe = JSON.parse(JSON.stringify(pushed));
    unsafe.grants[0].meta = JSON.parse('{"__proto__":{"x":1}}');
    expect(() => parsePushedPolicy(unsafe)).toThrow(/Unsafe key/u);
    expect(() => parsePushedPolicy({ ...pushed, v: 2 })).toThrow(
      /invalid pushed policy at v/u,
    );
  });
});

describe("policyFromCatalog", () => {
  const rebuilt = rebuild(saasPolicy);

  it("keeps the fingerprint, hostable list and role bindings", () => {
    expect(rebuilt.fingerprint).toBe(saasPolicy.fingerprint);
    expect(rebuilt.hostable).toStrictEqual(saasPolicy.hostable);
    expect(rebuilt.roles.map((item) => item.name)).toStrictEqual(
      expect.arrayContaining(saasPolicy.roles.map((item) => item.name)),
    );
    expect([...rebuilt.index.declaredRoles].toSorted()).toStrictEqual(
      [...saasPolicy.index.declaredRoles].toSorted(),
    );
  });

  it("decides every SaaS scenario as the code does, or stricter", () => {
    const differ: string[] = [];
    for (const scenario of [...saasScenarios, ...saasFolderScenarios]) {
      const code = outcome(saasPolicy, scenario);
      const hosted = outcome(rebuilt, scenario);
      if (code !== hosted) {
        expect({ scenario: scenario.name, hosted }).toStrictEqual({
          scenario: scenario.name,
          hosted: "denied",
        });
        differ.push(scenario.name);
      }
    }
    expect(differ).toMatchSnapshot();
  });

  it("fails closed on code conditions", () => {
    const tree = definePermissions({
      doc: resource(z.object({ id: z.string(), ownerId: z.string() }), {
        actions: ["read", "share", "purge"],
      }),
    });
    const policy = definePolicy(tree, {
      roles: [
        role("member", [
          allow(tree.doc.read, { where: { ownerId: principal.id } }),
          allow(tree.doc.share, () => true),
          allow(tree.doc.purge),
          deny(tree.doc.purge, () => false),
        ]),
      ],
      subject: (user: { id: string }) => ({ id: user.id, roles: ["member"] }),
    });
    const hosted = rebuild(policy);
    const row = { id: "d1", ownerId: "u1" };
    const code = getPermDockSync(policy, { id: "u1" });
    const copy = getPermDockSync(hosted, { id: "u1" });
    expect(code.can(tree.doc.read, row)).toBe(true);
    expect(copy.can(leaf(hosted, tree.doc.read), row)).toBe(true);
    expect(
      copy.can(leaf(hosted, tree.doc.read), { ...row, ownerId: "u2" }),
    ).toBe(false);
    expect(code.can(tree.doc.share, row)).toBe(true);
    expect(copy.can(leaf(hosted, tree.doc.share), row)).toBe(false);
    expect(code.can(tree.doc.purge, row)).toBe(true);
    expect(copy.can(leaf(hosted, tree.doc.purge), row)).toBe(false);
  });

  it("validates rows against the catalog's JSON Schema", () => {
    const tree = definePermissions({
      doc: resource(z.object({ id: z.string(), title: z.string().max(3) }), {
        actions: ["update"],
      }),
    });
    const policy = definePolicy(tree, {
      roles: [role("member", [allow(tree.doc.update)])],
      subject: (user: { id: string }) => ({ id: user.id, roles: ["member"] }),
    });
    const hosted = rebuild(policy);
    const copy = getPermDockSync(hosted, { id: "u1" });
    const update = leaf(hosted, tree.doc.update);
    expect(copy.can(update, { id: "d1", title: "abc" })).toBe(true);
    expect(copy.can(update, { id: "d1", title: "abcd" })).toBe(false);
  });

  it("drops the same hosted grants mergeHostedGrants drops", () => {
    const document = {
      v: 1 as const,
      id: "pol_1",
      fingerprint: saasPolicy.fingerprint,
      catalog: "cat",
      issuedAt: "2026-10-01T00:00:00Z",
      grants: [
        {
          id: "g1",
          permission: saasPermissions.project.read.key,
          effect: "allow" as const,
          to: { kind: "role" as const, role: "ghost", scope: "global" },
        },
        {
          id: "g3",
          permission: saasPermissions.project.update.key,
          effect: "allow" as const,
          to: { kind: "role" as const, role: "member", scope: "tenant" },
        },
        {
          id: "g2",
          permission: "nope.read",
          effect: "allow" as const,
          to: { kind: "role" as const, role: "member", scope: "tenant" },
        },
      ],
    };
    const code = mergeHostedGrants(saasPolicy, document);
    const hosted = mergeHostedGrants(rebuilt, document);
    expect(code.dropped.length).toBeGreaterThan(0);
    expect(hosted.dropped).toStrictEqual(code.dropped);
  });

  it("refuses a pushed policy that names a permission the catalog lacks", () => {
    const catalog = buildCatalog(
      saasPolicy.permissions,
      scan,
      "2026-10-01T00:00:00Z",
      saasPolicy,
    );
    const pushed = pushedPolicy(saasPolicy);
    const bad = {
      ...pushed,
      grants: [{ ...pushed.grants[0], permission: "ghost.read" }],
    };
    expect(() => policyFromCatalog(catalog, bad)).toThrow(
      /unknown permission 'ghost.read'/u,
    );
  });
});

describe("resourceSchemaFromJson", () => {
  it("rejects every value under an unsupported keyword", () => {
    const schema = resourceSchemaFromJson({
      type: "object",
      properties: { id: { type: "string", if: { const: "x" } } },
    });
    expect(schema?.["~standard"].validate({ id: "a" })).toStrictEqual({
      issues: [
        {
          message:
            "PermDock: the catalog schema uses if, which policyFromCatalog does not interpret",
        },
      ],
    });
  });

  it("accepts format next to a pattern and refuses it alone", () => {
    const withPattern = resourceSchemaFromJson({
      type: "string",
      format: "uuid",
      pattern: "^[0-9a-f-]{36}$",
    });
    expect(withPattern?.["~standard"].validate("nope")).toHaveProperty(
      "issues",
    );
    const alone = resourceSchemaFromJson({ type: "string", format: "email" });
    expect(alone?.["~standard"].validate("a@b.c")).toHaveProperty("issues");
    expect(resourceSchemaFromJson(null)).toBeUndefined();
  });
});
