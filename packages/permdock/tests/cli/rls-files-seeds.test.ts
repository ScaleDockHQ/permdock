import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { Policy } from "../../src/core/policy-types.ts";

import { rls } from "../../src/cli/generate/plugins/rls.ts";
import { defineSeeds } from "../../src/core/seeds.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  note: resource({
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy: Policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
  roles: [role("reader", [allow(permissions.note.read)], { on: "tenant" })],
});

const POLICY_SOURCE = `import { allow, definePermissions, definePolicy, resource, role } from "permdock";

export const permissions = definePermissions({
  note: resource({
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
  roles: [role("reader", [allow(permissions.note.read)], { on: "tenant" })],
});
`;

const dirs: string[] = [];

describe("the rls plugin's defaults seeds", () => {
  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the rows a new defaults migration adds against the newest one", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-rls-seeds-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
    writeFileSync(join(cwd, "policy.ts"), POLICY_SOURCE);
    writeFileSync(
      join(cwd, "supabase/migrations/20260101000000_permdock_defaults.sql"),
      "-- permdock:defaults v1\ninsert into t values\n  ('old', 'x'),\n  ('older', 'y')\n;\n",
    );
    const seeds = defineSeeds(policy, {
      defaults: {
        roles: [
          {
            key: "reader",
            scope: "tenant",
            system: true,
            grants: [permissions.note.read],
          },
        ],
      },
    });
    const emitted = await rls({ out: "rls.sql" }).emit(
      { id: "sql", out: "rls.sql" },
      // SAFETY: the rls plugin ignores the model argument.
      {} as never,
      { cwd, config: { policy: "policy.ts", seeds }, policy },
    );
    expect(emitted.notes?.join("\n")).toMatch(
      /seeds: \+1 row, -2 rows against the newest seeds migration \(20260101000000_permdock_defaults.sql\)/u,
    );
  });

  it("passes the fields, guc prefix, policy name and tenant type through", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-rls-options-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "policy.ts"), POLICY_SOURCE);
    const emitted = await rls({
      out: "rls.sql",
      tenantType: "text",
      gucPrefix: "app",
      policyName: "{table}_{op}_p",
      fields: "views",
    }).emit(
      { id: "sql", out: "rls.sql" },
      // SAFETY: the rls plugin ignores the model argument.
      {} as never,
      { cwd, config: { policy: "policy.ts" }, policy },
    );
    expect(emitted.length).toBeGreaterThan(0);
  });
});
