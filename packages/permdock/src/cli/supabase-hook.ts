import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Policy } from "../core/policy.ts";
import type { Scope } from "../core/scopes.ts";
import type { SupabaseHookManifest } from "../supabase/manifest.ts";
import type { HookOverrides } from "./supabase-hook-sql.ts";
import type { CliIo, PermDockConfig } from "./types.ts";

import { scopeList } from "../core/scopes.ts";
import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";
import { asPolicy, loadModule, pickNamed } from "./load.ts";
import { GRANTS_MARKER, HOOK_MARKER, hookMarkerFields } from "./markers.ts";
import {
  driftOf,
  pgDeltaPath,
  type SqlFile,
  STDOUT,
  writeSqlFiles,
} from "./sql-files.ts";
import { splitUndiffed } from "./sql-statements.ts";
import { supabaseConfig } from "./supabase-config.ts";
import {
  defaultOut,
  hookMarker,
  manifestOf,
} from "./supabase-hook-manifest.ts";
import {
  attrsGuardSql,
  authzVersionForSql,
  configToml,
  grantsSql,
  hookParts,
  hookSql,
  managedSql,
  membersOfSql,
  subjectForSql,
  versionSql,
} from "./supabase-hook-sql.ts";
import {
  missingHelpersInDb,
  missingHelpersInFiles,
  missingHelpersMessage,
} from "./supabase-setup.ts";

const SUPABASE_HELP = `permdock supabase hook generate | inspect

  hook generate [--out supabase/permdock-hook.sql] [--check] [--db <url>]
                [--active-from app_metadata.active_<scope>|<table>.<column>]
                [--budget 1024] [--schema public] [--grants-out <file>|-]
  inspect [--json] [--out [permdock.manifest.json]] [--check]

Reads supabase.hook from permdock.config.ts: the fromTable / fromJunction sources the app
passes as memberships. hook generate emits custom_access_token_hook(jsonb), the grants it
needs (the ones db diff drops in --grants-out, for declarative schemas), the permdock_authz_version table
and its triggers. Never grants anything to
service_role. inspect prints the manifest: helper schema, names and signatures, tenant claim,
budget, the claims the hook writes, the membership sources and the columns that decide them.
--out writes it as JSON, to permdock.manifest.json without a path; --check exits 1 when that
file differs.
`;

const MANIFEST_FILE = "permdock.manifest.json";

/** `supabase.hook.out`, else pg-delta's per-schema path, else `supabase/permdock-hook.sql`. */
export function hookOut(
  cwd: string,
  config: PermDockConfig,
  schema?: string,
): string {
  const pgDelta = supabaseConfig(cwd).pgDelta;
  return config.supabase?.hook?.out !== undefined || pgDelta === undefined
    ? defaultOut(config)
    : pgDeltaPath(
        pgDelta.schemaDir,
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
  overrides: HookOverrides & { readonly out?: string } = {},
  policy?: Policy,
): SupabaseHookManifest {
  const parts = hookParts(scopes, config, overrides);
  return manifestOf(parts, overrides.out ?? defaultOut(config), config, policy);
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
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return { code: 0, output: `wrote ${rel}` };
  }
  if (!existsSync(path)) {
    return { code: 1, output: `supabase manifest drift: missing ${rel}` };
  }
  let onDisk: unknown;
  try {
    onDisk = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { code: 1, output: `supabase manifest drift: ${rel} is not JSON` };
  }
  const found: Record<string, unknown> =
    typeof onDisk === "object" && onDisk !== null && !Array.isArray(onDisk)
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

async function loadHookPolicy(
  cwd: string,
  config: PermDockConfig,
): Promise<Policy> {
  if (config.policy === undefined) {
    throw new Error(
      "PermDock CLI: supabase hook generate needs policy in permdock.config.ts",
    );
  }
  return asPolicy(
    pickNamed(await loadModule(resolve(cwd, config.policy)), ["policy"]),
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
  readonly io: CliIo;
}): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  const [area, action] = input.rest;
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
        out: hookOut(input.cwd, input.config, input.schema),
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
      : hookOut(input.cwd, input.config, input.schema);
  const outPath = resolve(input.cwd, outRel);
  const hook = input.config.supabase?.hook;
  const grantsFile: readonly SqlFile[] =
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
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, sql);
  const grantsWritten = writeSqlFiles(input.cwd, grantsFile);
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
