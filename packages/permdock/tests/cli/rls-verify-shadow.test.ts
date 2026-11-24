import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ShadowDelta,
  ShadowId,
  ShadowPgDelta,
} from "../../src/cli/rls/verify-shadow.ts";

import { verifyShadow } from "../../src/cli/rls/verify-shadow.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

function app(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "verify-shadow-"));
  temps.push(dir);
  mkdirSync(join(dir, "supabase/schemas"), { recursive: true });
  writeFileSync(
    join(dir, "supabase/schemas/app.sql"),
    "create table public.notes (id uuid primary key);\n",
  );
  writeFileSync(
    join(dir, "supabase/schemas/permdock.sql"),
    "create schema if not exists permdock;\n",
  );
  return dir;
}

const POLICY: ShadowId = {
  kind: "policy",
  schema: "public",
  table: "notes",
  name: "permdock_notes_select",
};
const HELPER: ShadowId = {
  kind: "function",
  schema: "permdock",
  name: "can",
  args: ["text"],
};

type Planned = {
  readonly files: readonly { readonly name: string; readonly sql: string }[];
  readonly options: Readonly<Record<string, unknown>>;
  readonly target: unknown;
  readonly shadow: unknown;
};

function fakeDelta(
  deltas: readonly ShadowDelta[],
  diagnostics: readonly {
    readonly code: string;
    readonly severity: "error" | "warning" | "info";
    readonly message: string;
  }[] = [],
): ShadowPgDelta & {
  readonly planned: Planned[];
  readonly provisioned: string[];
  readonly cleaned: string[];
} {
  const planned: Planned[] = [];
  const provisioned: string[] = [];
  const cleaned: string[] = [];
  return {
    planned,
    provisioned,
    cleaned,
    supabaseProfile: { id: "supabase" },
    rawProfile: { id: "raw" },
    encodeId: (id) =>
      [id.kind, id.schema, id.table, id.name, ...(id.args ?? [])]
        .filter((part) => part !== undefined && part !== null)
        .join(":"),
    hasBlockingDiagnostics: (list) =>
      list.some((item) => item.severity === "error"),
    provisionCoLocatedShadow: (url) => {
      provisioned.push(url);
      return Promise.resolve({
        url: `${url}_shadow`,
        cleanup: () => {
          cleaned.push(url);
          return Promise.resolve();
        },
      });
    },
    planSchemaFiles: (target, shadow, files, options) => {
      planned.push({ files, options, target, shadow });
      return Promise.resolve({
        plan: { deltas: [...deltas] },
        loadDiagnostics: [...diagnostics],
        targetDiagnostics: [],
        driftDiagnostics: [],
      });
    },
  };
}

function pools(): {
  readonly open: (url: string) => Promise<{ end: () => Promise<void> }>;
  readonly opened: string[];
  readonly ended: string[];
} {
  const opened: string[] = [];
  const ended: string[] = [];
  return {
    opened,
    ended,
    open: (url) => {
      opened.push(url);
      return Promise.resolve({
        end: () => {
          ended.push(url);
          return Promise.resolve();
        },
      });
    },
  };
}

