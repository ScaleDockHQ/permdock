import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { run } from "../../../src/cli/core/run.ts";
import { isRecord } from "../../../src/core/compact.ts";
import { project, removeProjects } from "../doctor-kit.ts";

const POLICY = `import { allow, defineOperations, definePermissions, definePolicy, defineRoles, resource, role } from 'permdock';
import { z } from 'zod';

const id = z.uuid();
const org = { org: { field: 'organizationId', memberOf: 'organization' } };
export const permissions = definePermissions({
  project: resource(z.object({
    id,
    organizationId: id,
    name: z.string().min(2).max(40),
    status: z.enum(['active', 'archived']),
    priority: z.enum(['low', 'high']).nullable(),
    budget: z.number().int().min(0).nullable(),
    ownerEmail: z.email().optional(),
    createdAt: z.iso.datetime({ offset: true }),
  }), { actions: ['read', 'update'], collection: ['list'], relations: org }),
  'task-item': resource(z.object({ id, projectId: id, organizationId: id, title: z.string(), done: z.boolean(), tags: z.array(z.string()) }), {
    actions: ['read'],
    parent: { field: 'projectId', resource: 'project' },
    relations: org,
  }),
});
const roles = defineRoles({ admin: { on: 'organization', assignable: true }, member: { on: 'organization', assignable: true } });

export const policy = definePolicy({ permissions, roles }, {
  scopes: { organization: { key: 'organizationId' } },
  roles: [
    role(roles.admin, [allow(permissions.project.update)]),
    role(roles.member, [allow(permissions.project.read), allow(permissions.project.list), allow(permissions['task-item'].read)]),
  ],
  subject: () => null,
});

export const operations = defineOperations(permissions, {
  listProjects: { permission: permissions.project.list, results: permissions.project.read },
});
`;

const CONFIG = `export default {
  policy: './policy.ts',
  operations: './policy.ts',
  gen: { fieldMeta: true },
  rls: {
    tenantClaim: 'organization_id',
    tables: { project: 'public.projects', 'task-item': 'public.task_items' },
    realtime: { topics: { 'org:{organization}:projects': { read: 'project.read' } } },
    storage: { buckets: { avatars: { scope: 'organization', folder: 2, read: 'project.read' } } },
  },
};
`;

const KINDS = [
  "constants",
  "zod",
  "valibot",
  "arktype",
  "json-schema",
  "standard-schema",
  "factories",
  "react",
  "vue",
  "svelte",
  "solid",
  "messages",
] as const;

const FILES = {
  constants: "permdock.generated.ts",
  zod: "permdock.zod.ts",
  valibot: "permdock.valibot.ts",
  arktype: "permdock.arktype.ts",
  "json-schema": "permdock.schemas.json",
  "standard-schema": "permdock.schemas.ts",
  factories: "permdock.factories.ts",
  react: "permdock.react.ts",
  vue: "permdock.vue.ts",
  svelte: "permdock.svelte-stores.ts",
  solid: "permdock.solid.ts",
  messages: "permdock.messages.json",
} as const;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const CATALOG = path.join(import.meta.dirname, "../../../src/catalog/index.ts");

function fixture(config = CONFIG): string {
  return project({ "policy.ts": POLICY, "permdock.config.ts": config });
}

async function generate(
  cwd: string,
  args: readonly string[],
): Promise<Awaited<ReturnType<typeof run>>> {
  return run(["gen", ...args, "--cwd", cwd]);
}

/** Loads a generated module the way an app would. */
async function load(file: string): Promise<Readonly<Record<string, unknown>>> {
  // Lazy: the module is the generator's output, written during the test.
  const module: unknown = await import(pathToFileURL(file).href);
  return isRecord(module) ? module : {};
}

function call(value: unknown, ...args: readonly unknown[]): unknown {
  if (typeof value !== "function") {
    throw new TypeError("not a function");
  }
  const result: unknown = value(...args);
  return result;
}

