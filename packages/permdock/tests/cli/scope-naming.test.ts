import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { run } from "../../src/cli/core/run.ts";
import { runRlsGenerate } from "../../src/cli/rls/generate.ts";

const TMP = path.join(import.meta.dirname, "../../tmp");
mkdirSync(TMP, { recursive: true });
const cwd = mkdtempSync(path.join(TMP, "scope-naming-"));

function policyModule(outer: string, inner: string): string {
  return `import { allow, definePermissions, definePolicy, defineRoles, relation, resource, role } from 'permdock';
import { z } from 'zod';

const id = z.uuid();
const permissions = definePermissions({
  widget: resource(z.object({ id, outerId: id, innerId: id, folderId: id, secret: z.string() }), {
    actions: ['read', 'update'],
    parent: { field: 'folderId', resource: 'gadget' },
    relations: {
      outer: { field: 'outerId', memberOf: '${outer}' },
      inner: { field: 'innerId', memberOf: '${inner}' },
    },
    fields: { secret: { read: 'widget.update' } },
  }),
  gadget: resource(z.object({ id, outerId: id }), {
    actions: ['read'],
    relations: { viewer: { edge: 'gadget_viewers' } },
  }),
});
const roles = defineRoles({
  admin: { on: '${outer}', assignable: true },
  member: { on: '${outer}', assignable: true },
  lead: { on: '${inner}', assignable: true },
});

export const policy = definePolicy({ permissions, roles }, {
  scopes: { ${outer}: { key: 'outerId' }, ${inner}: { key: 'innerId', within: '${outer}' } },
  roles: [
    role(roles.admin, [allow(permissions.widget.update)]),
    role(roles.member, [allow(permissions.widget.read)]),
    role(roles.lead, [allow(permissions.widget.update)]),
  ],
  grants: [
    allow(permissions.widget.read, { to: relation(permissions.gadget, 'viewer', { through: 'parent' }) }),
  ],
  subject: () => null,
});
`;
}

function config(outer: string, inner: string): PermDockConfig {
  return {
    rls: {
      tenantClaim: `${outer}_id`,
      scopeTypes: { [outer]: "uuid", [inner]: "uuid" },
      memberships: {
        scopes: {
          [outer]: {
            table: `${outer}_members`,
            user: "user_id",
            role: "role",
            columns: { [outer]: `${outer}_id` },
          },
          [inner]: {
            table: `${inner}_members`,
            user: "user_id",
            role: "role",
            columns: { [outer]: `${outer}_id`, [inner]: `${inner}_id` },
          },
        },
      },
      customRoleWrites: {
        roles: {
          table: `${outer}_roles`,
          key: "name",
          tenant: `${outer}_id`,
          primaryKey: "id",
        },
        audit: { function: "audit.audit_event_trusted" },
      },
      capabilities: true,
      approvals: true,
      fields: "views",
      tables: { widget: "public.widgets", gadget: "public.gadgets" },
      rowHelpers: ["widget"],
    },
  };
}

type Run = Partial<Parameters<typeof runRlsGenerate>[0]>;

const RUNS: Record<string, Run> = {
  "supabase sql with custom roles": {
    rbac: true,
    customRoles: true,
    authorize: "database",
  },
  "guc sql": { dialect: "guc" },
  "supabase drizzle": { target: "drizzle" },
};

const io = { stdout: () => undefined, stderr: () => undefined };

async function render(outer: string, inner: string, options: Run) {
  writeFileSync(
    path.join(cwd, `${outer}-${inner}.ts`),
    policyModule(outer, inner),
  );
  const outcome = await runRlsGenerate({
    cwd,
    config: config(outer, inner),
    from: `./${outer}-${inner}.ts`,
    target: "sql",
    dialect: "supabase",
    rbac: false,
    check: false,
    skipClosures: false,
    inlineFunctions: false,
    io,
    write: false,
    ...options,
  });
  expect(outcome.code).toBe(0);
  return outcome.text ?? "";
}

/**
 * Names that keep `tenant` whatever the scopes are called: the columns and
 * parameters of the objects PermDock owns (`custom_role_*`, `approval_requests`
 * and the `v: 1` request's `subject.principal.tenant`), the hook's claim
 * entries, the audit function's `tenant` argument, the `authorize` hook's
 * `requested_tenant`, and the `v_*tenant` locals, which a scope name such as
 * `scope` or `key` would collide with. Renaming the columns per policy would
 * drop and re-add them under a declarative schema diff.
 */
const CONTRACT = [
  /(?<!')\b(?:c\.|excluded\.)?tenant_id\b(?!')/gu,
  /\bp_tenant\b/gu,
  /\btenant = excluded\.tenant\b/gu,
  /\b[ax]\.tenant\b/gu,
  /\btenant(?= text,|,| =>)/gu,
  /->> 'tenant'|\{subject,principal,tenant\}/gu,
  /no tenant or instance|a scope of a tenant|another tenant than/gu,
  /\brequested_tenant\b/gu,
  /\bv_(?:member_|old_|new_)?tenant\b/gu,
];

/** Lines that still name a scope the sentinel policy does not declare. */
function leftovers(sql: string, allowed: readonly RegExp[] = []): string[] {
  const left: string[] = [];
  for (const line of sql.split("\n")) {
    if (/^\s*(?:--|\/\/|\*)/u.test(line)) {
      continue;
    }
    let rest = line;
    for (const pattern of [...CONTRACT, ...allowed]) {
      rest = rest.replaceAll(pattern, "");
    }
    if (/tenant|team|organization/iu.test(rest)) {
      left.push(rest);
    }
  }
  return left;
}

describe("sentinel scope names", () => {
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each(Object.entries(RUNS))(
    "leaves no tenant, team or organization in %s",
    async (_name, options) => {
      const sql = await render("alpha", "beta", options);
      expect(sql).toMatch(/permitted_alpha_ids|alpha_members/u);
      expect(leftovers(sql)).toStrictEqual([]);
    },
  );

  it("leaves none in the Supabase hook or the PowerSync streams", async () => {
    const dir = mkdtempSync(path.join(cwd, "project-"));
    writeFileSync(path.join(dir, "policy.ts"), policyModule("alpha", "beta"));
    writeFileSync(
      path.join(dir, "permdock.config.ts"),
      `import { tableMembershipSource } from "permdock/supabase";

export default {
  policy: "./policy.ts",
  rls: ${JSON.stringify({ ...config("alpha", "beta").rls, customRoleWrites: undefined })},
  supabase: { hook: { memberships: [tableMembershipSource({ table: "alpha_memberships" })] } },
};
`,
    );
    const hook = await run([
      "supabase",
      "hook",
      "generate",
      "--out",
      "hook.sql",
      "--cwd",
      dir,
    ]);
    expect(hook.stderr).toBe("");
    const streams = await run([
      "powersync",
      "generate",
      "--out",
      "sync-config.yaml",
      "--cwd",
      dir,
    ]);
    expect(streams.stderr).toBe("");
    for (const file of ["hook.sql", "sync-config.yaml"]) {
      const text = readFileSync(path.join(dir, file), "utf8");
      expect(text).toMatch(/alpha/u);
      expect(leftovers(text)).toStrictEqual([]);
    }
  });

  it("keeps member_teams_ids_of for a scope named teams, the one allowed name", async () => {
    const sql = await render("alpha", "teams", {});
    expect(sql).toContain("member_teams_ids_of");
    expect(leftovers(sql, [/\bteams\b|_teams_|teams_/gu])).toStrictEqual([]);
  });
});
