import { readFileSync } from "node:fs";

import type { CommandResult } from "../core/result.ts";
import type { PermDockConfig } from "../types.ts";
import type { RlsFinding, VerifyIgnore } from "./verify-findings.ts";

import { isRecord } from "../../core/compact.ts";
import { describeError, exitCodeOfError } from "../core/errors.ts";
import { rel, sqlFiles } from "../files.ts";
import { openPgPool } from "../pg.ts";
import { importFromApp } from "../shared/app-peer.ts";
import { resolveSchemas } from "../supabase-schemas.ts";
import { rlsFinding, verifyResult } from "./verify-findings.ts";

const PG_DELTA = "@supabase/pg-delta";
const COMMAND = "permdock rls verify --shadow";

/** The part of pg-delta's `StableId` this check reads. */
export type ShadowId = {
  readonly kind: string;
  readonly schema?: string | null;
  readonly table?: string;
  readonly name?: string;
  readonly args?: readonly string[];
  readonly target?: ShadowId;
  readonly grantee?: string;
};

/** pg-delta's `Delta`: `from` is the database, `to` the schema files. */
export type ShadowDelta =
  | {
      readonly verb: "add" | "remove";
      readonly fact: { readonly id: ShadowId };
    }
  | {
      readonly verb: "set";
      readonly id: ShadowId;
      readonly attr: string;
      readonly from: unknown;
      readonly to: unknown;
    }
  | { readonly verb: "link" | "unlink" };

type ShadowDiagnostic = {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
};

type ShadowPool = { readonly end: () => Promise<void> };

/** The part of `@supabase/pg-delta` 1.0.0-alpha.61 this check calls. */
export type ShadowPgDelta = {
  readonly planSchemaFiles: (
    target: ShadowPool,
    shadow: ShadowPool,
    files: { readonly name: string; readonly sql: string }[],
    options: Record<string, unknown>,
  ) => Promise<{
    readonly plan: { readonly deltas: readonly ShadowDelta[] };
    readonly loadDiagnostics: readonly ShadowDiagnostic[];
    readonly targetDiagnostics: readonly ShadowDiagnostic[];
    readonly driftDiagnostics: readonly ShadowDiagnostic[];
  }>;
  readonly provisionCoLocatedShadow: (
    url: string,
  ) => Promise<{ readonly url: string; readonly cleanup: () => Promise<void> }>;
  readonly encodeId: (id: ShadowId) => string;
  readonly hasBlockingDiagnostics: (
    diagnostics: readonly ShadowDiagnostic[],
    options: { readonly strictCoverage: boolean },
  ) => boolean;
  readonly supabaseProfile: unknown;
  readonly rawProfile: unknown;
};

const FUNCTIONS = [
  "planSchemaFiles",
  "provisionCoLocatedShadow",
  "encodeId",
  "hasBlockingDiagnostics",
] as const;

function isPgDelta(value: unknown): value is ShadowPgDelta {
  return (
    isRecord(value) &&
    FUNCTIONS.every((name) => typeof value[name] === "function")
  );
}

async function loadPgDelta(cwd: string): Promise<ShadowPgDelta | undefined> {
  const loaded = await importFromApp(cwd, PG_DELTA);
  return isPgDelta(loaded) ? loaded : undefined;
}

export type VerifyShadowInput = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  /** The live database. */
  readonly db: string;
  /** An empty database's URL, or `stack` for one on the database's cluster. */
  readonly shadow: string;
  /** The schema PermDock's helpers live in. */
  readonly schema: string;
  /** The policies `generate` writes, tables as `schema.table`. */
  readonly policies: readonly {
    readonly table: string;
    readonly name: string;
  }[];
  readonly ignore: readonly VerifyIgnore[];
  readonly loadDelta?: () => Promise<ShadowPgDelta | undefined>;
  readonly openPool?: (url: string) => Promise<ShadowPool>;
};

/** Whether `id` is an object `generate` writes, or a grant or comment on one. */
function ownedBy(input: VerifyShadowInput): (id: ShadowId) => boolean {
  const policies = new Set(
    input.policies.map((policy) => `${policy.table}\u0000${policy.name}`),
  );
  const owned = (id: ShadowId): boolean => {
    if (id.target !== undefined) {
      return owned(id.target);
    }
    if (id.kind === "schema") {
      return id.name === input.schema;
    }
    if (id.schema === input.schema) {
      return true;
    }
    if (id.kind === "policy") {
      return policies.has(
        `${id.schema ?? "public"}.${id.table ?? ""}\u0000${id.name ?? ""}`,
      );
    }
    return (
      (id.kind === "function" || id.kind === "procedure") &&
      id.name?.startsWith("bsb_access_") === true
    );
  };
  return owned;
}

/** The finding's table part: the table a policy is on, else the schema. */
function ownerOf(id: ShadowId): string {
  if (id.target !== undefined) {
    return ownerOf(id.target);
  }
  if (id.table !== undefined) {
    return `${id.schema ?? "public"}.${id.table}`;
  }
  return id.schema ?? id.name ?? id.kind;
}

