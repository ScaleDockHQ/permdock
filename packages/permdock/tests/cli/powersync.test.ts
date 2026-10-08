import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { SqlClient } from "../../src/cli/pg.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";
import type { Condition } from "../../src/index.ts";

import { pd058 } from "../../src/cli/doctor-powersync.ts";
import {
  POSTGRES,
  POWERSYNC,
  powersyncPlan,
  powersyncYaml,
} from "../../src/cli/powersync-streams.ts";
import { runPowerSync } from "../../src/cli/powersync.ts";
import { run } from "../../src/cli/run.ts";
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

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "../../tmp");

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

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function queries(name: string, target = config): readonly string[] {
  return (
    powersyncPlan(policy, target).streams.find((stream) => stream.name === name)
      ?.queries ?? []
  );
}

describe("powersync streams", () => {
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
    expect(queries("file")).toEqual([
      "SELECT * FROM app.files WHERE app.files.folder_id IN (SELECT folder_members.folder_id FROM folder_members WHERE folder_members.user_id = auth.user_id() AND folder_members.role IN ('editor'))",
    ]);
    expect(queries("folder")).toEqual([
      "SELECT * FROM folder WHERE folder.id IN (SELECT folder_members.folder_id FROM folder_members WHERE folder_members.user_id = auth.user_id() AND folder_members.role IN ('editor'))",
    ]);
  });

  it("keeps only the authenticated grants whose conditions compile", () => {
    expect(queries("note")).toEqual([
      "SELECT * FROM note WHERE note.author_id = auth.user_id() AND note.kind != 'draft' AND note.deleted IS NULL",
      "SELECT * FROM note",
    ]);
  });

  it("omits a resource with a deny, with break-glass only, or with nothing that compiles", () => {
    const plan = powersyncPlan(policy, config);
    expect(plan.omitted).toEqual(
      expect.arrayContaining([
        {
          resource: "secret",
          reason:
            "secret.read has a deny grant, which Sync Streams cannot subtract",
        },
        { resource: "audit", reason: "no grant of audit.read compiles" },
      ]),
    );
    expect(plan.warnings).toEqual(
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
    expect(plan.streams).toEqual([]);
    expect(plan.omitted).toEqual([
      { resource: "job", reason: "no grant of job.read compiles" },
      { resource: "file", reason: "no grant of file.read compiles" },
      { resource: "ghost", reason: "no grant of ghost.read" },
    ]);
    expect(plan.warnings).toContain(
      "admin/job.read does not sync: no rls.memberships table without an expiry or disabledAt and with the kinds of admin for scope organization",
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
      "contractor/job.read does not sync: no rls.memberships table without an expiry or disabledAt and with the kinds of contractor for scope organization",
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
    expect(plan.omitted).toEqual([
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
    ).toEqual([
      expect.stringContaining(
        "WHERE note.rank IS NOT NULL AND note.gone IS NOT NULL AND note.kind NOT IN ('a') AND note.org_id IN (SELECT organization_users.organization_id",
      ),
      expect.stringContaining("organization_users.role_id"),
    ]);
    expect(
      plan.streams.find((stream) => stream.name === "folder")?.queries,
    ).toEqual([
      "SELECT * FROM folder WHERE folder.id IN (SELECT folder_members.id FROM folder_members WHERE folder_members.user_id = auth.user_id() AND folder_members.role IN ('editor'))",
    ]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        "editor/note.read does not sync: no rls.memberships.resource table for folder on the row",
      ]),
    );
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
    expect(powersyncPlan(wide, { policy: "p.ts" }).omitted).toEqual([
      { resource: "note", reason: "64 queries, over the limit of 32" },
    ]);
  });
});

function project(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "powersync-"));
  temps.push(dir);
  writeFileSync(
    join(dir, "policy.ts"),
    `import { allow, authenticated, definePermissions, definePolicy, principal, resource } from '${join(HERE, "../../src/index.ts")}';

export const permissions = definePermissions({
  note: resource({ id: 'id', actions: ['read'] }),
});

export const policy = definePolicy(permissions, {
  scopes: { organization: { key: 'org_id' } },
  subject: () => null,
  grants: [allow(permissions.note.read, { to: authenticated(), where: { author_id: principal.id } })],
});
`,
  );
  writeFileSync(
    join(dir, "rls.fixtures.json"),
    JSON.stringify([
      {
        subject: { id: "u1" },
        action: "note.read",
        row: { id: "n1", author_id: "u1", org_id: "o1" },
      },
      {
        subject: { id: "u2" },
        action: "note.read",
        row: { id: "n1", author_id: "u1" },
      },
      { subject: { id: "u1" }, action: "note.read", row: { author_id: "u1" } },
      { subject: { id: "u1" }, action: "ghost.read", row: { id: "n1" } },
    ]),
  );
  return dir;
}

const projectConfig: PermDockConfig = { policy: "policy.ts", powersync: {} };

function fakeDb(
  synced: (values: readonly unknown[]) => boolean,
): (db: string) => Promise<SqlClient> {
  return async () => ({
    query: async (_sql, values) => ({
      rows: synced(values) ? [{ "?column?": 1 }] : [],
    }),
    end: async () => undefined,
  });
}

