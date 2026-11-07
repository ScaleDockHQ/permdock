import type { StandardSchemaV1 } from "@standard-schema/spec";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DoctorFiles } from "../../src/cli/shared/doctor-types.ts";
import type { PermDockConfig, RlsConfig } from "../../src/cli/types.ts";
import type { Policy } from "../../src/core/policy-types.ts";

import {
  pd020,
  pd030,
  pd071,
  pd072,
  pd073,
  pd075,
  pd086,
} from "../../src/cli/doctor/rls.ts";
import { pd095, pd096 } from "../../src/cli/doctor/schema-checks.ts";
import { pd097 } from "../../src/cli/doctor/seed-data.ts";
import { nodeFiles } from "../../src/cli/shared/doctor-files.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
  sqlFunction,
} from "../../src/index.ts";
import {
  junctionMembershipSource,
  tableMembershipSource,
} from "../../src/supabase/index.ts";

const dirs: string[] = [];

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-doctor-batch-"));
  dirs.push(cwd);
  return cwd;
}

function put(cwd: string, rel: string, text: string): void {
  const path = join(cwd, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function schemaReturning(output: unknown): StandardSchemaV1 {
  // SAFETY: a hand-built Standard Schema whose jsonSchema output is the shape under test.
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => ({}), output: () => output },
    },
  } as StandardSchemaV1;
}

function withPolicy(
  policy: Policy | undefined,
  rls: RlsConfig,
): {
  cwd: string;
  config: PermDockConfig;
  policy: () => Promise<Policy | undefined>;
} {
  return {
    cwd: ".",
    config: { policy: "policy.ts", rls },
    policy: () => Promise.resolve(policy),
  };
}

const twin = { scope: "public" };

function setFn(column: string, withField: boolean) {
  return sqlFunction("job_permitted", {
    args: withField ? ["read", { field: "id" }] : ["read"],
    set: { column },
    twin,
  });
}

describe("PD020 hostable", () => {
  const permissions = definePermissions({
    note: resource({ actions: ["read"] }),
    post: resource({ actions: ["read"] }),
  });
  const hosted = definePolicy(permissions, {
    hostable: [permissions.post.read, permissions.note.read],
    roles: [],
    subject: () => null,
  });

  it("keeps a hostable key whose table is compiled and drops one whose table is not", async () => {
    const mixed = await pd020(
      withPolicy(hosted, { tables: { post: "posts" } }),
    );
    expect(mixed.map((finding) => finding.message)).toStrictEqual([
      "hostable permissions are also compiled into RLS, which never sees hosted grants: post.read",
    ]);
    const every = await pd020(withPolicy(hosted, {}));
    expect(every.map((finding) => finding.message)).toStrictEqual([
      "hostable permissions are also compiled into RLS, which never sees hosted grants: note.read, post.read",
    ]);
  });

  it("reports nothing when hostable is missing", async () => {
    // SAFETY: definePolicy always sets hostable; this is the nullish value the ?? [] branch reads.
    const missing = { ...hosted, hostable: undefined } as unknown as Policy;
    expect(
      await pd020(withPolicy(missing, { tables: { post: "posts" } })),
    ).toStrictEqual([]);
  });
});

