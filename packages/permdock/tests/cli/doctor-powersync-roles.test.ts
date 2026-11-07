import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { blockMembershipSource } from "../../src/better-supabase/block-memberships.ts";
import { pd102 } from "../../src/cli/doctor/powersync.ts";
import { junctionMembershipSource } from "../../src/supabase/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "../../tmp");
const dirs: string[] = [];

function project(yaml: string | undefined): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, "pd102-"));
  dirs.push(cwd);
  if (yaml !== undefined) {
    writeFileSync(join(cwd, "sync-config.yaml"), yaml);
  }
  return cwd;
}

const many: PermDockConfig = {
  policy: "p.ts",
  powersync: {},
  rls: { membershipSources: [blockMembershipSource({ roles: "many" })] },
};

const STALE = `streams:
  permdock_membership_roles:
    queries:
      - 'SELECT * FROM "better_supabase"."membership_roles" AS membership_roles WHERE membership_roles.user_id = auth.user_id()'
`;

describe("PD102", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a stream that still filters the roles junction on the caller's user id", () => {
    const findings = pd102({ cwd: project(STALE), config: many });
    expect(findings).toStrictEqual([
      expect.objectContaining({
        code: "PD102",
        severity: "warning",
        target: "sync-config.yaml",
      }),
    ]);
    expect(findings[0]?.message).toContain(
      "membership_roles.user_id = auth.user_id()",
    );
  });

  it("skips sources whose roles are a column, a fixed list or a map", () => {
    const sources: PermDockConfig = {
      policy: "p.ts",
      powersync: {},
      rls: {
        membershipSources: [
          junctionMembershipSource({
            table: "public.a",
            scope: "organization",
            id: "organization_id",
            roles: "role",
          }),
          junctionMembershipSource({
            table: "public.b",
            scope: "organization",
            id: "organization_id",
            roles: ["member"],
          }),
          junctionMembershipSource({
            table: "public.c",
            scope: "organization",
            id: "organization_id",
            roles: { column: "kind", map: { admin: "owner" } },
          }),
        ],
      },
    };
    expect(pd102({ cwd: project(STALE), config: sources })).toStrictEqual([]);
  });

  it("passes the regenerated file, a plain junction and a project with no file", () => {
    const current = STALE.replace(
      "membership_roles.user_id = auth.user_id()",
      "membership_roles.organization_id IN (SELECT 1)",
    );
    expect(pd102({ cwd: project(current), config: many })).toStrictEqual([]);
    expect(pd102({ cwd: project(undefined), config: many })).toStrictEqual([]);
    const plain: PermDockConfig = {
      policy: "p.ts",
      powersync: {},
      rls: {
        membershipSources: [
          junctionMembershipSource({
            table: "better_supabase.memberships",
            scope: "organization",
            id: "organization_id",
            roles: {
              through: "better_supabase.membership_roles",
              on: { organization_id: "organization_id", user_id: "user_id" },
              column: "role",
            },
          }),
        ],
      },
    };
    expect(pd102({ cwd: project(STALE), config: plain })).toStrictEqual([]);
  });
});
