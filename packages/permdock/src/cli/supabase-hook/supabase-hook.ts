import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Policy } from "../../core/policy-types.ts";
import type { SupabaseHookManifest } from "../../supabase/manifest.ts";
import type { CommandResult } from "../shared/result.ts";
import type { CliIo, PermDockConfig, SupabaseSchemas } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { type Scope, scopeList } from "../../core/scopes.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { readJsonFile, writeFileEnsuringDir } from "../files.ts";
import { requirePolicy } from "../load.ts";
import { formatManifestJson, MANIFEST_FILE } from "../manifest-json.ts";
import {
  driftOf,
  pgDeltaPath,
  type OutputFile,
  STDOUT,
  writeOutputFiles,
} from "../output-files.ts";
import {
  GRANTS_MARKER,
  HOOK_MARKER,
  hookMarkerFields,
} from "../sql/markers.ts";
import { splitUndiffed } from "../sql/statements.ts";
import {
  isSupabaseSchemas,
  resolveSchemas,
  schemasRefusal,
} from "../supabase-schemas.ts";
import {
  missingHelpersInDb,
  missingHelpersInFiles,
  missingHelpersMessage,
} from "../supabase-setup.ts";
import {
  authzVersionForSql,
  membersOfSql,
  apiWrappersSql,
  subjectForSql,
} from "./api.ts";
import { attrsGuardSql } from "./claims.ts";
import { defaultOut, hookMarker, manifestOf } from "./manifest.ts";
import {
  type HookOverrides,
  configToml,
  grantsSql,
  hookParts,
  hookSql,
  managedSql,
} from "./sql.ts";
import { versionSql } from "./version.ts";

const SUPABASE_HELP = `permdock supabase hook generate | inspect

  hook generate [--out <file>] [--check] [--db <url>] [--schemas pg-delta|migra|migrations]
                [--active-from app_metadata.active_<scope>|<table>.<column>]
                [--budget 1024] [--schema public] [--grants-out <file>|-]
  inspect [--json] [--out [permdock.manifest.json]] [--check]

Reads supabase.hook from permdock.config.ts: the tableMembershipSource / junctionMembershipSource sources the app
passes as memberships. hook generate emits custom_access_token_hook(jsonb), the grants it
needs, the permdock_authz_version table and its triggers. Under pg-delta (the default) --out defaults to
supabase/schemas/<schema>/functions/custom_access_token_hook.sql and the grants stay in it; under
--schemas migra, --grants-out takes the privileges supabase db diff drops. Never grants anything to
service_role unless supabase.hook.api is set, which grants its wrappers to it. inspect prints the manifest: helper schema, names and signatures, tenant claim,
budget, the claims the hook writes, the membership sources and the columns that decide them.
--out writes it as JSON, to permdock.manifest.json without a path; --check exits 1 when that
file differs.
`;

/** `supabase.hook.out`, else pg-delta's per-schema path under pg-delta, else `supabase/permdock-hook.sql`. */
export function hookOut(
  cwd: string,
  config: PermDockConfig,
  schema?: string,
  flag?: SupabaseSchemas,
): string {
  const schemas = resolveSchemas(cwd, config, flag);
  return config.supabase?.hook?.out !== undefined || schemas.mode !== "pg-delta"
    ? defaultOut(config)
    : pgDeltaPath(
        schemas.schemaDir,
        "hook",
        schema ??
          config.supabase?.hook?.schema ??
          config.rls?.schema ??
          PERMDOCK_SCHEMA,
      );
}

/**
 * The manifest `supabase inspect` prints. With `policy`, `rls.helpers` also
 * lists the assignment checks `rls generate` writes for roles that declare
 * `assigns`.
 */
export function supabaseHookManifest(
  scopes: readonly Scope[],
  config: PermDockConfig,
  overrides: HookOverrides & {
    readonly out?: string;
    readonly schemas?: SupabaseSchemas;
  } = {},
  policy?: Policy,
): SupabaseHookManifest {
  const parts = hookParts(scopes, config, overrides);
  const manifest = manifestOf(
    parts,
    overrides.out ?? defaultOut(config),
    config,
    policy,
  );
  return overrides.schemas === undefined
    ? manifest
    : { ...manifest, hook: { ...manifest.hook, schemas: overrides.schemas } };
}

/**
 * The hook migration. With `grantsOut`, the statements `supabase db diff`
 * drops are left out of `sql` and returned in `grants` for that file.
 */