const SHOWN = 200;

function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > SHOWN ? `${text.slice(0, SHOWN)}…` : text;
}

function findingOf(
  delta: ShadowDelta,
  encode: (id: ShadowId) => string,
): RlsFinding | undefined {
  switch (delta.verb) {
    case "add": {
      const key = encode(delta.fact.id);
      return rlsFinding(
        "shadow-missing",
        ownerOf(delta.fact.id),
        key,
        `${key} is in the schema files and not in the database`,
      );
    }
    case "remove": {
      const key = encode(delta.fact.id);
      return rlsFinding(
        "shadow-extra",
        ownerOf(delta.fact.id),
        key,
        `${key} is in the database and not in the schema files`,
      );
    }
    case "set": {
      const key = encode(delta.id);
      return rlsFinding(
        "shadow-differs",
        ownerOf(delta.id),
        `${key}#${delta.attr}`,
        `${key}: ${delta.attr} is ${shown(delta.from)} in the database and ${shown(delta.to)} in the schema files`,
      );
    }
    case "link":
    case "unlink":
      return undefined;
    default: {
      const never: never = delta;
      return never;
    }
  }
}

function subjectOf(delta: ShadowDelta): ShadowId | undefined {
  switch (delta.verb) {
    case "add":
    case "remove":
      return delta.fact.id;
    case "set":
      return delta.id;
    case "link":
    case "unlink":
      return undefined;
    default: {
      const never: never = delta;
      return never;
    }
  }
}

async function planned(
  delta: ShadowPgDelta,
  input: VerifyShadowInput,
  files: { readonly name: string; readonly sql: string }[],
): Promise<CommandResult> {
  const open =
    input.openPool ?? ((url: string) => openPgPool(url, COMMAND, input.cwd));
  const stack =
    input.shadow === "stack"
      ? await delta.provisionCoLocatedShadow(input.db)
      : undefined;
  const pools: ShadowPool[] = [];
  try {
    const target = await open(input.db);
    pools.push(target);
    const shadow = await open(stack?.url ?? input.shadow);
    pools.push(shadow);
    const dialect = input.config.rls?.dialect ?? "supabase";
    const result = await delta.planSchemaFiles(target, shadow, files, {
      profile:
        dialect === "supabase" ? delta.supabaseProfile : delta.rawProfile,
      ...(stack === undefined ? {} : { seedAssumedSchemas: true }),
    });
    const diagnostics = [
      ...result.loadDiagnostics,
      ...result.targetDiagnostics,
      ...result.driftDiagnostics,
    ];
    if (delta.hasBlockingDiagnostics(diagnostics, { strictCoverage: false })) {
      return {
        code: 2,
        output: [
          "PermDock CLI: rls verify --shadow could not load the schema files into the shadow:",
          ...diagnostics
            .filter((item) => item.severity === "error")
            .map((item) => `  ${item.code}: ${item.message}`),
        ].join("\n"),
      };
    }
    const owned = ownedBy(input);
    const findings = result.plan.deltas.flatMap((item) => {
      const subject = subjectOf(item);
      const finding =
        subject !== undefined && owned(subject)
          ? findingOf(item, delta.encodeId)
          : undefined;
      return finding === undefined ? [] : [finding];
    });
    return verifyResult({
      findings,
      ignore: input.ignore,
      summary: `loaded ${String(files.length)} schema file(s) into the shadow: PermDock's policies, functions and grants match the database`,
    });
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await stack?.cleanup();
  }
}

/**
 * `rls verify --shadow`: loads the declarative schema directory into a shadow
 * with pg-delta, plans from the live database to it, and reports each change to
 * an object `generate` writes. Both sides are Postgres's own reading of the
 * SQL, so a policy expression or function body compares as Postgres stores it.
 */
export async function verifyShadow(
  input: VerifyShadowInput,
): Promise<CommandResult> {
  const schemas = resolveSchemas(input.cwd, input.config);
  if (schemas.mode !== "pg-delta") {
    return {
      code: 2,
      output: `PermDock CLI: rls verify --shadow loads the pg-delta schema directory; supabase.schemas is ${schemas.mode}`,
    };
  }
  const delta = await (input.loadDelta ?? (() => loadPgDelta(input.cwd)))();
  if (delta === undefined) {
    return {
      code: 2,
      output: `PermDock CLI: rls verify --shadow needs ${PG_DELTA}; install better-supabase, which installs it, or add ${PG_DELTA} as a dev dependency`,
    };
  }
  const files = sqlFiles(input.cwd, [schemas.schemaDir]).map((file) => ({
    name: rel(input.cwd, file),
    sql: readFileSync(file, "utf8"),
  }));
  try {
    return await planned(delta, input, files);
  } catch (cause) {
    return { code: exitCodeOfError(cause), output: describeError(cause) };
  }
}
