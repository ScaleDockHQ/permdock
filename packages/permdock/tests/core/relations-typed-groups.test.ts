import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { closureDepths, graphPlan, graphSql } from "../../src/cli/rls-graph.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  getResource,
  memoryRelations,
  relation,
  resource,
} from "../../src/index.ts";

const Team = z.object({ id: z.number() });
const Drive = z.object({ id: z.string() });

const permissions = definePermissions({
  team: resource(Team, {
    actions: ["read"],
    relations: {
      member: {
        edge: "team_members",
        object: "team_id",
        subject: "user_id",
        groups: {
          resources: {
            team: { relation: "member", subject: "member_team_id" },
          },
        },
      },
    },
  }),
  drive: resource(Drive, {
    actions: ["read"],
    relations: {
      viewer: {
        edge: "drive_shares",
        object: "drive_id",
        subject: "user_id",
        groups: {
          resources: { team: { relation: "member", subject: "team_id" } },
        },
      },
    },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { org: { key: "orgId" } },
  grants: [
    allow(permissions.drive.read, {
      to: relation(permissions.drive, "viewer"),
    }),
  ],
  subject: (user: { readonly id: string }) => ({ id: user.id }),
});

const rows = {
  team: [{ id: 1 }, { id: 2 }, { id: 3 }],
  drive: [{ id: "plans" }, { id: "budget" }, { id: "both" }, { id: "none" }],
};

const tables = {
  team_members: [
    { team_id: 1, user_id: "uma", member_team_id: null },
    { team_id: 1, user_id: null, member_team_id: 2 },
    { team_id: 2, user_id: "nina", member_team_id: null },
    { team_id: 3, user_id: "otis", member_team_id: null },
  ],
  drive_shares: [
    { drive_id: "plans", user_id: "dana", team_id: null },
    { drive_id: "budget", user_id: null, team_id: 1 },
    { drive_id: "both", user_id: "dana", team_id: 3 },
    { drive_id: "none", user_id: null, team_id: null },
  ],
};

const relations = memoryRelations(permissions, { rows, tables });

async function readable(user: string): Promise<readonly string[]> {
  const permdock = await createPermDock(policy, { id: user }, { relations });
  await permdock.loadRelations(permissions.drive.read, rows.drive);
  return rows.drive
    .filter((row) => permdock.can(permissions.drive.read, row))
    .map((row) => row.id);
}

describe("edge groups with a subject column per group", () => {
  it("normalises each group to its relation and subject column", () => {
    expect(getResource(permissions, "drive")?.relations["viewer"]).toEqual({
      edge: "drive_shares",
      object: "drive_id",
      subject: "user_id",
      groups: {
        resources: { team: { relation: "member", subject: "team_id" } },
      },
    });
  });

  it("reads the principal from the edge subject and each group from its own column", async () => {
    expect(await readable("dana")).toEqual(["plans", "both"]);
    expect(await readable("uma")).toEqual(["budget"]);
    expect(await readable("nina")).toEqual(["budget"]);
    expect(await readable("otis")).toEqual(["both"]);
    expect(await readable("nobody")).toEqual([]);
  });

  it("answers a row with both columns set as a principal and a group holder", async () => {
    const holders = await relations.related({
      resource: "drive",
      id: "both",
      relation: "viewer",
    });
    expect(holders).toEqual([
      { principal: { id: "dana" } },
      { group: { resource: "team", id: "3", relation: "member" } },
    ]);
  });

  it("keeps the resource column when it is set, and reads the group id from the group column", async () => {
    const mixed = definePermissions({
      team: resource(Team, {
        actions: ["read"],
        relations: { member: { edge: "team_members", object: "team_id" } },
      }),
      drive: resource(Drive, {
        actions: ["read"],
        relations: {
          viewer: {
            edge: "drive_shares",
            object: "drive_id",
            groups: {
              column: "kind",
              direct: "user",
              resources: { team: { relation: "member", subject: "team_id" } },
            },
          },
        },
      }),
    });
    const source = memoryRelations(mixed, {
      tables: {
        drive_shares: [
          { drive_id: "a", kind: "user", user_id: "dana", team_id: 9 },
          { drive_id: "a", kind: "team", user_id: "dana", team_id: 7 },
          { drive_id: "a", kind: "robot", user_id: "rob", team_id: 8 },
        ],
      },
    });
    expect(
      await source.related({ resource: "drive", id: "a", relation: "viewer" }),
    ).toEqual([
      { principal: { id: "dana" } },
      { group: { resource: "team", id: "7", relation: "member" } },
    ]);
  });

  it("compiles each group to its own column and nested groups to the group column", () => {
    const plan = graphPlan(policy);
    const ctx: RlsSqlContext = {
      dialect: "guc",
      scopes: scopeList(policy.scopes),
      tenantClaim: "tenant_id",
      gucPrefix: "app",
      graph: { closures: closureDepths(plan), resources: policy.resources },
    };
    const sql = graphSql(ctx, plan, undefined);
    expect(sql).toContain(
      `where ((e1."user_id" = (select current_setting('app.user_id', true))) or (e1."team_id"::text in (select "permdock".permitted_team_ids('member'))))`,
    );
    expect(sql).toContain(
      `join g2 on e3."member_team_id"::text = g2.id where e3."member_team_id" is not null`,
    );
    expect(sql).not.toContain('"kind"');
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    [
      "a plain group without a resource column",
      { resources: { team: "member" } },
      /needs its own subject column/u,
    ],
    [
      "a group object without a subject or a resource column",
      { resources: { team: { relation: "member" } } },
      /needs its own subject column/u,
    ],
    [
      "a direct value without a resource column",
      {
        direct: "user",
        resources: { team: { relation: "member", subject: "team_id" } },
      },
      /direct needs a column/u,
    ],
    [
      "a non-string group subject",
      { resources: { team: { relation: "member", subject: 5 } } },
      /subject must be a column name/u,
    ],
    [
      "an unsafe group subject",
      { resources: { team: { relation: "member", subject: "__proto__" } } },
      /forbidden/u,
    ],
  ])("rejects %s", (_label, groups, error) => {
    expect(() =>
      definePermissions({
        team: resource({
          actions: ["read"],
          relations: { member: { edge: "team_members" } },
        }),
        drive: resource({
          actions: ["read"],
          // SAFETY: untyped groups, as a JavaScript caller could pass them.
          relations: { viewer: { edge: "drive_shares", groups } as never },
        }),
      }),
    ).toThrow(error);
  });
});
