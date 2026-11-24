import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { parse } from "smol-toml";

import type { DoctorFinding } from "./shared/doctor-types.ts";
import type { PermDockConfig } from "./types.ts";

import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";
import { describeError } from "./core/errors.ts";
import { hookUri } from "./rls/rbac.ts";

/** The formats the Supabase CLI reads its project config from. */
export type SupabaseConfigFormat = "toml" | "json" | "jsonc";

/** The settings of the Supabase project config doctor reads. */
export type SupabaseConfig = {
  /** `[auth] jwt_expiry`, in seconds. */
  readonly jwtExpiry?: number;
  /** `[db.migrations] schema_paths`, relative to `supabase/`. */
  readonly schemaPaths?: readonly string[];
  /** `[api] schemas`: the schemas the Data API exposes. */
  readonly apiSchemas?: readonly string[];
  /** `[db] major_version`: the Postgres grammar of the project. */
  readonly majorVersion?: number;
  /** `[db] driver`, such as `sqlite` for Supabase Lite. */
  readonly driver?: string;
  /** `[db.seed] sql_paths`. */
  readonly seedPaths?: readonly string[];
  /** `[auth.hook.custom_access_token]`, when the file has the table. */
  readonly customAccessTokenHook?: {
    readonly enabled?: boolean;
    readonly uri?: string;
  };
  /**
   * The `[experimental.pgdelta]` table, when the file has one: declarative
   * schemas on pg-delta, which orders statements by their dependencies, so
   * files are unnumbered.
   */
  readonly pgDelta?: {
    /** `enabled`; `undefined` when the table does not set it to a boolean. */
    readonly enabled?: boolean;
    /** `supabase/` joined with `declarative_schema_path` (default `schemas`). */
    readonly schemaDir: string;
  };
  /**
   * Keys whose value is `env(NAME)` with `NAME` unset, as `auth.jwt_expiry =
   * env(JWT_EXPIRY)`; they read as unset.
   */
  readonly unresolvedEnv?: readonly string[];
};

export type SupabaseConfigRead =
  | {
      readonly ok: true;
      readonly config: SupabaseConfig;
      /** The file read, relative to the working directory. */
      readonly file: string;
      readonly format: SupabaseConfigFormat;
    }
  | { readonly ok: false; readonly error: string; readonly file: string };

/** The file names the CLI looks for in `supabase/`, in its order of preference. */
type SupabaseConfigFile = {
  readonly file: string;
  readonly format: SupabaseConfigFormat;
};

const CONFIG_FILES: readonly SupabaseConfigFile[] = [
  { file: "supabase/config.json", format: "json" },
  { file: "supabase/config.jsonc", format: "jsonc" },
  { file: "supabase/config.toml", format: "toml" },
];

/**
 * The project's config file by the CLI's order of preference (`config.json`,
 * `config.jsonc`, `config.toml`), or `undefined` when it has none.
 */
function supabaseConfigFile(cwd: string): SupabaseConfigFile | undefined {
  return CONFIG_FILES.find(({ file }) => existsSync(join(cwd, file)));
}

/**
 * The config file name for messages: the one the project has, else
 * `config.toml`.
 */
export function supabaseConfigName(cwd: string): string {
  return supabaseConfigFile(cwd)?.file ?? "supabase/config.toml";
}

function table(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: a non-array object from the TOML or JSON parser is a table.
  return value as Record<string, unknown>;
}

function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

const ENV_VALUE = /^env\((?<name>[A-Za-z_][A-Za-z0-9_]*)\)$/u;

/**
 * JSON with comments and trailing commas, as `supabase config convert` writes
 * `config.jsonc`, reduced to plain JSON outside string literals.
 */
function stripJsonc(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === "\\" ? 2 : 1;
      }
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out.replaceAll(/,(?<space>\s*)(?<close>[\]}])/gu, "$<space>$<close>");
}

function parseDocument(
  text: string,
  format: SupabaseConfigFormat,
): Readonly<Record<string, unknown>> {
  switch (format) {
    case "toml":
      return parse(text);
    case "json":
    case "jsonc": {
      const value: unknown = JSON.parse(
        format === "json" ? text : stripJsonc(text),
      );
      const root = table(value);
      if (root === undefined) {
        throw new Error("the top level is not an object");
      }
      return root;
    }
    default: {
      const exhaustive: never = format;
      return exhaustive;
    }
  }
}

/**
 * The project config, parsed from `supabase/config.json`, `config.jsonc` or
 * `config.toml` (the CLI's order); `undefined` when the project has none. Both
 * `config.json` and `config.jsonc`, which the CLI refuses, is an error.
 */
