import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { runRlsGenerate } from "../../src/cli/rls-generate.ts";
import { fromTable } from "../../src/supabase/index.ts";

const TMP = path.join(import.meta.dirname, "../../tmp");
mkdirSync(TMP, { recursive: true });
const cwd = mkdtempSync(path.join(TMP, "rls-generate-cases-"));
const MINI = path.join(import.meta.dirname, "fixtures/mini-app/src/policy.ts");
writeFileSync(
  path.join(cwd, "roles.ts"),
  `import { allow, definePermissions, definePolicy, defineRoles, resource, role } from 'permdock';
import { z } from 'zod';

const Doc = z.object({ id: z.string(), orgId: z.string(), teamId: z.string() });
const permissions = definePermissions({
  doc: resource(Doc, {
    actions: ['read', 'update'],
    relations: {
      org: { field: 'orgId', memberOf: 'tenant' },
      team: { field: 'teamId', memberOf: 'team' },
    },
  }),
});
const roles = defineRoles({
  editor: { on: 'tenant', assignable: true },
  viewer: { on: 'tenant', assignable: false },
  lead: { on: 'team', assignable: true },
});

export const policy = definePolicy({ permissions, roles }, {
  scopes: { tenant: { key: 'orgId' }, team: { key: 'teamId', within: 'tenant' } },
  roles: [role(roles.lead, [allow(permissions.doc.update, { to: roles.lead })])],
  grants: [
    allow(permissions.doc.read, { to: roles.editor }),
    allow(permissions.doc.read, { to: roles.viewer }),
  ],
  subject: () => null,
});
`,
);
writeFileSync(
  path.join(cwd, "renamed.ts"),
  `import { allow, definePermissions, definePolicy, defineRoles, resource } from 'permdock';
import { z } from 'zod';

const Doc = z.object({ id: z.string(), orgId: z.string() });
const permissions = definePermissions(
  { doc: resource(Doc, { actions: ['view'], relations: { org: { field: 'orgId', memberOf: 'tenant' } } }) },
  { renamed: { 'document.view': 'doc.view' } },
);
const roles = defineRoles({ editor: { on: 'tenant', assignable: true } });

export const policy = definePolicy({ permissions, roles }, {
  scopes: { tenant: { key: 'orgId' } },
  grants: [allow(permissions.doc.view, { to: roles.editor })],
  subject: () => null,
});
`,
);
writeFileSync(
  path.join(cwd, "graph.ts"),
  `import { allow, definePermissions, definePolicy, relation, resource } from 'permdock';
import { z } from 'zod';

const Node = z.object({ id: z.string(), parentId: z.string().nullable(), ownerId: z.string() });
const permissions = definePermissions({
  node: resource(Node, {
    actions: ['read'],
    parent: { field: 'parentId', resource: 'node' },
    relations: { owner: { field: 'ownerId' }, share: { edge: 'node_shares' } },
  }),
});

export const policy = definePolicy(permissions, {
  grants: [
    allow(permissions.node.read, { to: relation(permissions.node, 'owner', { through: 'parent', depth: 2 }) }),
    allow(permissions.node.read, { to: relation(permissions.node, 'share', { through: 'parent', depth: 2 }) }),
  ],
  subject: () => null,
});
`,
);
writeFileSync(
  path.join(cwd, "closure.ts"),
  `import { allow, breakGlass, definePermissions, definePolicy, deny, resource, role } from 'permdock';
import { z } from 'zod';

const Doc = z.object({ id: z.string(), locked: z.boolean() });
const permissions = definePermissions({ doc: resource(Doc, { actions: ['read', 'update'] }) });

export const policy = definePolicy(permissions, {
  roles: [role('member', [allow(permissions.doc.update), deny(permissions.doc.update, (doc) => doc.locked)])],
  grants: [
    allow(permissions.doc.read, { to: { kind: 'authenticated' }, name: 'readers' }),
    deny(permissions.doc.read, { to: { kind: 'anyone' }, where: { locked: { eq: true } }, name: 'locked' }),
    breakGlass(permissions.doc.read, { overrides: ['locked'], requires: { reason: true } }),
  ],
  subject: () => null,
});
`,
);

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const io = { stdout: () => undefined, stderr: () => undefined };

type Input = Parameters<typeof runRlsGenerate>[0];

function generate(over: Partial<Input> & { readonly config?: PermDockConfig }) {
  return runRlsGenerate({
    cwd,
    config: {},
    target: "sql",
    dialect: "supabase",
    rbac: false,
    check: false,
    skipClosures: false,
    inlineFunctions: false,
    io,
    write: false,
    ...over,
  });
}