describe("PD030 field-limited reads", () => {
  const keyedSchema = schemaReturning({
    properties: { pk: {}, id: {}, secret: {} },
  });
  const deniedSchema = schemaReturning({
    properties: { id: {}, title: {}, secret: {} },
  });
  const plainSchema = schemaReturning({ properties: { id: {}, secret: {} } });
  const hiddenSchema = schemaReturning({
    properties: { id: {}, title: {}, secret: {}, hidden: {} },
  });

  const permissions = definePermissions({
    blank: resource(schemaReturning({ properties: null }), {
      actions: ["read"],
    }),
    denied: resource(deniedSchema, { id: "id", actions: ["read"] }),
    keyed: resource(keyedSchema, { id: "pk", actions: ["read"] }),
    loose: resource(schemaReturning(1), { actions: ["read"] }),
    plain: resource(plainSchema, { actions: ["read"] }),
    raw: resource({ actions: ["read"] }),
  });

  const policy = definePolicy(permissions, {
    roles: [
      role("member", [
        allow(permissions.blank.read, { fields: ["title"] }),
        deny(permissions.blank.read, { fields: ["secret"] }),
        allow(permissions.denied.read, { fields: ["id", "title", "secret"] }),
        deny(permissions.denied.read, { fields: ["secret"] }),
        allow(permissions.keyed.read, { fields: ["pk"] }),
        allow(permissions.loose.read, { fields: ["id", "title"] }),
        deny(permissions.loose.read, { fields: ["secret"] }),
        allow(permissions.plain.read, { fields: ["secret"] }),
        allow(permissions.raw.read, { fields: ["title"] }),
        deny(permissions.raw.read, { fields: ["secret"] }),
      ]),
    ],
    subject: () => null,
  });

  function rowLevel(name: string, columns: string): string {
    return `read grants on ${name} limit ${columns}, but RLS on ${name} is row-level: any client that reads ${name} directly gets those columns`;
  }

  it("limits a denied column, an allow that omits a column, and a resource whose id is unset", async () => {
    const findings = await pd030(withPolicy(policy, {}));
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      rowLevel("blank", "secret"),
      rowLevel("denied", "secret"),
      rowLevel("keyed", "id, secret"),
      rowLevel("loose", "secret"),
      rowLevel("raw", "secret"),
    ]);
  });

  it("uses grant fields when the resource node is gone and the schema when it is present", async () => {
    const hidden = definePermissions({
      post: resource(hiddenSchema, { id: "id", actions: ["read"] }),
    });
    const present = definePolicy(hidden, {
      roles: [
        role("member", [
          allow(hidden.post.read, { fields: ["id", "title"] }),
          deny(hidden.post.read, { fields: ["secret"] }),
        ]),
      ],
      subject: () => null,
    });
    const resources = new Map(present.resources);
    resources.delete("post");
    // SAFETY: the grant stays while the resource node is removed, which is node === undefined.
    const gone = { ...present, resources } as Policy;
    expect(
      (await pd030(withPolicy(present, {}))).map((finding) => finding.message),
    ).toStrictEqual([rowLevel("post", "secret, hidden")]);
    expect(
      (await pd030(withPolicy(gone, {}))).map((finding) => finding.message),
    ).toStrictEqual([rowLevel("post", "secret")]);
  });
});

describe("PD071 unmapped write verbs", () => {
  const permissions = definePermissions({
    invoice: resource({ actions: ["mark", "pause", "markPaid", "export"] }),
    order: resource({ actions: ["mark"] }),
  });
  const policy = definePolicy(permissions, { roles: [], subject: () => null });

  it("names mark and pause, which suggest a write and do not infer a command", async () => {
    const findings = await pd071(withPolicy(policy, { dialect: "supabase" }));
    expect(findings).toStrictEqual([
      {
        code: "PD071",
        severity: "warning",
        message:
          "action 'mark' (invoice.mark, order.mark) reads as a write but has no rls.actions entry, so it compiles to 'none' and adds no SQL policy",
        fix: 'map it on purpose in rls.actions: mark: "insert", "update", "delete" or "none"',
      },
      {
        code: "PD071",
        severity: "warning",
        message:
          "action 'pause' (invoice.pause) reads as a write but has no rls.actions entry, so it compiles to 'none' and adds no SQL policy",
        fix: 'map it on purpose in rls.actions: pause: "insert", "update", "delete" or "none"',
      },
    ]);
  });

  it("returns nothing when the policy does not load", async () => {
    expect(
      await pd071(withPolicy(undefined, { dialect: "supabase" })),
    ).toStrictEqual([]);
  });
});

describe("PD072 name guard directory", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const source = junctionMembershipSource({
    table: "organization_members",
    scope: "org",
    id: "organization_id",
    roles: { through: "app_roles", on: { role_id: "id" }, column: "name" },
  });
  const roles = { table: "app_roles", key: "name", tenant: "organization_id" };

  function config(out?: string): PermDockConfig {
    return {
      rls: {
        membershipSources: [source],
        customRoleWrites: { roles },
        ...(out === undefined ? {} : { out }),
      },
    };
  }

  it("stays quiet when rls.out holds the trigger and warns when that directory is unset", () => {
    const cwd = project();
    put(
      cwd,
      "generated/guard.sql",
      'create trigger "permdock_custom_role_name_guard" before insert on app_roles for each row execute function g();\n',
    );
    expect(pd072({ cwd, config: config("generated") })).toStrictEqual([]);
    expect(
      pd072({ cwd, config: config() }).map((finding) => finding.code),
    ).toStrictEqual(["PD072"]);
  });
});

