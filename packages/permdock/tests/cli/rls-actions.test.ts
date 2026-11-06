import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import {
  commandFor,
  compileGrants,
  inferredCommand,
} from "../../src/cli/sql/compile.ts";
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
import { policy as scoped } from "../fixtures/named-scopes.ts";

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

describe(commandFor, () => {
  it("merges rls.actions over the default verbs", () => {
    expect(commandFor("read")).toBe("select");
    expect(commandFor("view")).toBeUndefined();
    expect(commandFor("view", { view: "select" })).toBe("select");
    expect(commandFor("read", { read: "none" })).toBeUndefined();
    expect(commandFor("toString", {})).toBeUndefined();
  });
});

describe("inferred actions", () => {
  it("maps a compound whose first word is a default verb", () => {
    expect(commandFor("updateStatus")).toBe("update");
    expect(commandFor("listArchived")).toBe("select");
    expect(commandFor("create_draft")).toBe("insert");
    expect(commandFor("delete-all")).toBe("delete");
    expect(commandFor("getOrCreate2")).toBe("select");
  });

  it("keeps any other verb, a word that only starts with a verb and a configured action out", () => {
    expect(commandFor("approveInvoice")).toBe("update");
    expect(commandFor("markPaid")).toBe("update");
    expect(commandFor("pause_run")).toBe("update");
    expect(commandFor("resumeAll")).toBe("update");
    expect(commandFor("remove")).toBe("delete");
    expect(commandFor("duplicate")).toBe("insert");
    expect(commandFor("writeOff")).toBe("update");
    expect(commandFor("remove", { remove: "none" })).toBeUndefined();
    expect(commandFor("export")).toBeUndefined();
    expect(commandFor("updater")).toBeUndefined();
    expect(commandFor("readonly")).toBeUndefined();
    expect(
      commandFor("updateStatus", { updateStatus: "none" }),
    ).toBeUndefined();
    expect(commandFor("updateStatus", { updateStatus: "delete" })).toBe(
      "delete",
    );
  });

  it("names a command as inferred only when nothing else gave it", () => {
    expect(inferredCommand("update")).toBeUndefined();
    expect(inferredCommand("updateStatus")).toBe("update");
    expect(
      inferredCommand("updateStatus", { updateStatus: "update" }),
    ).toBeUndefined();
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
    ).toStrictEqual(["select", "select"]);
    expect(
      compiled.branches.some((branch) => branch.permissionKey === "quote.send"),
    ).toBe(false);
    expect(
      compiled.branches
        .filter((branch) => branch.permissionKey === "quote.approve")
        .map((branch) => branch.command),
    ).toStrictEqual(["update", "update"]);
    const rows = compiled.rolePermissions.map(
      (row) => `${row.role} ${row.grantKey} ${row.effect}`,
    );
    expect(rows).toStrictEqual(
      expect.arrayContaining([
        "admin quote.view allow",
        "admin quote.send#1 allow",
        "member quote.send#2 allow",
        "admin quote.approve#1 allow",
        "auditor quote.approve#2 deny",
      ]),
    );
    expect(rows.some((row) => row.includes("quote.archive"))).toBe(false);
    expect(warnings).toStrictEqual([
      "skipped admin/quote.archive: a role_permissions row cannot carry validFrom / validUntil, so a time-bounded grant on an action with no SQL command is not seeded",
    ]);
  });

  it("compiles an unmapped verb as 'none', and a fully mapped config to the same output", () => {
    const run = (actions: NonNullable<RlsSqlContext["actions"]>) => {
      const warnings: string[] = [];
      const compiled = compileGrants(
        policy,
        { ...base, actions },
        undefined,
        warnings,
        false,
      );
      return { compiled, warnings };
    };
    const mapped = run({
      view: "select",
      send: "none",
      approve: "none",
      archive: "none",
    });
    const partial = run({ view: "select", approve: "none", send: "none" });
    expect(partial.compiled).toStrictEqual(mapped.compiled);
    expect(partial.warnings).toStrictEqual(mapped.warnings);
  });

  it("seeds an unconditional allow under its own key and skips non-role grants", () => {
    const solo = definePolicy(
      { permissions, roles },
      {
        subject: () => null,
        grants: [allow(permissions.quote.archive, { to: anyone() })],
        roles: [role(roles.admin, [allow(permissions.quote.archive)])],
      },
    );
    const warnings: string[] = [];
    const compiled = compileGrants(solo, base, undefined, warnings, false);
    expect(compiled.rolePermissions).toStrictEqual([
      {
        role: "admin",
        permission: "quote.archive",
        grantKey: "quote.archive",
        scope: "global",
        effect: "allow",
      },
    ]);
    expect(warnings).toContain(
      "skipped anyone/quote.archive: action 'archive' has no SQL command (rls.actions) and only role grants are seeded",
    );
  });
});

describe("tableless resources", () => {
  it("seeds role grants and skips a direct grant with a warning", () => {
    const warnings: string[] = [];
    const compiled = compileGrants(
      policy,
      { ...base, tableless: new Set(["quote"]) },
      undefined,
      warnings,
      false,
    );
    expect(compiled.branches).toStrictEqual([]);
    expect(warnings).toStrictEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "rls.tables.quote is false or a tableOf, so the resource writes no policies of its own",
        ),
      ]),
    );
    expect(
      compiled.rolePermissions.some((row) => row.grantKey === "quote.view"),
    ).toBe(true);
  });
});

describe("rls.tables via scope", () => {
  const via = {
    helper: "permitted_customer_ids",
    key: "customer_id",
    scope: "customer",
    table: "public.customers",
    column: "id",
    id: "id",
    type: "uuid",
  } as const;

  it("rejects a role granted at another scope than the via reaches", () => {
    expect(() =>
      compileGrants(
        scoped,
        { ...base, scopes: scopeList(scoped.scopes), vias: { quote: via } },
        undefined,
        [],
        false,
      ),
    ).toThrow(/via reaches customer; map the scope with via\.scope/u);
  });
});