export function supabaseHookSql(
  scopes: readonly Scope[],
  config: PermDockConfig,
  overrides: HookOverrides = {},
  grantsOut?: string,
): {
  readonly sql: string;
  readonly grants: string;
  readonly manifest: SupabaseHookManifest;
} {
  const parts = hookParts(scopes, config, overrides);
  const manifest = manifestOf(parts, defaultOut(config), config);
  const toml = configToml(parts.schema, parts.jwtExpiry)
    .split("\n")
    .map((line) => (line === "" ? "--" : `--   ${line}`))
    .join("\n");
  const sql = [
    `${hookMarker(manifest)}
-- custom_access_token_hook(jsonb): memberships go active ${parts.root} first and stop at the budget
-- supabase/config.toml:
${toml}${grantsOut === undefined ? "" : `\n-- what supabase db diff drops from this part is in ${grantsOut}`}`,
    attrsGuardSql(parts.attrs),
    hookSql(parts),
    versionSql(parts),
    subjectForSql(parts, config),
    authzVersionForSql(parts),
    membersOfSql(parts),
    apiWrappersSql(parts),
    grantsSql(parts),
    managedSql(parts),
  ]
    .filter((chunk) => chunk !== "")
    .join("\n\n");
  const { kept, moved } = splitUndiffed(`${sql}\n`);
  const grants = `${GRANTS_MARKER} schema=${parts.schema}
-- the privileges and view options supabase db diff drops from the hook part
${moved.join("\n")}
`;
  return { sql: grantsOut === undefined ? `${sql}\n` : kept, grants, manifest };
}

/** What the hook file's header says about where its grants went. */
export function grantsLabel(grantsOut: string | undefined): string | undefined {
  if (grantsOut === undefined) {
    return undefined;
  }
  return grantsOut === STDOUT ? "a separate migration" : grantsOut;
}

function markerDrift(
  onDisk: string,
  expected: SupabaseHookManifest,
  outRel: string,
): string {
  const found = hookMarkerFields(onDisk);
  if (found === undefined) {
    return `supabase hook drift: ${outRel} has no ${HOOK_MARKER} line`;
  }
  const want = hookMarkerFields(hookMarker(expected)) ?? {};
  const changed = Object.keys(want)
    .filter((key) => found[key] !== want[key])
    .map((key) => `${key} ${found[key] ?? "(none)"} -> ${want[key] ?? ""}`);
  return changed.length === 0
    ? "supabase hook drift"
    : `supabase hook drift: ${changed.join("; ")}`;
}

function inspectText(manifest: SupabaseHookManifest): string {
  return [
    `hook ${manifest.hook.schema}.${manifest.hook.function} (${manifest.hook.out})`,
    `helpers ${manifest.helpers.functions.map((fn) => `${manifest.helpers.schema}.${fn}`).join(", ")}`,
    `tenant claim ${manifest.tenantClaim}`,
    `budget ${String(manifest.budget.bytes)} bytes of ${manifest.budget.measure}`,
    `claims ${manifest.claims.map((claim) => `${claim.name}${claim.source === "permdock" ? "" : ` (${claim.source})`}${claim.budget ? " [budget]" : ""}`).join(", ")}`,
    `authz_ver ${manifest.authzVersion ? "on" : "off"}`,
  ].join("\n");
}

/**
 * Writes the manifest to `rel`, or with `check` compares it as JSON, so a
 * formatter that reflows the file is not drift.
 */
function manifestFile(
  cwd: string,
  rel: string,
  manifest: SupabaseHookManifest,
  check: boolean,
): { readonly code: 0 | 1; readonly output: string } {
  const path = resolve(cwd, rel);
  if (!check) {
    writeFileEnsuringDir(path, formatManifestJson(manifest));
    return { code: 0, output: `wrote ${rel}` };
  }
  if (!existsSync(path)) {
    return { code: 1, output: `supabase manifest drift: missing ${rel}` };
  }
  let onDisk: unknown;
  try {
    onDisk = readJsonFile(path);
  } catch {
    return { code: 1, output: `supabase manifest drift: ${rel} is not JSON` };
  }
  const found: Record<string, unknown> = isRecord(onDisk)
    ? Object.fromEntries(Object.entries(onDisk))
    : {};
  const changed = [
    ...new Set([...Object.keys(manifest), ...Object.keys(found)]),
  ].filter(
    (key) =>
      JSON.stringify(Reflect.get(manifest, key)) !== JSON.stringify(found[key]),
  );
  return changed.length === 0
    ? { code: 0, output: "supabase manifest up to date" }
    : {
        code: 1,
        output: `supabase manifest drift: ${rel} differs in ${changed.join(", ")}; run permdock supabase inspect --out ${rel}`,
      };
}

export async function loadScopes(
  cwd: string,
  config: PermDockConfig,
): Promise<readonly Scope[]> {
  return scopeList((await loadHookPolicy(cwd, config)).scopes);
}