describe("PD073 membership tables", () => {
  const permissions = definePermissions({
    doc: resource({
      actions: ["read"],
      relations: { org: { field: "orgId", memberOf: "org" } },
    }),
  });
  const policy = definePolicy(permissions, {
    scopes: { org: { key: "orgId" } },
    roles: [
      role("contact", [allow(permissions.doc.read)], {
        on: "org",
        for: ["contact"],
      }),
    ],
    subject: () => null,
  });
  const staff = junctionMembershipSource({
    table: "org_staff",
    scope: "org",
    roles: ["contact"],
    via: "staff",
  });

  function config(memberships: RlsConfig["memberships"]): PermDockConfig {
    return {
      policy: "policy.ts",
      rls: {
        dialect: "supabase",
        authorize: "database",
        membershipSources: [staff],
        ...(memberships === undefined ? {} : { memberships }),
      },
    };
  }

  it("reads a mapped membership table when one is set and the sources when it is not", async () => {
    const fromSource = await pd073({
      cwd: ".",
      config: config(undefined),
      policy: () => Promise.resolve(policy),
    });
    expect(fromSource.map((finding) => finding.message)).toStrictEqual([
      "role contact is for contact, but its membership sources hold org_staff (via staff): no membership can hold it",
    ]);
    const fromTable = await pd073({
      cwd: ".",
      config: config({
        scopes: {
          org: {
            table: "org_members",
            user: "user_id",
            role: "role",
            via: { value: "staff" },
            columns: { org: "org_id" },
          },
        },
      }),
      policy: () => Promise.resolve(policy),
    });
    expect(fromTable.map((finding) => finding.message)).toStrictEqual([
      "role contact is for contact, but its membership sources hold org_members (via staff): no membership can hold it",
    ]);
    const matched = await pd073({
      cwd: ".",
      config: config({
        scopes: {
          org: {
            table: "org_members",
            user: "user_id",
            role: "role",
            via: { value: "contact" },
            columns: { org: "org_id" },
          },
        },
      }),
      policy: () => Promise.resolve(policy),
    });
    expect(matched).toStrictEqual([]);
  });
});

describe("PD075 shared tables", () => {
  const permissions = definePermissions({
    chat: resource({ actions: ["read"] }),
    file: resource({ actions: ["read"] }),
    fileNode: resource({ actions: ["read"] }),
  });
  const policy = definePolicy(permissions, { roles: [], subject: () => null });

  it("ignores a string also child and still pairs a non-string child with the owner", async () => {
    // SAFETY: also is declared as strings; a non-string entry is the branch that is not shared.
    const also = ["fileNode", { name: "chat" }] as unknown as readonly string[];
    const findings = await pd075(
      withPolicy(policy, {
        dialect: "supabase",
        tables: {
          chat: "file_nodes",
          file: { table: "file_nodes", also },
          fileNode: "file_nodes",
        },
      }),
    );
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      "rls.tables maps chat and file to public.file_nodes, so the same rows carry two sets of keys and helpers",
    ]);
  });

  it("pairs nothing when rls.tables is unset", async () => {
    expect(
      await pd075(withPolicy(policy, { dialect: "supabase" })),
    ).toStrictEqual([]);
  });
});

describe("PD086 sqlFunction set columns", () => {
  const rowSchema = schemaReturning({ properties: { id: {}, title: {} } });
  const permissions = definePermissions({
    bare: resource({ actions: ["read"] }),
    num: resource(schemaReturning(1), { actions: ["read"] }),
    props: resource(schemaReturning({ properties: null }), {
      actions: ["read"],
    }),
    row: resource(rowSchema, { id: "id", actions: ["read"] }),
  });
  const policy = definePolicy(permissions, {
    roles: [
      role("member", [
        allow(permissions.bare.read, { where: setFn("nope", true) }),
        allow(permissions.num.read, { where: setFn("nope", true) }),
        allow(permissions.props.read, { where: setFn("nope", true) }),
        allow(permissions.row.read, {
          where: setFn("nope", true),
          check: setFn("id", false),
        }),
      ]),
    ],
    subject: () => null,
  });

  it("warns on a dropped row field and errors only when the schema lists columns", async () => {
    const findings = await pd086(withPolicy(policy, {}));
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      "sqlFunction job_permitted set passes row fields (id), which the set form drops: the function is called once per statement",
      "sqlFunction job_permitted set passes row fields (id), which the set form drops: the function is called once per statement",
      "sqlFunction job_permitted set passes row fields (id), which the set form drops: the function is called once per statement",
      "sqlFunction job_permitted set compares row.nope, which the resource does not declare",
      "sqlFunction job_permitted set passes row fields (id), which the set form drops: the function is called once per statement",
    ]);
  });

  it("returns nothing when the policy does not load", async () => {
    expect(await pd086(withPolicy(undefined, {}))).toStrictEqual([]);
  });
});

