import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ClaimsChangeFixture } from "../../src/cli/fixtures.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import { blockMembershipSource } from "../../src/better-supabase/block-memberships.ts";
import { loadFixtures } from "../../src/cli/fixtures.ts";
import { POSTGRES, powersyncPlan } from "../../src/cli/powersync/streams.ts";
import { verifyClaimsChange } from "../../src/cli/powersync/verify-claims.ts";
import {
  allow,
  authenticated,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  job: resource({ id: "id", actions: ["read"] }),
});

const policy = definePolicy(permissions, {
  subject: () => null,
  grants: [
    allow(permissions.job.read, {
      to: authenticated(),
      where: { team_id: { in: { ref: "principal.claims.team_ids" } } },
    }),
  ],
});

const config: PermDockConfig = {
  policy: "policy.ts",
  rls: { tables: { job: "jobs" } },
  powersync: {},
};

const plan = powersyncPlan(policy, config, POSTGRES);

const jobs = [
  { id: "j1", team_id: "A" },
  { id: "j2", team_id: "B" },
];

/** Rows by the claims parameter; `leak` adds a row no team allows. */
function query(leak = false) {
  return async (_sql: string, values: unknown[]) => {
    const claims: unknown = JSON.parse(String(values[1]));
    const teams =
      typeof claims === "object" && claims !== null && "team_ids" in claims
        ? claims.team_ids
        : [];
    const rows = jobs.filter(
      (row) => Array.isArray(teams) && teams.includes(row.team_id),
    );
    return leak && rows.length > 0
      ? [...rows, { id: "j9", team_id: "Z" }]
      : rows;
  };
}

async function check(
  fixture: ClaimsChangeFixture,
  leak = false,
): Promise<readonly string[]> {
  const mismatches: string[] = [];
  await verifyClaimsChange({
    policy,
    config,
    customRoles: [],
    plan,
    fixture,
    root: undefined,
    query: query(leak),
    mismatches,
  });
  return mismatches;
}

const cwd = mkdtempSync(join(tmpdir(), "permdock-claims-change-"));

