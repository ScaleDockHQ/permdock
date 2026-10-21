import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import { run } from "../../src/cli/core/run.ts";
import { pd073 } from "../../src/cli/doctor/rls.ts";
import {
  ownershipRules,
  unsatisfiedKinds,
} from "../../src/cli/rls/ownership.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "../../src/index.ts";
import {
  junctionMembershipSource,
  tableMembershipSource,
} from "../../src/supabase/sources.ts";
import { policyModule, project, removeProjects } from "./doctor-kit.ts";

afterEach(removeProjects);

const Doc = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  doc: resource(Doc, {
    id: "id",
    actions: ["read"],
    relations: { org: { field: "org_id", memberOf: "org" } },
  }),
});
const roles = defineRoles({ contact: { on: "org" }, member: { on: "org" } });
const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { org: { key: "org_id" } },
    // SAFETY: SQL generation never calls the subject mapper.
    subject: (user: unknown) => user as never,
    roles: [
      role(roles.contact, [allow(permissions.doc.read)], {
        on: "org",
        for: ["contact"],
      }),
      role(roles.member, [allow(permissions.doc.read)], { on: "org" }),
    ],
  },
);
const scopes = scopeList(policy.scopes);

function context(memberSources: RlsSqlContext["memberSources"]): RlsSqlContext {
  const ownership = ownershipRules(policy, scopes);
  return {
    dialect: "supabase",
    scopes,
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    authorize: "database",
    ...(ownership === undefined ? {} : { ownership }),
    ...(memberSources === undefined ? {} : { memberSources }),
  };
}

const staff = junctionMembershipSource({
  table: "org_staff",
  scope: "org",
  roles: ["contact"],
  via: "staff",
});

describe("unsatisfiedKinds", () => {
  it("names a role whose kinds every source of its scope contradicts", () => {
    expect(unsatisfiedKinds(context([staff]), policy)).toEqual([
      { role: "contact", for: ["contact"], sources: ["org_staff (via staff)"] },
    ]);
  });

  it("is satisfied by a matching constant, a via column or a source with no kind to compare", () => {
    const contact = junctionMembershipSource({
      table: "org_contacts",
      scope: "org",
      roles: ["contact"],
      via: "contact",
    });
    const column = tableMembershipSource({
      table: "memberships",
      columns: { via: "kind" },
    });
    expect(unsatisfiedKinds(context([staff, contact]), policy)).toEqual([]);
    expect(unsatisfiedKinds(context([column]), policy)).toEqual([]);
    expect(unsatisfiedKinds(context(undefined), policy)).toEqual([]);
  });

  it("reads the kind of a mapped membership table and skips a source of another scope", () => {
    const table = (via: string | { value: string }): RlsSqlContext => ({
      ...context(undefined),
      memberships: {
        scopes: {
          org: {
            table: "org_members",
            user: "user_id",
            role: "role",
            via,
            columns: { org: "org_id" },
          },
        },
      },
    });
    expect(unsatisfiedKinds(table({ value: "staff" }), policy)).toEqual([
      {
        role: "contact",
        for: ["contact"],
        sources: ["org_members (via staff)"],
      },
    ]);
    expect(unsatisfiedKinds(table("kind"), policy)).toEqual([]);
    const elsewhere = junctionMembershipSource({
      table: "team_staff",
      scope: "team",
      roles: ["contact"],
      via: "staff",
    });
    expect(unsatisfiedKinds(context([elsewhere]), policy)).toEqual([]);
  });

  it("skips a role that is not held on a scope", () => {
    const base = context([staff]);
    // SAFETY: a role name the policy lacks is the case under test; the rest of the context is complete.
    const ghost = {
      ...base,
      ownership: {
        kinds: { ghost: ["contact"] },
        assigns: base.ownership?.assigns ?? {},
        counted: [],
      },
    } as RlsSqlContext;
    expect(unsatisfiedKinds(ghost, policy)).toEqual([]);
  });

  it("does not compare a source with no via", () => {
    const plain = junctionMembershipSource({
      table: "org_members",
      scope: "org",
      roles: ["contact"],
    });
    expect(unsatisfiedKinds(context([plain]), policy)).toEqual([]);
  });
});

describe("PD073 inputs", () => {
  it("is quiet without a policy and reads the hook's sources", async () => {
    expect(await pd073({ cwd: ".", config: { rls: {} } })).toEqual([]);
    expect(
      await pd073({ cwd: ".", config: { policy: "missing.ts", rls: {} } }),
    ).toEqual([]);
  });
});

describe("PD073", () => {
  it("reports the finding as an error and the generator refuses it", async () => {
    const cwd = project({
      "src/permissions.ts": `import { definePermissions, resource } from 'permdock';

export const permissions = definePermissions({
  doc: resource({ actions: ['read'], relations: { org: { field: 'orgId', memberOf: 'org' } } }),
});
`,
      "src/policy.ts": policyModule(`  scopes: { org: { key: 'orgId' } },
  roles: [role('contact', [allow(permissions.doc.read)], { on: 'org', for: ['contact'] })],`),
    });
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `import { junctionMembershipSource } from 'permdock/supabase';

export default {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  rls: {
    dialect: 'supabase',
    authorize: 'database',
    membershipSources: [junctionMembershipSource({ table: 'org_staff', scope: 'org', roles: ['contact'], via: 'staff' })],
  },
};
`,
    );
    const config = {
      permissions: "src/permissions.ts",
      policy: "src/policy.ts",
      rls: {
        dialect: "supabase" as const,
        authorize: "database" as const,
        membershipSources: [staff],
      },
    };
    const findings = await pd073({ cwd, config });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: "PD073", severity: "error" });
    expect(findings[0]?.message).toContain("org_staff (via staff)");
    const viaHook = await pd073({
      cwd,
      config: {
        permissions: "src/permissions.ts",
        policy: "src/policy.ts",
        rls: { dialect: "supabase", authorize: "database" },
        supabase: { hook: { memberships: [staff] } },
      },
    });
    expect(viaHook).toHaveLength(1);
    const explained = await run(["rls", "explain"], { cwd });
    expect(explained.code).toBe(2);
    const generated = await run(["rls", "generate", "--target", "sql"], {
      cwd,
    });
    expect(generated.code).toBe(2);
    expect(generated.stdout + generated.stderr).toContain(
      "role contact is for contact, but its membership sources hold org_staff (via staff)",
    );
  });
});
