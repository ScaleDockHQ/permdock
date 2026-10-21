import { describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";
import type { Condition } from "../../src/index.ts";

import {
  POSTGRES,
  POWERSYNC,
  powersyncPlan,
  powersyncYaml,
} from "../../src/cli/powersync/streams.ts";
import {
  actor,
  allow,
  anyone,
  authenticated,
  breakGlass,
  definePermissions,
  definePolicy,
  deny,
  principal,
  resource,
  role,
} from "../../src/index.ts";

const claim = (name: string) => ({ ref: `principal.claims.${name}` });

const Row = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  job: resource(Row, {
    id: "id",
    actions: ["read", "update"],
    relations: { organization: { field: "org_id", memberOf: "organization" } },
  }),
  folder: resource(Row, { id: "id", actions: ["read"] }),
  file: resource(Row, {
    id: "id",
    parent: { field: "folder_id", resource: "folder" },
    actions: ["read"],
  }),
  note: resource(Row, { id: "id", actions: ["read"] }),
  secret: resource(Row, { id: "id", actions: ["read"] }),
  audit: resource(Row, { id: "id", actions: ["read"] }),
});

const { audit, file, folder, job, note, secret } = permissions;

const policy = definePolicy(permissions, {
  scopes: { organization: { key: "org_id" } },
  // SAFETY: stream generation never calls the subject mapper.
  subject: (user: unknown) => user as never,
  roles: [
    role("admin", [allow([job.read, job.update])], { on: "organization" }),
    role(
      "tech",
      [
        allow(job.read, {
          where: {
            assignee_id: principal.id,
            status: { in: ["open", "done"] },
            priority: { gte: 2 },
            closed_at: { isNull: true },
          },
        }),
        allow(job.read, {
          where: {
            op: "or",
            conditions: [
              { op: "in", field: "team_id", value: claim("team_ids") },
              { op: "eq", field: "region", value: claim("region") },
            ],
          },
        }),
      ],
      { on: "organization" },
    ),
    role("contractor", [allow(job.read)], {
      on: "organization",
      for: ["contract"],
    }),
    role("viewer", [allow(job.read, { fields: ["title"] })], {
      on: "organization",
    }),
    role("ops", [allow(job.read)]),
    role("editor", [allow([folder.read, file.read])], { on: folder }),
  ],
  grants: [
    allow(note.read, {
      to: authenticated(),
      where: {
        author_id: principal.id,
        kind: { ne: "draft" },
        deleted: { eq: null },
      },
    }),
    allow(note.read, {
      to: authenticated(),
      where: { tags: { contains: "x" } },
    }),
    allow(note.read, { to: authenticated(), where: { not: { hidden: true } } }),
    allow(note.read, { to: authenticated(), where: { bucket: { in: [] } } }),
    allow(note.read, { to: authenticated(), where: { bucket: { notIn: [] } } }),
    allow(note.read, {
      to: authenticated(),
      where: { bucket: { notIn: claim("blocked") } },
    }),
    allow(note.read, { to: authenticated(), where: { "meta.kind": "x" } }),
    allow(note.read, {
      to: authenticated(),
      validUntil: "2030-01-01T00:00:00Z",
    }),
    allow(note.read, { to: authenticated(), approval: { by: "admin" } }),
    allow(note.read, {
      to: authenticated(),
      where: { owner: principal.tenant },
    }),
    allow(secret.read, { to: authenticated() }),
    deny(secret.read, { to: actor("oauth-client") }),
    breakGlass(audit.read, { requires: { reason: true } }),
  ],
});

const config: PermDockConfig = {
  policy: "p.ts",
  rls: {
    authorize: "database",
    tables: { job: "public.jobs", file: "app.files" },
    memberships: {
      scopes: {
        organization: {
          table: "organization_users",
          user: "user_id",
          role: [
            "tier",
            { through: "roles", on: { role_id: "id" }, column: "key" },
          ],
          via: "kind",
          columns: { organization: "organization_id" },
        },
      },
      resource: {
        folder: {
          table: "folder_members",
          user: "user_id",
          role: "role",
          id: "folder_id",
        },
      },
    },
  },
};

function queries(name: string, target = config): readonly string[] {
  return (
    powersyncPlan(policy, target).streams.find((stream) => stream.name === name)
      ?.queries ?? []
  );
}

