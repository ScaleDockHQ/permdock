import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ClaimsChangeFixture } from "../../src/cli/fixtures.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import { loadFixtures } from "../../src/cli/fixtures.ts";
import { POSTGRES, powersyncPlan } from "../../src/cli/powersync/streams.ts";
import { verifyClaimsChange } from "../../src/cli/powersync/verify-claims.ts";
import {
  allow,
  authenticated,
  definePermissions,
  definePolicy,
  resource,
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
});