describe("PD095 live schema conditionals", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a trigger on a table and a grant of all", () => {
    const cwd = project();
    put(
      cwd,
      "supabase/schemas/permdock/helpers.sql",
      `-- generated by permdock
create view public.other as select 1 as id;
create trigger kept_t insert on public.notes execute function kept();
create table all (id int);
create table public.notes (id int);
`,
    );
    put(
      cwd,
      "supabase/schemas/permdock/bare-view.sql",
      `-- generated by permdock
create view notes as select 1 as id;
create trigger notes_t insert on public.notes execute function kept();
`,
    );
    put(
      cwd,
      "supabase/migrations/20260102000000_permdock_grants.sql",
      `-- permdock:extra v1
grant select on all;
grant usage on "" to authenticated;
grant select on table public.notes to authenticated;
`,
    );
    const findings = pd095(cwd, nodeFiles);
    const helpers = findings.find((finding) =>
      (finding.target ?? "").endsWith("helpers.sql"),
    );
    expect(helpers).toBeUndefined();
    const bare = findings.find((finding) =>
      (finding.target ?? "").endsWith("bare-view.sql"),
    );
    expect(bare?.message).toContain("a trigger on a view");
    const grants = findings.find((finding) =>
      (finding.target ?? "").endsWith("permdock_grants.sql"),
    );
    expect(grants?.message).toContain("public.notes, notes");
    expect(grants?.message).not.toContain("all");
  });
});

describe("PD096 user through", () => {
  it("reports no pair when userThrough and a role through are both recorded", () => {
    const config: PermDockConfig = {
      rls: {
        membershipSources: [
          tableMembershipSource({
            table: "memberships",
            columns: {
              user: {
                through: "profiles",
                on: { profile_id: "id" },
                column: "user_id",
              },
              role: { through: "roles", on: { role_id: "id" }, column: "key" },
            },
          }),
        ],
      },
    };
    expect(pd096(config)).toStrictEqual([]);
  });
});

describe("PD097 remaining defaults", () => {
  const permissions = definePermissions({
    note: resource({
      actions: ["read"],
      relations: { org: { field: "orgId", memberOf: "tenant" } },
    }),
  });
  const policy = definePolicy(permissions, {
    scopes: { tenant: { key: "orgId" } },
    roles: [role("reader", [allow(permissions.note.read)], { on: "tenant" })],
    subject: () => null,
  });
  const files: DoctorFiles = {
    exists: () => false,
    read: () => "",
    list: () => [],
    isDirectory: () => false,
  };

  it("accepts a known scope and still names an unknown scope and permission", async () => {
    const findings = await pd097({
      cwd: "/app",
      files,
      config: {
        seeds: {
          defaults: {
            roles: [
              { key: "reader", scope: "tenant", grants: ["note.read"] },
              {
                key: "reader",
                scope: "nowhere",
                grants: ["note.missing", "note.read"],
              },
            ],
          },
          fixtures: {
            users: {},
            tenants: {},
            memberships: [],
            customRoles: [],
            rows: {},
          },
        },
      },
      policy: () => Promise.resolve(policy),
    });
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      "default role 'reader' names unknown scope 'nowhere'",
      "default role 'reader' names unknown permission 'note.missing'",
    ]);
  });

  it("warns when config.toml exists and does not list the seed file", async () => {
    const tree: Readonly<Record<string, string>> = {
      "/app/supabase/seeds/permdock.sql": "-- fixtures\n",
      "/app/supabase/config.toml": "[db]\nmajor_version = 15\n",
    };
    const reader: DoctorFiles = {
      exists: (path) => Object.hasOwn(tree, path),
      read: (path) => tree[path] ?? "",
      list: () => [],
      isDirectory: () => false,
    };
    const findings = await pd097({ cwd: "/app", files: reader, config: {} });
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      "supabase/config.toml does not list supabase/seeds/permdock.sql. Add:\n[db.seed]\nsql_paths = ['./seeds/permdock.sql']",
    ]);
  });
});