describe("powersync streams", () => {
  it("compiles a mapped role column to the values that map to the roles", () => {
    const mapped = (map: Record<string, string | null>): PermDockConfig => ({
      ...config,
      rls: {
        ...config.rls,
        memberships: {
          scopes: {
            organization: {
              table: "organization_users",
              user: "user_id",
              role: { column: "kind", map },
              columns: { organization: "organization_id" },
            },
          },
        },
      },
    });
    const some = queries("job", mapped({ boss: "admin", staff: null }));
    expect(some).toContain(
      "SELECT * FROM jobs WHERE jobs.org_id IN (SELECT organization_users.organization_id FROM organization_users WHERE organization_users.user_id = auth.user_id() AND organization_users.kind IN ('boss'))",
    );
    expect(some.join("\n")).not.toContain("'staff'");
    expect(queries("job", mapped({ staff: null }))[0]).toBe(
      "SELECT * FROM jobs WHERE 1 = 0",
    );
  });

  it("streams the user's own memberships, the roles they reference and the tenant custom roles", () => {
    const plan = powersyncPlan(policy, {
      ...config,
      rls: {
        ...config.rls,
        customRoles: true,
        roles: {
          table: "user_roles",
          role: { through: "roles", on: { role_id: "id" }, column: "key" },
        },
      },
    });
    expect(plan.subject).toStrictEqual([
      {
        name: "permdock_organization_users",
        table: "organization_users",
        user: "user_id",
        queries: [
          "SELECT * FROM organization_users WHERE organization_users.user_id = auth.user_id()",
        ],
      },
      {
        name: "permdock_roles",
        table: "roles",
        queries: [
          "SELECT * FROM roles WHERE roles.id IN (SELECT organization_users.role_id FROM organization_users WHERE organization_users.user_id = auth.user_id())",
          "SELECT * FROM roles WHERE roles.id IN (SELECT user_roles.role_id FROM user_roles WHERE user_roles.user_id = auth.user_id())",
        ],
      },
      {
        name: "permdock_folder_members",
        table: "folder_members",
        user: "user_id",
        queries: [
          "SELECT * FROM folder_members WHERE folder_members.user_id = auth.user_id()",
        ],
      },
      {
        name: "permdock_user_roles",
        table: "user_roles",
        user: "user_id",
        queries: [
          "SELECT * FROM user_roles WHERE user_roles.user_id = auth.user_id()",
        ],
      },
      {
        name: "permdock_custom_role_permissions",
        table: "custom_role_permissions",
        queries: [
          'SELECT * FROM "permdock"."custom_role_permissions" AS custom_role_permissions WHERE custom_role_permissions.tenant_id IS NULL',
          'SELECT * FROM "permdock"."custom_role_permissions" AS custom_role_permissions WHERE custom_role_permissions.tenant_id IN (SELECT organization_users.organization_id FROM organization_users WHERE organization_users.user_id = auth.user_id())',
        ],
      },
      {
        name: "permdock_custom_role_includes",
        table: "custom_role_includes",
        queries: [
          'SELECT * FROM "permdock"."custom_role_includes" AS custom_role_includes WHERE custom_role_includes.tenant_id IS NULL',
          'SELECT * FROM "permdock"."custom_role_includes" AS custom_role_includes WHERE custom_role_includes.tenant_id IN (SELECT organization_users.organization_id FROM organization_users WHERE organization_users.user_id = auth.user_id())',
        ],
      },
    ]);
    expect(powersyncYaml(plan)).toContain(
      "  permdock_user_roles:\n    auto_subscribe: true\n",
    );
  });

  it("streams tenant and team tables, skips a through without on, and drops user when two tables share rows", () => {
    const plan = powersyncPlan(policy, {
      policy: "p.ts",
      rls: {
        memberships: {
          scopes: {
            tenant: {
              table: "members",
              user: "user_id",
              role: { through: "roles", on: {}, column: "key" },
            },
            team: { table: "members", user: "member_id", role: "role" },
          },
        },
        roles: { table: "admins", user: "account_id", role: "level" },
      },
    });
    expect(plan.subject).toStrictEqual([
      {
        name: "permdock_members",
        table: "members",
        queries: [
          "SELECT * FROM members WHERE members.user_id = auth.user_id()",
          "SELECT * FROM members WHERE members.member_id = auth.user_id()",
        ],
      },
      {
        name: "permdock_admins",
        table: "admins",
        user: "account_id",
        queries: [
          "SELECT * FROM admins WHERE admins.account_id = auth.user_id()",
        ],
      },
    ]);
  });

  it("streams the default user_roles table in database mode and nothing without memberships", () => {
    expect(
      powersyncPlan(policy, { policy: "p.ts", rls: { authorize: "database" } })
        .subject,
    ).toStrictEqual([
      {
        name: "permdock_user_roles",
        table: "user_roles",
        user: "user_id",
        queries: [
          'SELECT * FROM "permdock"."user_roles" AS user_roles WHERE user_roles.user_id = auth.user_id()',
        ],
      },
    ]);
    expect(powersyncPlan(policy, { policy: "p.ts" }).subject).toStrictEqual([]);
  });

  it("compiles a scope role over every role source of the membership table", () => {
    expect(queries("job")).toContain(
      "SELECT * FROM jobs WHERE jobs.org_id IN (SELECT organization_users.organization_id FROM organization_users WHERE organization_users.user_id = auth.user_id() AND organization_users.tier IN ('admin'))",
    );
    expect(queries("job")).toContain(
      "SELECT * FROM jobs WHERE jobs.org_id IN (SELECT organization_users.organization_id FROM organization_users INNER JOIN roles ON roles.id = organization_users.role_id WHERE organization_users.user_id = auth.user_id() AND roles.key IN ('admin'))",
    );
  });

  it("compiles row conditions, claims, membership kinds and fields", () => {
    const sql = queries("job").join("\n");
    expect(sql).toContain(
      "AND jobs.assignee_id = auth.user_id() AND jobs.status IN ('open', 'done') AND jobs.priority >= 2 AND jobs.closed_at IS NULL",
    );
    expect(sql).toContain(
      "jobs.team_id IN (SELECT value FROM json_each(auth.parameter('team_ids')))",
    );
    expect(sql).toContain("jobs.region = auth.parameter('region')");
    expect(sql).toContain("organization_users.kind IN ('contract')");
    expect(sql).toContain("SELECT jobs.id, jobs.title FROM jobs");
  });

  it("compiles a resource role through the parent field and a schema-qualified table", () => {
    expect(queries("file")).toStrictEqual([
      'SELECT * FROM "app"."files" AS files WHERE files.folder_id IN (SELECT folder_members.folder_id FROM folder_members WHERE folder_members.user_id = auth.user_id() AND folder_members.role IN (\'editor\'))',
    ]);
    expect(queries("folder")).toStrictEqual([
      "SELECT * FROM folder WHERE folder.id IN (SELECT folder_members.folder_id FROM folder_members WHERE folder_members.user_id = auth.user_id() AND folder_members.role IN ('editor'))",
    ]);
  });

  it("keeps only the authenticated grants whose conditions compile", () => {
    expect(queries("note")).toStrictEqual([
      "SELECT * FROM note WHERE note.author_id = auth.user_id() AND note.kind != 'draft' AND note.deleted IS NULL",
      "SELECT * FROM note",
    ]);
  });

  it("omits a resource with a deny, with break-glass only, or with nothing that compiles", () => {
    const plan = powersyncPlan(policy, config);
    expect(plan.omitted).toStrictEqual(
      expect.arrayContaining([
        {
          resource: "secret",
          reason:
            "secret.read has a deny grant, which Sync Streams cannot subtract",
        },
        { resource: "audit", reason: "no grant of audit.read compiles" },
      ]),
    );
    expect(plan.warnings).toStrictEqual(
      expect.arrayContaining([
        "ops/job.read does not sync: global role ops is not a row filter",
        "authenticated/note.read does not sync: time-bounded",
        "authenticated/note.read does not sync: needs approval",
        "authenticated/note.read does not sync: its condition has no Sync Streams form",
        "authenticated/audit.read does not sync: break-glass",
      ]),
    );
    const yaml = powersyncYaml(plan);
    expect(yaml).toContain(
      "config:\n  edition: 3\n\nstreams:\n  job:\n    auto_subscribe: true\n    queries:\n",
    );
    expect(yaml).toContain(
      "# secret: not synced, secret.read has a deny grant",
    );
  });

  it("names the missing pieces when the memberships cannot express a role", () => {
    const bare: PermDockConfig = { policy: "p.ts" };
    const plan = powersyncPlan(policy, {
      ...bare,
      powersync: { resources: ["job", "file", "ghost"] },
    });
    expect(plan.streams).toStrictEqual([]);
    expect(plan.omitted).toStrictEqual([
      { resource: "job", reason: "no grant of job.read compiles" },
      { resource: "file", reason: "no grant of file.read compiles" },
      { resource: "ghost", reason: "no grant of ghost.read" },
    ]);
    expect(plan.warnings).toContain(
      "admin/job.read does not sync: no rls.memberships table without an expiry or disabledAt and with the kinds of admin, and no membership source, for scope organization",
    );
    expect(plan.warnings).toContain(
      "editor/file.read does not sync: no rls.memberships.resource table for folder on the row",
    );
    expect(powersyncYaml(plan)).toContain("streams: {}");
  });

  it("applies a constant via instead of a kind filter", () => {
    const withVia = (value: string): PermDockConfig => ({
      ...config,
      rls: {
        ...config.rls,
        memberships: {
          scopes: {
            organization: {
              table: "organization_users",
              user: "user_id",
              role: "role",
              via: { value },
              columns: { organization: "organization_id" },
            },
          },
        },
      },
    });
    const contract = queries("job", withVia("contract"));
    expect(contract).toContain(
      "SELECT * FROM jobs WHERE jobs.org_id IN (SELECT organization_users.organization_id FROM organization_users WHERE organization_users.user_id = auth.user_id() AND organization_users.role IN ('contractor'))",
    );
    expect(contract.some((query) => query.includes(".kind IN"))).toBe(false);
    expect(
      queries("job", withVia("staff")).some((query) =>
        query.includes("IN ('contractor')"),
      ),
    ).toBe(false);
  });

  it("leaves out memberships with an expiry and kinds without a via column", () => {
    const expiring = powersyncPlan(policy, {
      ...config,
      rls: {
        ...config.rls,
        memberships: {
          scopes: {
            organization: {
              table: "organization_users",
              user: "user_id",
              role: "role",
              columns: { organization: "organization_id" },
            },
          },
          resource: {
            folder: {
              table: "folder_members",
              user: "user_id",
              role: "role",
              id: "folder_id",
              expiresAt: "expires_at",
            },
          },
        },
      },
    });
    expect(expiring.warnings).toContain(
      "contractor/job.read does not sync: no rls.memberships table without an expiry or disabledAt and with the kinds of contractor, and no membership source, for scope organization",
    );
    expect(expiring.warnings).toContain(
      "editor/folder.read does not sync: the folder memberships table has an expiry or disabledAt, or lacks via",
    );
  });

  it("leaves out memberships that can be suspended", () => {
    const suspendable = powersyncPlan(policy, {
      ...config,
      rls: {
        ...config.rls,
        memberships: {
          resource: {
            folder: {
              table: "folder_members",
              user: "user_id",
              role: "role",
              id: "folder_id",
              disabledAt: "disabled_at",
            },
          },
        },
      },
    });
    expect(suspendable.warnings).toContain(
      "editor/folder.read does not sync: the folder memberships table has an expiry or disabledAt, or lacks via",
    );
  });

  it("writes the Postgres form verify runs", () => {
    const [first] =
      powersyncPlan(policy, config, POSTGRES).streams.find(
        (stream) => stream.name === "note",
      )?.queries ?? [];
    expect(first).toBe(
      "SELECT * FROM note WHERE note.author_id::text = $1::text AND note.kind::text != 'draft' AND note.deleted::text IS NULL",
    );
    expect(POSTGRES.claim("region")).toBe("($2::jsonb ->> 'region')");
    expect(POSTGRES.literal(3)).toBe("3");
    expect(POWERSYNC.literal(true)).toBe("true");
    expect(() => POWERSYNC.column("t", "bad name")).toThrow(
      "'bad name' is not a plain identifier",
    );
  });

  it("drops every condition shape Sync Streams cannot express", () => {
    const shapes: readonly Condition[] = [
      { op: "eq", field: "at", value: { date: "2030-01-01T00:00:00Z" } },
      { op: "eq", field: "owner", value: { ref: "principal.tenant" } },
      { op: "gt", field: "rank", value: null },
      { op: "isNull", field: "bad name", value: true },
      { op: "in", field: "bad name", value: ["a"] },
      { op: "in", field: "kind", value: ["a", null] },
      { op: "in", field: "kind", value: [{ ref: "principal.id" }] },
      { op: "in", field: "kind", value: { ref: "principal.tenant" } },
      { op: "eq", field: "bad name", value: "a" },
      {
        op: "and",
        conditions: [
          { op: "eq", field: "a", value: 1 },
          { op: "contains", field: "tags", value: "a" },
        ],
      },
      {
        op: "or",
        conditions: [
          { op: "eq", field: "a", value: 1 },
          { op: "contains", field: "tags", value: "a" },
        ],
      },
      {
        op: "memberOf",
        scope: "resource",
        resource: "folder",
        field: "id",
        roles: ["editor"],
      },
      { op: "memberOf", scope: "ghost", field: "org_id", roles: ["admin"] },
      {
        op: "memberOf",
        scope: "organization",
        field: "bad name",
        roles: ["admin"],
      },
    ];
    const odd = definePolicy(permissions, {
      scopes: { organization: { key: "org_id" } },
      // SAFETY: stream generation never calls the subject mapper.
      subject: (user: unknown) => user as never,
      roles: [
        role("closer", [allow(job.read, () => true)], { on: "organization" }),
      ],
      grants: [
        ...shapes.map((where) =>
          allow(note.read, { to: authenticated(), where }),
        ),
        allow(note.read, {
          to: authenticated(),
          where: { region: { ref: "context.region" } },
        }),
      ],
    });
    const plan = powersyncPlan(odd, config);
    expect(plan.omitted).toStrictEqual([
      { resource: "job", reason: "no grant of job.read compiles" },
      { resource: "note", reason: "no grant of note.read compiles" },
    ]);
    expect(plan.warnings).toContain(
      "closer/job.read does not sync: not portable",
    );
    expect(plan.warnings).toContain(
      "authenticated/note.read does not sync: reads context.region",
    );
  });

  it("compiles the remaining condition and grantee shapes", () => {
    const more = definePolicy(permissions, {
      scopes: { organization: { key: "org_id" } },
      // SAFETY: stream generation never calls the subject mapper.
      subject: (user: unknown) => user as never,
      roles: [
        role("editor", [allow([note.read, folder.read])], { on: folder }),
      ],
      grants: [
        allow(note.read, {
          to: anyone(),
          where: {
            op: "and",
            conditions: [
              { op: "ne", field: "rank", value: null },
              { op: "isNull", field: "gone", value: false },
              { op: "notIn", field: "kind", value: ["a"] },
              { op: "notIn", field: "kind", value: [] },
              {
                op: "memberOf",
                scope: "organization",
                field: "org_id",
                roles: ["admin"],
              },
            ],
          },
        }),
        allow(note.read, {
          to: authenticated(),
          where: { op: "in", field: "kind", value: [] },
        }),
      ],
    });
    const plan = powersyncPlan(more, {
      ...config,
      rls: {
        ...config.rls,
        memberships: {
          ...config.rls?.memberships,
          resource: {
            folder: { table: "folder_members", user: "user_id", role: "role" },
          },
        },
      },
    });
    expect(
      plan.streams.find((stream) => stream.name === "note")?.queries,
    ).toStrictEqual([
      expect.stringContaining(
        "WHERE note.rank IS NOT NULL AND note.gone IS NOT NULL AND note.kind NOT IN ('a') AND note.org_id IN (SELECT organization_users.organization_id",
      ),
      expect.stringContaining("organization_users.role_id"),
    ]);
    expect(
      plan.streams.find((stream) => stream.name === "folder")?.queries,
    ).toStrictEqual([
      "SELECT * FROM folder WHERE folder.id IN (SELECT folder_members.id FROM folder_members WHERE folder_members.user_id = auth.user_id() AND folder_members.role IN ('editor'))",
    ]);
    expect(plan.warnings).toStrictEqual(
      expect.arrayContaining([
        "editor/note.read does not sync: no rls.memberships.resource table for folder on the row",
      ]),
    );
  });

  it("streams only global custom roles without a tenant table", () => {
    const plan = powersyncPlan(policy, {
      policy: "p.ts",
      rls: { authorize: "database", customRoles: true },
    });
    expect(
      plan.subject.find(
        (stream) => stream.name === "permdock_custom_role_permissions",
      )?.queries,
    ).toStrictEqual([
      'SELECT * FROM "permdock"."custom_role_permissions" AS custom_role_permissions WHERE custom_role_permissions.tenant_id IS NULL',
    ]);
  });

  it("caps a stream at 32 queries", () => {
    const wide = definePolicy(permissions, {
      scopes: { organization: { key: "org_id" } },
      // SAFETY: stream generation never calls the subject mapper.
      subject: (user: unknown) => user as never,
      grants: [
        allow(note.read, {
          to: authenticated(),
          where: {
            and: Array.from({ length: 6 }, (_, index) => ({
              or: [{ [`a${String(index)}`]: 1 }, { [`b${String(index)}`]: 2 }],
            })),
          },
        }),
      ],
    });
    expect(powersyncPlan(wide, { policy: "p.ts" }).omitted).toStrictEqual([
      { resource: "note", reason: "64 queries, over the limit of 32" },
    ]);
  });
});
