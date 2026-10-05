import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";
import type { Principal } from "../../src/core/subject.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import {
  indexedFields,
  indexName,
  pruneIndexTargets,
  readTableIndexFacts,
} from "../../src/cli/rls-indexes.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
} from "../../src/index.ts";
import { fakeSql } from "../fakes/sql.ts";

describe("indexedFields", () => {
  it("keeps comparisons with the subject or a membership, through and and or", () => {
    expect(
      indexedFields({
        op: "and",
        conditions: [
          { op: "eq", field: "status", value: "open" },
          { op: "eq", field: "owner_id", value: { ref: "principal.id" } },
          {
            op: "or",
            conditions: [
              {
                op: "in",
                field: "region",
                value: { ref: "principal.claims.regions" },
              },
              { op: "in", field: "meta.kind", value: { ref: "principal.id" } },
              {
                op: "memberOf",
                scope: "project",
                field: "project_id",
                roles: [],
              },
              {
                op: "not",
                condition: {
                  op: "eq",
                  field: "editor_id",
                  value: { ref: "principal.id" },
                },
              },
              { op: "isNull", field: "archived_at", value: true },
              {
                op: "related",
                resource: "folder",
                relation: "viewer",
                field: "folder_id",
                depth: 0,
              },
            ],
          },
          {
            op: "sqlFunction",
            name: "f",
            args: [],
            twin: { op: "eq", field: "amount", value: { ref: "principal.id" } },
          },
        ],
      }),
    ).toEqual(["owner_id", "region", "project_id"]);
    expect(indexedFields(undefined)).toEqual([]);
  });
});

describe("pruneIndexTargets", () => {
  const targets = [
    { table: "public.ticket", columns: ["workspace_id"] },
    { table: "public.ticket", columns: ["project_id"] },
    { table: "public.members", columns: ["user_id", "workspace_id"] },
    { table: "public.grants", columns: ["user_id"] },
    { table: "public.gone", columns: ["user_id"] },
  ];

  it("drops covered targets and the ones the database cannot hold", () => {
    expect(
      pruneIndexTargets(targets, {
        columns: {
          "public.ticket": ["id", "workspace_id"],
          "public.members": ["user_id", "workspace_id", "role"],
          "public.grants": ["user_id", "scope_id"],
        },
        indexes: {
          "public.ticket": [["workspace_id", "id"]],
          "public.members": [["user_id"]],
        },
      }),
    ).toEqual({
      targets: [
        { table: "public.members", columns: ["user_id", "workspace_id"] },
        { table: "public.grants", columns: ["user_id"] },
      ],
      warnings: [
        "no index suggested on public.ticket (project_id): the table has no column project_id",
        "no index suggested on public.gone: the database has no such table",
      ],
    });
  });

  it("reads columns and index key columns, cut at the first expression", async () => {
    const sql = fakeSql((call) =>
      call.sql.includes("pg_attribute a\njoin")
        ? {
            rows: [
              { target: "public.ticket", name: "id" },
              { target: "public.ticket", name: "workspace_id" },
            ],
          }
        : {
            rows: [
              { target: "public.ticket", columns: ["workspace_id", "id"] },
              { target: "public.ticket", columns: [null, "id"] },
              { target: "public.ticket", columns: ["id", null] },
              { target: "public.ticket", columns: "{bad}" },
            ],
          },
    );
    expect(
      await readTableIndexFacts(
        "postgres://fake",
        ["public.ticket"],
        sql.connect,
      ),
    ).toEqual({
      columns: { "public.ticket": ["id", "workspace_id"] },
      indexes: { "public.ticket": [["workspace_id", "id"], ["id"]] },
    });
    expect(sql.ended()).toBe(true);
  });
});

describe("indexName", () => {
  it("names the table and columns, and hashes a name over 63 bytes", () => {
    expect(indexName({ table: "public.invoice", columns: ["status"] })).toBe(
      "permdock_invoice_status_idx",
    );
    const long = indexName({
      table: "public.a_table_with_a_rather_long_name",
      columns: ["and_a_long_column_name_as_well"],
    });
    expect(long).toMatch(/^permdock_[0-9a-f]{8}_idx$/u);
  });
});

describe("index targets from compiled grants", () => {
  const permissions = definePermissions({
    ticket: resource(
      z.object({
        id: z.string(),
        workspace_id: z.string(),
        owner_id: z.string(),
        status: z.string(),
      }),
      {
        id: "id",
        actions: ["read", "update"],
        relations: {
          workspace: { field: "workspace_id", memberOf: "workspace" },
        },
      },
    ),
  });
  const policy = definePolicy(permissions, {
    scopes: { workspace: { key: "workspace_id" } },
    subject: (user: Principal) => user,
    roles: [
      role(
        "member",
        [
          allow(permissions.ticket.read, { where: { status: "open" } }),
          allow(permissions.ticket.update, {
            where: { owner_id: principal.id },
          }),
        ],
        { on: "workspace" },
      ),
    ],
  });
  const ctx: RlsSqlContext = {
    dialect: "guc",
    scopes: scopeList(policy.scopes),
    tenantClaim: "tenant_id",
    gucPrefix: "app",
  };

  it("keeps the scope key and the subject comparison, not the constant one", () => {
    const compiled = compileGrants(policy, ctx, undefined, [], false);
    expect(
      compiled.rowColumns
        .map((item) => `${item.table}.${item.column}`)
        .toSorted(),
    ).toEqual(["ticket.owner_id", "ticket.workspace_id"]);
  });
});
