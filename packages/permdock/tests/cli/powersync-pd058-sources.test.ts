import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { pd058 } from "../../src/cli/doctor/powersync.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import {
  junctionMembershipSource,
  type SqlMembershipSource,
} from "../../src/supabase/index.ts";

const permissions = definePermissions({
  job: resource({
    id: "id",
    actions: ["read"],
    relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "tenant_id" } },
  subject: () => null,
  roles: [role("owner", [allow(permissions.job.read)], { on: "tenant" })],
});

const cwd = mkdtempSync(join(tmpdir(), "permdock-pd058-"));

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const tier = junctionMembershipSource({
  table: "tenant_users",
  scope: "tenant",
  id: "tenant_id",
  roles: "tier_role",
});

async function messages(
  sources: readonly SqlMembershipSource[],
  memberships?: NonNullable<PermDockConfig["rls"]>["memberships"],
): Promise<readonly string[]> {
  const config: PermDockConfig = {
    policy: "policy.ts",
    rls: {
      tables: { job: "jobs" },
      membershipSources: sources,
      ...(memberships === undefined ? {} : { memberships }),
    },
    powersync: {},
  };
  const findings = await pd058({ cwd, config, policy: async () => policy });
  return findings
    .map((finding) => finding.message)
    .filter((message) => message.includes("membership source"));
}

describe("PD058 membership sources", () => {
  it("names a synced scope's source that has no stream form", async () => {
    const expiring = junctionMembershipSource({
      table: "user_roles",
      scope: "tenant",
      id: "tenant_id",
      roles: "role",
      expiresAt: "expires_at",
    });
    expect(await messages([tier, expiring])).toEqual([
      "the public.user_roles membership source has no stream: it has an expiry",
    ]);
  });

  it("reports nothing for sources that all have a stream form", async () => {
    expect(await messages([tier])).toEqual([]);
  });

  it("skips a scope an rls.memberships table maps", async () => {
    const expiring = junctionMembershipSource({
      table: "user_roles",
      scope: "tenant",
      id: "tenant_id",
      roles: "role",
      disabledAt: "disabled_at",
    });
    expect(
      await messages([expiring], {
        tenant: { table: "members", user: "user_id", role: "role" },
      }),
    ).toEqual([]);
  });
});