describe("permdock powersync", () => {
  it("generates, checks and verifies the file", async () => {
    const cwd = project();
    const base = { cwd, config: projectConfig, check: false };
    expect(
      await runPowerSync({ ...base, rest: ["generate"], check: true }),
    ).toEqual({
      code: 1,
      output: "sync-config.yaml is stale: run permdock powersync generate",
    });
    expect(
      (await runPowerSync({ ...base, rest: ["verify"] })).output,
    ).toContain("sync-config.yaml is missing");
    expect(await pd058({ cwd, config: projectConfig })).toMatchObject([
      { code: "PD058", message: expect.stringContaining("is missing") },
    ]);
    expect((await runPowerSync({ ...base, rest: ["generate"] })).output).toBe(
      "wrote sync-config.yaml",
    );
    expect(readFileSync(join(cwd, "sync-config.yaml"), "utf8")).toContain(
      "SELECT * FROM note WHERE note.author_id = auth.user_id()",
    );
    expect(
      await runPowerSync({ ...base, rest: ["generate"], check: true }),
    ).toEqual({
      code: 0,
      output: "sync-config.yaml is current",
    });
    expect(await runPowerSync({ ...base, rest: ["verify"] })).toEqual({
      code: 0,
      output: "sync-config.yaml matches the policy",
    });
    expect(await pd058({ cwd, config: projectConfig })).toEqual([]);
    writeFileSync(join(cwd, "sync-config.yaml"), "streams: {}\n");
    expect(await pd058({ cwd, config: projectConfig })).toMatchObject([
      { message: expect.stringContaining("older policy") },
    ]);
  });

  it("fails verify when a stream syncs a row the policy denies", async () => {
    const cwd = project();
    const base = { cwd, config: projectConfig, check: false };
    await runPowerSync({ ...base, rest: ["generate"] });
    const exact = await runPowerSync({
      ...base,
      rest: ["verify"],
      db: "postgres://test",
      connect: fakeDb((values) => values[0] === "u1"),
    });
    expect(exact.code).toBe(0);
    expect(exact.output).toBe(
      "sync-config.yaml matches the policy; no stream syncs a row the fixtures deny\nnote.read for u1: granted, not synced (the app reads it from the server)",
    );
    const over = await runPowerSync({
      ...base,
      rest: ["verify"],
      db: "postgres://test",
      connect: fakeDb(() => true),
    });
    expect(over.code).toBe(1);
    expect(over.output).toContain(
      "note.read for u2: stream note syncs a row the policy denies",
    );
    const under = await runPowerSync({
      ...base,
      rest: ["verify"],
      db: "postgres://test",
      connect: fakeDb(() => false),
    });
    expect(under.output).toContain("note.read for u1: granted, not synced");
    const missing = await runPowerSync({
      ...base,
      rest: ["verify"],
      db: "postgres://test",
      fixtures: "missing.json",
    });
    expect(missing).toMatchObject({ code: 2 });
    await expect(
      runPowerSync({
        ...base,
        rest: ["verify"],
        db: "postgres://permdock@127.0.0.1:1/none",
      }),
    ).rejects.toThrow("powersync verify --db could not connect");
    writeFileSync(join(cwd, "sync-config.yaml"), "streams: {}\n");
    expect((await runPowerSync({ ...base, rest: ["verify"] })).output).toBe(
      "sync-config.yaml differs from the policy: run permdock powersync generate",
    );
  });

  it("prints usage for an unknown verb or a missing policy", async () => {
    const cwd = project();
    expect(
      (
        await runPowerSync({
          cwd,
          config: projectConfig,
          check: false,
          rest: [],
        })
      ).code,
    ).toBe(2);
    expect(
      await runPowerSync({ cwd, config: {}, check: false, rest: ["generate"] }),
    ).toEqual({
      code: 2,
      output: "PermDock CLI: powersync needs policy in the config or --from",
    });
    expect(await pd058({ cwd, config: { powersync: {} } })).toEqual([]);
    const broken: PermDockConfig = {
      ...projectConfig,
      rls: { tables: { note: "bad name" } },
    };
    expect(await pd058({ cwd, config: broken })).toEqual([]);
    expect(
      await runPowerSync({
        cwd,
        config: broken,
        check: false,
        rest: ["generate"],
      }),
    ).toEqual({
      code: 2,
      output:
        "PermDock CLI: 'bad name' is not a plain identifier, which Sync Streams need",
    });
    expect(
      await pd058({ cwd, config: { policy: "missing.ts", powersync: {} } }),
    ).toEqual([]);
  });

  it("runs from the CLI", async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      "export default { policy: './policy.ts', powersync: { out: 'streams.yaml' } };\n",
    );
    const generated = await run(["powersync", "generate"], { cwd });
    expect(generated.stdout).toContain("wrote streams.yaml");
    const checked = await run(
      ["powersync", "verify", "--from", "./policy.ts"],
      { cwd },
    );
    expect(checked.code).toBe(0);
    const flagged = await run(
      [
        "powersync",
        "verify",
        "--out",
        "streams.yaml",
        "--fixtures",
        "rls.fixtures.json",
        "--db",
        "postgres://permdock@127.0.0.1:1/none",
      ],
      { cwd },
    );
    expect(flagged).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("could not connect"),
    });
  });
});