function loadHookPolicy(cwd: string, config: PermDockConfig): Promise<Policy> {
  return requirePolicy(
    cwd,
    config.policy,
    "supabase hook generate needs policy in permdock.config.ts",
  );
}

export async function runSupabase(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly rest: readonly string[];
  /** `true` for a bare `--out`. */
  readonly out?: string | true;
  readonly check: boolean;
  readonly json?: boolean;
  readonly db?: string;
  readonly activeFrom?: string;
  readonly budget?: string;
  readonly schema?: string;
  readonly grantsOut?: string;
  /** `--schemas`: `pg-delta`, `migra` or `migrations`. */
  readonly schemas?: string;
  readonly io: CliIo;
}): Promise<CommandResult> {
  const [area, action] = input.rest;
  const badSchemas = schemasRefusal("supabase", input.schemas);
  if (badSchemas !== undefined) {
    return { code: 2, output: badSchemas };
  }
  const flag = isSupabaseSchemas(input.schemas) ? input.schemas : undefined;
  const schemas = resolveSchemas(input.cwd, input.config, flag);
  const overrides: HookOverrides = Object.fromEntries(
    Object.entries({
      activeFrom: input.activeFrom,
      budget: input.budget,
      schema: input.schema,
    }).filter(([, value]) => value !== undefined),
  );
  if (area === "inspect" && action === undefined) {
    const policy = await loadHookPolicy(input.cwd, input.config);
    const manifest = supabaseHookManifest(
      scopeList(policy.scopes),
      input.config,
      {
        ...overrides,
        out: hookOut(input.cwd, input.config, input.schema, flag),
        schemas: schemas.mode,
      },
      policy,
    );
    if (input.out !== undefined || input.check) {
      return manifestFile(
        input.cwd,
        typeof input.out === "string" ? input.out : MANIFEST_FILE,
        manifest,
        input.check,
      );
    }
    return {
      code: 0,
      output:
        input.json === true
          ? JSON.stringify(manifest, null, 2)
          : inspectText(manifest),
    };
  }
  if (area !== "hook" || action !== "generate") {
    return { code: 2, output: SUPABASE_HELP };
  }
  if (input.grantsOut !== undefined && schemas.mode !== "migra") {
    return {
      code: 2,
      output: `supabase hook generate --grants-out is for --schemas migra: ${schemas.mode === "pg-delta" ? "pg-delta keeps the grants in the hook file" : "a hand-written migration keeps its grants"}, so drop --grants-out`,
    };
  }
  const scopes = await loadScopes(input.cwd, input.config);
  const { sql, grants, manifest } = supabaseHookSql(
    scopes,
    input.config,
    overrides,
    grantsLabel(input.grantsOut),
  );
  const outRel =
    typeof input.out === "string"
      ? input.out
      : hookOut(input.cwd, input.config, input.schema, flag);
  const outPath = resolve(input.cwd, outRel);
  const hook = input.config.supabase?.hook;
  const grantsFile: readonly OutputFile[] =
    input.grantsOut === undefined
      ? []
      : [{ part: "grants", rel: input.grantsOut, text: grants }];
  const toml = configToml(
    input.schema ?? hook?.schema ?? input.config.rls?.schema ?? PERMDOCK_SCHEMA,
    hook?.jwtExpiry ?? 900,
  );
  if (input.check) {
    if (!existsSync(outPath)) {
      return { code: 1, output: `supabase hook drift: missing ${outRel}` };
    }
    const onDisk = readFileSync(outPath, "utf8");
    if (onDisk !== sql) {
      return { code: 1, output: markerDrift(onDisk, manifest, outRel) };
    }
    const drift = driftOf(input.cwd, grantsFile);
    return drift.length === 0
      ? { code: 0, output: "supabase hook up to date" }
      : { code: 1, output: `supabase hook drift: ${drift.join("; ")}` };
  }
  writeFileEnsuringDir(outPath, sql);
  const grantsWritten = writeOutputFiles(input.cwd, grantsFile);
  const placed = { ...manifest, hook: { ...manifest.hook, out: outRel } };
  const missing =
    input.db === undefined
      ? missingHelpersInFiles(input.cwd, input.config, placed)
      : await missingHelpersInDb(input.db, placed);
  return {
    code: 0,
    output: [
      `wrote ${[outRel, ...grantsWritten.wrote].join(", ")}`,
      ...(grantsWritten.printed === "" ? [] : [grantsWritten.printed]),
      "add to supabase/config.toml:",
      toml,
      ...(missing.length === 0 ? [] : [missingHelpersMessage(placed, missing)]),
    ].join("\n"),
  };
}