function row(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

/**
 * Whether a Standard Schema (Zod, Valibot, `resourceSchemaFromJson`) accepts
 * `value`.
 */
function accepts(schema: unknown, value: unknown): boolean {
  const standard = isRecord(schema) ? schema["~standard"] : undefined;
  const result = call(
    isRecord(standard) ? standard["validate"] : undefined,
    value,
  );
  return isRecord(result) && result["issues"] === undefined;
}

describe("permdock gen", () => {
  afterAll(removeProjects);
  const cwd = fixture();

  for (const kind of KINDS) {
    it(`writes the ${kind} kind`, async () => {
      const outcome = await generate(cwd, ["--kind", kind, "--out", "-"]);
      expect(outcome.stderr).toBe("");
      expect(outcome.code).toBe(0);
      await expect(outcome.stdout).toMatchFileSnapshot(
        `../__snapshots__/gen/${FILES[kind]}.txt`,
      );
    });
  }

  it("writes every kind under --out-dir and reports them current", async () => {
    const dir = fixture();
    const kinds = KINDS.flatMap((kind) => ["--kind", kind]);
    const written = await generate(dir, [...kinds, "--out-dir", "gen"]);
    expect(written.code).toBe(0);
    for (const kind of KINDS) {
      expect(written.stdout).toContain(`gen/${FILES[kind]}`);
    }
    const check = await generate(dir, [
      ...kinds,
      "--out-dir",
      "gen",
      "--check",
    ]);
    expect(check.code).toBe(0);
    writeFileSync(path.join(dir, "gen", FILES.zod), "// stale\n");
    const stale = await generate(dir, [
      ...kinds,
      "--out-dir",
      "gen",
      "--check",
    ]);
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain("run permdock gen to refresh");
  });

  it("defaults to constants under src/generated, and gen.kinds overrides it", async () => {
    const dir = fixture();
    const dry = await generate(dir, ["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("src/generated/permdock.generated.ts");
    const configured = fixture(
      CONFIG.replace(
        "gen: { fieldMeta: true }",
        "gen: { out: 'lib', kinds: ['zod'] }",
      ),
    );
    const outcome = await generate(configured, []);
    expect(outcome.code).toBe(0);
    expect(
      readFileSync(path.join(configured, "lib", FILES.zod), "utf8"),
    ).not.toContain("projectFields");
  });

  it("reads the policy from --policy and runs without operations", async () => {
    const dir = project({
      "policy.ts": POLICY,
      "permdock.config.ts": "export default {};\n",
    });
    const outcome = await generate(dir, [
      "--policy",
      "./policy.ts",
      "--kind",
      "zod",
      "--out",
      "-",
    ]);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("export const projectRow");
    expect(outcome.stdout).not.toContain("listProjectsResult");
  });

  it("rejects --out for more than one kind and an unknown gen.kinds entry", async () => {
    const many = await generate(cwd, [
      "--kind",
      "zod",
      "--kind",
      "valibot",
      "--out",
      "x.ts",
    ]);
    expect(many.code).toBe(2);
    expect(many.stderr).toContain("--out-dir");
    const unknown = fixture(
      CONFIG.replace("gen: { fieldMeta: true }", "gen: { kinds: ['yup'] }"),
    );
    const outcome = await generate(unknown, []);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain("gen.kinds has 'yup'");
  });

  it("keeps translated messages and reports keys the file lacks", async () => {
    const dir = fixture();
    const args = ["--kind", "messages", "--out-dir", "gen"];
    expect((await generate(dir, args)).code).toBe(0);
    const file = path.join(dir, "gen", FILES.messages);
    const written: unknown = JSON.parse(readFileSync(file, "utf8"));
    const messages = row(written);
    expect(row(messages["reasons"])["no-grant"]).toBe("No role grants this");
    expect(row(messages["permissions"])["project.read"]).toBe("project.read");
    expect(row(messages["roles"])["admin"]).toBe("admin");
    const reasons = Object.fromEntries(
      Object.entries({
        ...row(messages["reasons"]),
        "no-grant": "Geen rol",
      }).filter(([reason]) => reason !== "deny"),
    );
    writeFileSync(
      file,
      JSON.stringify({ ...messages, reasons, extra: { stale: "x" } }),
    );
    const check = await generate(dir, [...args, "--check"]);
    expect(check.code).toBe(1);
    expect((await generate(dir, args)).code).toBe(0);
    const merged: unknown = JSON.parse(readFileSync(file, "utf8"));
    expect(row(row(merged)["reasons"])).toMatchObject({
      "no-grant": "Geen rol",
      deny: "A deny rule applies",
    });
    expect(row(merged)["extra"]).toBeUndefined();
    expect((await generate(dir, [...args, "--check"])).code).toBe(0);
    writeFileSync(file, "{ not json");
    const broken = await generate(dir, args);
    expect(broken.code).not.toBe(0);
    expect(broken.stderr).toContain("is not valid JSON");
  });

  it("imports the policy by type, relative to the hook file", async () => {
    const dir = fixture();
    const outcome = await generate(dir, [
      "--kind",
      "react",
      "--out",
      "app/lib/permdock.ts",
      "--dry-run",
    ]);
    expect(outcome.code).toBe(0);
    const nested = await generate(dir, ["--kind", "vue", "--out", "-"]);
    expect(nested.stdout).toContain(
      'import type * as source from "../../policy.js";',
    );
    const written = await generate(dir, [
      "--kind",
      "solid",
      "--out",
      "lib/permdock.solid.ts",
    ]);
    expect(written.code).toBe(0);
    expect(
      readFileSync(path.join(dir, "lib", "permdock.solid.ts"), "utf8"),
    ).toContain('import type * as source from "../policy.js";');
  });

  describe("generated modules", () => {
    const dir = fixture();
    const file = (kind: keyof typeof FILES): string =>
      path.join(dir, "out", FILES[kind]);
    beforeAll(async () => {
      const kinds = [
        "constants",
        "zod",
        "valibot",
        "standard-schema",
        "factories",
      ];
      const outcome = await generate(dir, [
        ...kinds.flatMap((kind) => ["--kind", kind]),
        "--out-dir",
        "out",
      ]);
      if (outcome.code !== 0) {
        throw new Error(outcome.stderr);
      }
      const standard = file("standard-schema");
      writeFileSync(
        standard,
        readFileSync(standard, "utf8").replace(
          '"permdock/catalog"',
          JSON.stringify(CATALOG),
        ),
      );
    });

    it("builds topics, paths and qualified SQL names", async () => {
      const { topics, paths, sqlNames, scopes, roles } = await load(
        file("constants"),
      );
      expect(call(row(topics)["orgProjects"], { organization: "o1" })).toBe(
        "org:o1:projects",
      );
      expect(
        call(row(paths)["avatars"], {
          segment1: "users",
          organization: "o1",
          name: "me.png",
        }),
      ).toBe("users/o1/me.png");
      expect(sqlNames).toMatchObject({
        scopes: {
          organization: { memberIds: "permdock.member_organization_ids" },
        },
      });
      expect(scopes).toStrictEqual(["organization"]);
      expect(roles).toStrictEqual(["admin", "member"]);
    });

    it("factories fill rows every validator kind accepts", async () => {
      const { factories, resetFactories } = await load(file("factories"));
      const kinds = await Promise.all(
        (["zod", "valibot", "standard-schema"] as const).map(async (kind) =>
          load(file(kind)),
        ),
      );
      call(resetFactories);
      const created = row(call(row(factories)["project"]));
      const task = row(
        call(
          row(factories)["taskItem"],
          { done: true },
          { parent: created, organization: ORG },
        ),
      );
      expect(task["projectId"]).toBe(created["id"]);
      expect(task["organizationId"]).toBe(ORG);
      expect(task["done"]).toBe(true);
      const invalid = { ...created, name: "x", priority: "urgent" };
      for (const schemas of kinds) {
        expect(accepts(schemas["projectRow"], created)).toBe(true);
        expect(accepts(schemas["taskItemRow"], task)).toBe(true);
        expect(accepts(schemas["projectRow"], invalid)).toBe(false);
        expect(accepts(schemas["listProjectsResult"], [created])).toBe(true);
      }
      call(resetFactories);
      expect(row(call(row(factories)["project"]))["id"]).toBe(created["id"]);
    });
  });
});