describe("rls verify --shadow", () => {
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const base = {
    config: { policy: "./src/policy.ts" },
    db: "postgres://live/app",
    schema: "permdock",
    policies: [{ table: "public.notes", name: "permdock_notes_select" }],
    ignore: [],
  };

  it("reports PermDock objects that differ and leaves the app's objects out", async () => {
    const delta = fakeDelta([
      {
        verb: "set",
        id: POLICY,
        attr: "qual",
        from: "true",
        to: "permdock.can('notes:read')",
      },
      {
        verb: "add",
        fact: { id: { kind: "acl", target: HELPER, grantee: "authenticated" } },
      },
      {
        verb: "remove",
        fact: {
          id: {
            kind: "function",
            schema: "public",
            name: "bsb_access_notes",
            args: [],
          },
        },
      },
      {
        verb: "set",
        id: { kind: "column", schema: "public", table: "notes", name: "id" },
        attr: "type",
        from: "int",
        to: "uuid",
      },
      {
        verb: "add",
        fact: {
          id: {
            kind: "policy",
            schema: "public",
            table: "notes",
            name: "hand_written",
          },
        },
      },
    ]);
    const pool = pools();
    const result = await verifyShadow({
      ...base,
      cwd: app(),
      shadow: "postgres://shadow/empty",
      loadDelta: () => Promise.resolve(delta),
      openPool: pool.open,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      'policy:public:notes:permdock_notes_select: qual is "true" in the database and "permdock.can(\'notes:read\')" in the schema files',
    );
    expect(result.output).toContain(
      "[shadow-differs:public.notes:policy:public:notes:permdock_notes_select#qual]",
    );
    expect(result.output).toContain("[shadow-missing:permdock:acl]");
    expect(result.output).toContain(
      "function:public:bsb_access_notes is in the database and not in the schema files",
    );
    expect(result.output).not.toContain("hand_written");
    expect(result.output).not.toContain("type is");
    expect(delta.planned[0]?.files.map((file) => file.name)).toStrictEqual([
      "supabase/schemas/app.sql",
      "supabase/schemas/permdock.sql",
    ]);
    expect(delta.planned[0]?.options["profile"]).toStrictEqual({
      id: "supabase",
    });
    expect(pool.opened).toStrictEqual([
      "postgres://live/app",
      "postgres://shadow/empty",
    ]);
    expect(pool.ended.toSorted()).toStrictEqual(pool.opened.toSorted());
    expect(delta.provisioned).toStrictEqual([]);
  });

  it("passes when PermDock's objects match", async () => {
    const result = await verifyShadow({
      ...base,
      cwd: app(),
      shadow: "postgres://shadow/empty",
      loadDelta: () => Promise.resolve(fakeDelta([])),
      openPool: pools().open,
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain(
      "loaded 2 schema file(s) into the shadow: PermDock's policies, functions and grants match the database",
    );
  });

  it("provisions a shadow on the database's cluster for --shadow stack and drops it", async () => {
    const delta = fakeDelta([]);
    const pool = pools();
    const result = await verifyShadow({
      ...base,
      cwd: app(),
      shadow: "stack",
      loadDelta: () => Promise.resolve(delta),
      openPool: pool.open,
    });
    expect(result.code).toBe(0);
    expect(delta.provisioned).toStrictEqual(["postgres://live/app"]);
    expect(delta.cleaned).toStrictEqual(["postgres://live/app"]);
    expect(pool.opened).toContain("postgres://live/app_shadow");
    expect(delta.planned[0]?.options["seedAssumedSchemas"]).toBe(true);
  });

  it("stops with the load diagnostics when the files do not load", async () => {
    const result = await verifyShadow({
      ...base,
      cwd: app(),
      shadow: "postgres://shadow/empty",
      loadDelta: () =>
        Promise.resolve(
          fakeDelta(
            [],
            [
              {
                code: "load-failed",
                severity: "error",
                message: 'relation "auth.users" does not exist',
              },
            ],
          ),
        ),
      openPool: pools().open,
    });
    expect(result.code).toBe(2);
    expect(result.output).toContain('relation "auth.users" does not exist');
  });

  it("names the package when pg-delta is not installed", async () => {
    const result = await verifyShadow({
      ...base,
      cwd: app(),
      shadow: "postgres://shadow/empty",
      loadDelta: () => Promise.resolve(undefined),
      openPool: pools().open,
    });
    expect(result.code).toBe(2);
    expect(result.output).toContain("@supabase/pg-delta");
  });

  it("needs the pg-delta schema directory", async () => {
    const result = await verifyShadow({
      ...base,
      config: {
        policy: "./src/policy.ts",
        supabase: { schemas: "migrations" },
      },
      cwd: app(),
      shadow: "postgres://shadow/empty",
      loadDelta: () => Promise.resolve(fakeDelta([])),
      openPool: pools().open,
    });
    expect(result.code).toBe(2);
    expect(result.output).toContain("supabase.schemas");
  });
});