describe("powersync verify claims-change fixtures", () => {
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("passes when the stream's rows follow the new claims", async () => {
    expect(
      await check({
        subject: { id: "u1", claims: { team_ids: ["A"] } },
        after: { claims: { team_ids: ["B"] } },
        expected: "changed",
      }),
    ).toStrictEqual([]);
  });

  it("fails when the rows stay the same", async () => {
    expect(
      await check({
        subject: { id: "u1", claims: { team_ids: ["A"] } },
        after: { claims: { team_ids: ["A", "C"] } },
        expected: "changed",
      }),
    ).toStrictEqual([
      "claims change for u1: stream job syncs the same rows before and after the change",
    ]);
  });

  it("fails when a row after the change is one the policy denies", async () => {
    expect(
      await check(
        {
          subject: { id: "u1", claims: { team_ids: ["A"] } },
          after: { claims: { team_ids: ["B"] } },
          stream: "job",
          expected: "changed",
        },
        true,
      ),
    ).toStrictEqual([
      "claims change for u1: stream job syncs jobs row j9 after the change, which the policy denies",
    ]);
  });

  it("fails when no stream reads a changed claim or the named stream is unknown", async () => {
    expect(
      await check({
        subject: { id: "u1", claims: { team_ids: ["A"] } },
        after: { roles: ["lead"] },
        expected: "changed",
      }),
    ).toStrictEqual(["claims change for u1: no stream reads a changed claim"]);
    expect(
      await check({
        subject: { id: "u1" },
        after: { claims: { team_ids: ["A"] } },
        stream: "ghost",
        expected: "changed",
      }),
    ).toStrictEqual(["claims change for u1: no stream named ghost"]);
  });

  it("reads numeric ids and each row's organization, and skips rows without an id", async () => {
    const mismatches: string[] = [];
    await verifyClaimsChange({
      policy,
      config,
      customRoles: [],
      plan,
      fixture: {
        subject: { id: "u1", claims: { team_ids: ["A"] } },
        after: { claims: { team_ids: ["B"] } },
        expected: "changed",
      },
      root: "org_id",
      query: async (_sql, values) =>
        String(values[1]).includes('"B"')
          ? [{ id: 2, team_id: "B", org_id: 7 }, "not a row"]
          : [{ id: 1n, team_id: "A" }],
      mismatches,
    });
    expect(mismatches).toStrictEqual([]);
  });

  it("checks only the row sets when the stream's action is not a permission", async () => {
    const mismatches: string[] = [];
    await verifyClaimsChange({
      policy,
      config: { ...config, powersync: { action: "archive" } },
      customRoles: [],
      plan,
      fixture: {
        subject: { id: "u1" },
        after: { roles: ["lead"] },
        stream: "job",
        expected: "changed",
      },
      root: undefined,
      query: query(),
      mismatches,
    });
    expect(mismatches).toStrictEqual([
      "claims change for u1: stream job syncs the same rows before and after the change",
    ]);
  });

  it("parses claims-change fixtures for powersync verify only", async () => {
    const fixture = {
      subject: { id: "u1", claims: { team_ids: ["A"] } },
      after: { tenant: "t2", claims: { team_ids: ["B"] } },
      expected: "changed",
    };
    writeFileSync(join(cwd, "ok.json"), JSON.stringify([fixture]));
    expect((await loadFixtures(cwd, "ok.json", true)).fixtures).toStrictEqual([
      fixture,
    ]);
    await expect(loadFixtures(cwd, "ok.json")).rejects.toThrow(
      "fixture 0 needs subject and row",
    );
    for (const bad of [
      { ...fixture, expected: "granted" },
      { ...fixture, action: "job.read" },
      { ...fixture, after: { roles: "lead" } },
      { ...fixture, after: { claims: [] } },
      { ...fixture, stream: "" },
    ]) {
      writeFileSync(join(cwd, "bad.json"), JSON.stringify([bad]));
      await expect(loadFixtures(cwd, "bad.json", true)).rejects.toThrow(
        'fixture 0 needs after (tenant, roles, memberships, claims) and expected "changed", without action or table',
      );
    }
  });

  describe("over a composite roles junction", () => {
    const scoped = definePermissions({
      job: resource({
        id: "id",
        actions: ["read"],
        relations: {
          organization: { field: "organization_id", memberOf: "organization" },
        },
      }),
    });
    const byOrganization = definePolicy(scoped, {
      scopes: { organization: { key: "organization_id" } },
      subject: () => null,
      roles: [
        role(
          "owner",
          [
            allow(scoped.job.read, {
              where: { team_id: { in: { ref: "principal.claims.team_ids" } } },
            }),
          ],
          { on: "organization" },
        ),
      ],
    });
    const junction: PermDockConfig = {
      policy: "policy.ts",
      rls: {
        tables: { job: "jobs" },
        membershipSources: [blockMembershipSource({ roles: "many" })],
      },
      powersync: {},
    };
    const junctionPlan = powersyncPlan(byOrganization, junction, POSTGRES);
    const owned = [
      { id: "j1", team_id: "A", organization_id: "o1" },
      { id: "j2", team_id: "B", organization_id: "o1" },
    ];

    async function junctionCheck(leak: boolean): Promise<readonly string[]> {
      const mismatches: string[] = [];
      await verifyClaimsChange({
        policy: byOrganization,
        config: junction,
        customRoles: [],
        plan: junctionPlan,
        fixture: {
          subject: {
            id: "u1",
            memberships: [
              { scope: "organization", id: "o1", roles: ["owner"] },
            ],
            claims: { team_ids: ["A"] },
          },
          after: { claims: { team_ids: ["B"] } },
          expected: "changed",
        },
        root: "organization_id",
        query: async (_sql, values) => {
          const rows = owned.filter((row) =>
            String(values[1]).includes(`"${row.team_id}"`),
          );
          return leak && String(values[1]).includes('"B"')
            ? [...rows, { id: "j9", team_id: "B", organization_id: "o2" }]
            : rows;
        },
        mismatches,
      });
      return mismatches;
    }

    it("reads the claim through a stream joined on every pair of the junction", () => {
      const stream = junctionPlan.streams.find((entry) => entry.name === "job");
      expect(stream?.claims).toStrictEqual(["team_ids"]);
      expect(stream?.queries.join("\n")).toContain(
        "membership_roles.organization_id::text = memberships.organization_id::text AND membership_roles.user_id::text = memberships.user_id::text",
      );
    });

    it("passes when the rows follow the claims and fails on another organization's row", async () => {
      await expect(junctionCheck(false)).resolves.toStrictEqual([]);
      await expect(junctionCheck(true)).resolves.toStrictEqual([
        "claims change for u1: stream job syncs jobs row j9 after the change, which the policy denies",
      ]);
    });
  });
});