export function readSupabaseConfig(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SupabaseConfigRead | undefined {
  const found = supabaseConfigFile(cwd);
  if (found === undefined) {
    return undefined;
  }
  if (
    found.format === "json" &&
    existsSync(join(cwd, "supabase/config.jsonc"))
  ) {
    return {
      ok: false,
      file: found.file,
      error:
        "supabase/config.json and supabase/config.jsonc both exist, and the Supabase CLI refuses to start; keep one",
    };
  }
  let root: Readonly<Record<string, unknown>>;
  try {
    root = parseDocument(
      readFileSync(join(cwd, found.file), "utf8"),
      found.format,
    );
  } catch (error) {
    return { ok: false, file: found.file, error: describeError(error) };
  }
  const unresolved: string[] = [];
  const read = (path: readonly string[]): unknown => {
    let value: unknown = root;
    for (const key of path) {
      value = table(value)?.[key];
    }
    if (typeof value !== "string") {
      return value;
    }
    const name = ENV_VALUE.exec(value)?.groups?.["name"];
    if (name === undefined) {
      return value;
    }
    const resolved = env[name];
    if (resolved === undefined) {
      unresolved.push(`${path.join(".")} = env(${name})`);
      return undefined;
    }
    return /^-?\d+$/u.test(resolved)
      ? Number(resolved)
      : resolved === "true" || resolved === "false"
        ? resolved === "true"
        : resolved;
  };
  const expiry = read(["auth", "jwt_expiry"]);
  const schemaPaths = strings(read(["db", "migrations", "schema_paths"]));
  const apiSchemas = strings(read(["api", "schemas"]));
  const seedPaths = strings(read(["db", "seed", "sql_paths"]));
  const majorVersion = read(["db", "major_version"]);
  const driver = read(["db", "driver"]);
  const hookTable = table(
    table(table(root["auth"])?.["hook"])?.["custom_access_token"],
  );
  const hookEnabled = read(["auth", "hook", "custom_access_token", "enabled"]);
  const hookUriValue = read(["auth", "hook", "custom_access_token", "uri"]);
  const pgDelta = table(table(root["experimental"])?.["pgdelta"]);
  const schemaPath = read([
    "experimental",
    "pgdelta",
    "declarative_schema_path",
  ]);
  const enabled = read(["experimental", "pgdelta", "enabled"]);
  return {
    ok: true,
    file: found.file,
    format: found.format,
    config: {
      ...(typeof expiry === "number" ? { jwtExpiry: expiry } : {}),
      ...(schemaPaths === undefined ? {} : { schemaPaths }),
      ...(apiSchemas === undefined ? {} : { apiSchemas }),
      ...(typeof majorVersion === "number" ? { majorVersion } : {}),
      ...(typeof driver === "string" ? { driver } : {}),
      ...(seedPaths === undefined ? {} : { seedPaths }),
      ...(hookTable === undefined
        ? {}
        : {
            customAccessTokenHook: {
              ...(typeof hookEnabled === "boolean"
                ? { enabled: hookEnabled }
                : {}),
              ...(typeof hookUriValue === "string"
                ? { uri: hookUriValue }
                : {}),
            },
          }),
      ...(pgDelta === undefined
        ? {}
        : {
            pgDelta: {
              ...(typeof enabled === "boolean" ? { enabled } : {}),
              schemaDir: declarativeSchemaDir(schemaPath),
            },
          }),
      ...(unresolved.length === 0 ? {} : { unresolvedEnv: unresolved }),
    },
  };
}

/**
 * `supabase/` joined with `declarative_schema_path`, which defaults to
 * `schemas`.
 */
export function declarativeSchemaDir(schemaPath?: unknown): string {
  return posix
    .join("supabase", typeof schemaPath === "string" ? schemaPath : "schemas")
    .replace(/\/$/u, "");
}

/**
 * The parsed config, or `{}` when it is missing or does not parse (PD045
 * reports that).
 */
export function supabaseConfig(cwd: string): SupabaseConfig {
  const read = readSupabaseConfig(cwd);
  return read?.ok === true ? read.config : {};
}

/**
 * PD045: a Supabase project config the CLI cannot parse, so every check that
 * reads it falls back to defaults, or an `env(NAME)` value with `NAME` unset.
 */
export function pd045(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly DoctorFinding[] {
  const read = readSupabaseConfig(cwd, env);
  if (read === undefined) {
    return [];
  }
  if (read.ok) {
    return (read.config.unresolvedEnv ?? []).map((entry) => ({
      code: "PD045",
      severity: "warning",
      message: `${read.file} sets ${entry}, and the variable is unset, so PermDock reads the key as unset`,
      fix: `set the variable before running permdock, or write the value in ${read.file}`,
    }));
  }
  return [
    {
      code: "PD045",
      severity: "warning",
      message: `${read.file} does not parse: ${read.error.replace(/\n[\s\S]*/u, "")}`,
      fix: `run supabase config validate and fix ${read.file}; until then PermDock assumes Supabase's defaults for jwt_expiry, schema_paths and [experimental.pgdelta], and generates for pg-delta`,
    },
  ];
}

/** The oldest Supabase CLI PermDock supports, as better-supabase's BS710. */
const SUPABASE_CLI_FLOOR = "3.2.0";

function belowFloor(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version
    .split(/[.+-]/u, 3)
    .map(Number);
  const [floorMajor = 0, floorMinor = 0, floorPatch = 0] =
    SUPABASE_CLI_FLOOR.split(".").map(Number);
  return (
    major * 1e6 + minor * 1e3 + patch <
    floorMajor * 1e6 + floorMinor * 1e3 + floorPatch
  );
}

/**
 * PD136: the project installs a Supabase CLI older than 3.2.0, which lacks
 * pg-delta by default, `config.jsonc` and `supabase status --stack`.
 */
export function pd136(cwd: string): readonly DoctorFinding[] {
  if (supabaseConfigFile(cwd) === undefined) {
    return [];
  }
  let version: unknown;
  try {
    const pkg: unknown = createRequire(join(cwd, "package.json"))(
      "supabase/package.json",
    );
    version = table(pkg)?.["version"];
  } catch {
    return [];
  }
  if (typeof version !== "string" || !belowFloor(version)) {
    return [];
  }
  return [
    {
      code: "PD136",
      severity: "warning",
      message: `the project installs Supabase CLI ${version}; PermDock supports ${SUPABASE_CLI_FLOOR} and later`,
      fix: `upgrade the supabase dev dependency to ${SUPABASE_CLI_FLOOR} or later`,
    },
  ];
}

const SQLITE_DRIVERS = new Set(["sqlite", "sqlite-postgres"]);

/**
 * PD127: `rls` is configured but `[db] driver` runs Supabase Lite on SQLite,
 * which has no database functions, so the generated policies and helpers never
 * exist there.
 */
export function pd127(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  const driver = supabaseConfig(cwd).driver;
  if (config.rls === undefined || driver === undefined) {
    return [];
  }
  if (!SQLITE_DRIVERS.has(driver)) {
    return [];
  }
  return [
    {
      code: "PD127",
      severity: "warning",
      message: `${supabaseConfigName(cwd)} sets [db] driver = "${driver}", which runs Supabase Lite without Postgres functions or row level security, so the policies and helpers rls generates do not exist there; can() in the app still decides`,
      fix: "remove rls from permdock.config.ts while the project runs on SQLite, or set [db] driver back to Postgres",
    },
  ];
}

/**
 * PD074: `supabase.hook` is configured but `[auth.hook.custom_access_token]` in
 * the Supabase project config does not enable the generated function, so a
 * local stack and every branch push issue tokens without memberships.
 */
export function pd074(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  const hook = config.supabase?.hook;
  const read = readSupabaseConfig(cwd);
  if (hook === undefined || read === undefined || !read.ok) {
    return [];
  }
  const schema = hook.schema ?? config.rls?.schema ?? PERMDOCK_SCHEMA;
  const expected = hookUri(schema);
  const found = read.config.customAccessTokenHook;
  const file = read.file;
  const fix =
    read.format === "toml"
      ? `add to ${file}:\n[auth.hook.custom_access_token]\nenabled = true\nuri = "${expected}"`
      : `add to ${file}:\n"auth": { "hook": { "custom_access_token": { "enabled": true, "uri": "${expected}" } } }`;
  if (found?.enabled !== true) {
    return [
      {
        code: "PD074",
        severity: "warning",
        message: `supabase.hook is configured but ${file} does not set [auth.hook.custom_access_token] enabled = true, so Auth never calls the hook`,
        fix,
      },
    ];
  }
  if (found.uri !== expected) {
    return [
      {
        code: "PD074",
        severity: "warning",
        message: `[auth.hook.custom_access_token] uri is ${found.uri ?? "missing"}, but the generated hook is ${expected}`,
        fix: `set the uri to "${expected}" in ${file}`,
      },
    ];
  }
  return [];
}