describe("rls generate policy loading", () => {
  it("reads the config policy for --from drizzle and needs one", async () => {
    await expect(generate({ from: "drizzle" })).rejects.toThrow(
      "rls generate needs policy in permdock.config.ts or --from",
    );
    const outcome = await generate({
      from: "drizzle",
      config: { policy: MINI },
    });
    expect(outcome.code).toBe(0);
  });
});

describe("rls generate context from the config", () => {
  it("scaffolds custom roles under rbac with the assignable declared roles", async () => {
    const outcome = await generate({
      from: "./roles.ts",
      rbac: true,
      customRoles: true,
      authorize: "database",
    });
    expect(outcome.code).toBe(0);
    expect(outcome.text).toContain("custom_role_permissions");
    expect(outcome.text).toContain(
      "where rp.role = any(array['editor', 'lead']::text[])",
    );
    expect(outcome.text).not.toContain("service_role");
  });

  it("maps stored former keys in custom roles and reads rls.actions", async () => {
    const outcome = await generate({
      from: "./renamed.ts",
      rbac: true,
      customRoles: true,
      authorize: "database",
      config: { rls: { actions: { view: "select" } } },
    });
    expect(outcome.code).toBe(0);
    expect(outcome.text).toContain(
      "with renamed (former, key) as (values ('document.view', 'doc.view')),",
    );
    expect(outcome.text).toContain("for select");
  });

  it("types scopes from teamType and scopeTypes and ignores hook roles set to false", async () => {
    const outcome = await generate({
      from: "./roles.ts",
      config: {
        rls: {
          teamType: "bigint",
          scopeTypes: { tenant: "text" },
          capabilities: true,
        },
        supabase: {
          hook: {
            roles: false,
            memberships: [fromTable({ table: "memberships" })],
          },
        },
      },
    });
    expect(outcome.code).toBe(0);
    expect(outcome.text).toContain("returns setof bigint");
    expect(outcome.text).toContain("returns setof text");
    expect(outcome.text).not.toContain("user_roles (user_id, role app_role)");
  });

  it("maps graph tables and warns that --force recurses through own relations", async () => {
    const outcome = await generate({
      from: "./graph.ts",
      force: true,
      config: { rls: { tables: { node: "app.nodes" } } },
    });
    expect(outcome.code).toBe(0);
    expect(outcome.text).toContain('"app"."nodes"');
    expect(outcome.output).toContain(
      "--force: node relations owner are read from the node table itself",
    );
  });
});

describe("rls generate grants that never become a policy", () => {
  it("refuses a closure grant unless --skip-closures, and routes break-glass through its function", async () => {
    await expect(generate({ from: "./closure.ts" })).rejects.toThrow(
      "is not portable; rewrite it or pass --skip-closures",
    );
    const outcome = await generate({
      from: "./closure.ts",
      skipClosures: true,
    });
    expect(outcome.code).toBe(0);
    expect(outcome.output).toContain(
      "reads through permdock_break_glass_doc, not a policy",
    );
    expect(outcome.output).toMatch(
      /skipped non-portable grant .+\/doc\.update/u,
    );
  });
});

describe("rls generate flag combinations", () => {
  it("needs --target sql for --helpers-only", async () => {
    expect(
      await generate({ from: MINI, target: "drizzle", helpersOnly: true }),
    ).toEqual({
      code: 2,
      output: "rls generate --helpers-only needs --target sql and no --fields",
      text: "",
    });
  });

  it("needs --target sql for --split", async () => {
    const outcome = await generate({
      from: MINI,
      target: "drizzle",
      split: "helpers,policies",
      out: "db/{part}.ts",
      write: true,
    });
    expect(outcome.code).toBe(2);
    expect(outcome.output).toBe("rls generate --split needs --target sql");
  });
});

describe("rls generate --shims", () => {
  it("needs rls.migrate.helpers", async () => {
    const result = await generate({ from: "roles.ts", shims: true });
    expect(result.code).toBe(2);
    expect(result.output).toBe(
      "PermDock CLI: rls generate --shims needs rls.migrate.helpers in permdock.config.ts",
    );
  });

  it("appends the wrappers from the flag or rls.shims", async () => {
    const migrate = {
      helpers: { is_member: { form: "membership", scope: "tenant" } },
    } as const;
    const flagged = await generate({
      from: "roles.ts",
      shims: true,
      config: { rls: { migrate } },
    });
    expect(flagged.code).toBe(0);
    expect(flagged.text).toContain(
      `create or replace function "public".is_member(p_id uuid)`,
    );
    const configured = await generate({
      from: "roles.ts",
      config: { rls: { migrate, shims: { schema: "legacy" } } },
    });
    expect(configured.text).toContain(
      `create or replace function "legacy".is_member(`,
    );
    const off = await generate({
      from: "roles.ts",
      config: { rls: { migrate } },
    });
    expect(off.text).not.toContain("permdock shims");
  });
});
