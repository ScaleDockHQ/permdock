import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { commandFor, compileGrants } from "../../src/cli/rls-compile.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  anyone,
  definePermissions,
  definePolicy,
  defineRoles,
  deny,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  quote: resource({
    actions: ["view", "send", "approve", "archive", "update"],
  }),
});
const roles = defineRoles({
  admin: { assignable: true },
  member: { assignable: true },
  auditor: {},
});
const policy = definePolicy(
  { permissions, roles },
  {
    subject: () => null,
    grants: [allow(permissions.quote.view, { to: anyone() })],
    roles: [
      role(roles.admin, [
        allow([
          permissions.quote.view,
          permissions.quote.send,
          permissions.quote.approve,
          permissions.quote.update,
        ]),
        allow(permissions.quote.archive, {
          validUntil: "2030-01-01T00:00:00Z",
        }),
      ]),
      role(roles.member, [
        allow(permissions.quote.send, {
          where: { field: "status", op: "eq", value: "draft" },
        }),
      ]),
      role(roles.auditor, [deny(permissions.quote.approve)]),
    ],
  },
);
const base: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes: scopeList(undefined),
  gucPrefix: "app",
};

describe("commandFor", () => {
  it("merges rls.actions over the default verbs", () => {
    expect(commandFor("read")).toBe("select");
    expect(commandFor("view")).toBeUndefined();
    expect(commandFor("view", { view: "select" })).toBe("select");
    expect(commandFor("read", { read: "none" })).toBeUndefined();
    expect(commandFor("toString", {})).toBeUndefined();
  });
});

describe("rls.actions", () => {
  it("compiles a mapped verb to its command and seeds the rest", () => {
    const warnings: string[] = [];
    const compiled = compileGrants(
      policy,
      { ...base, actions: { view: "select", send: "none" } },
      undefined,
      warnings,
      false,
    );
    expect(
      compiled.branches
        .filter((branch) => branch.permissionKey === "quote.view")
        .map((branch) => branch.command),
    ).toEqual(["select", "select"]);
    expect(
      compiled.branches.some((branch) =>
        ["quote.send", "quote.approve"].includes(branch.permissionKey),
      ),
    ).toBe(false);
    const rows = compiled.rolePermissions.map(
      (row) => `${row.role} ${row.grantKey} ${row.effect}`,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        "admin quote.view allow",
        "admin quote.send#1 allow",
        "member quote.send#2 allow",
        "admin quote.approve#1 allow",
        "auditor quote.approve#2 deny",
      ]),
    );
    expect(rows.some((row) => row.includes("quote.archive"))).toBe(false);
    expect(warnings).toEqual(
      expect.arrayContaining([
        "no policy for admin/quote.send: action 'send' has no SQL command (rls.actions); seeded for permdock_has and permitted_<scope>_ids",
        "skipped admin/quote.archive: a role_permissions row cannot carry validFrom / validUntil, so a time-bounded grant on an action with no SQL command is not seeded",
      ]),
    );
  });

  it("seeds an unconditional allow under its own key and skips non-role grants", () => {
    const solo = definePolicy(
      { permissions, roles },
      {
        subject: () => null,
        grants: [allow(permissions.quote.send, { to: anyone() })],
        roles: [role(roles.admin, [allow(permissions.quote.send)])],
      },
    );
    const warnings: string[] = [];
    const compiled = compileGrants(solo, base, undefined, warnings, false);
    expect(compiled.rolePermissions).toEqual([
      {
        role: "admin",
        permission: "quote.send",
        grantKey: "quote.send",
        scope: "global",
        effect: "allow",
      },
    ]);
    expect(warnings).toContain(
      "skipped anyone/quote.send: action 'send' has no SQL command (rls.actions) and only role grants are seeded",
    );
  });
});
