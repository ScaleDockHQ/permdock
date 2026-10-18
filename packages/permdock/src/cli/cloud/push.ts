import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SupabaseHookManifest } from "../../supabase/manifest.ts";
import type { CommandResult } from "../shared/result.ts";
import type { CliIo, PermDockConfig } from "../types.ts";

import { parseCatalog } from "../../catalog/parse.ts";
import { pushedPolicy } from "../../catalog/pushed-policy.ts";
import { catalogFingerprint } from "../../index.ts";
import { parseSupabaseManifest } from "../../supabase/manifest.ts";
import { runCatalog } from "../catalog.ts";
import { describeError } from "../errors.ts";
import { loadConfiguredPolicy } from "../load.ts";
import { MANIFEST_FILE } from "../manifest-json.ts";
import { cliVersion } from "../version.ts";
import { cliRuntime, pushAuth } from "./auth.ts";
import { cloudUrl, firstNonEmpty } from "./issuer.ts";
import { runCloudPull } from "./pull.ts";

export { pushedPolicy };

const USAGE =
  "usage: permdock cloud push [--dry-run] [--url <url>] [--environment <env> | --project <id>] [--manifest <file>]\n       permdock cloud pull [--project <id>] [--url <url>] [--manifest <file>]";

/** `--manifest`, else `permdock.manifest.json` when it exists; a file that does not parse is an error. */
function readManifest(
  cwd: string,
  flag: string | undefined,
):
  | { readonly ok: true; readonly manifest: SupabaseHookManifest | undefined }
  | { readonly ok: false; readonly output: string } {
  const path = resolve(cwd, flag ?? MANIFEST_FILE);
  if (!existsSync(path)) {
    return flag === undefined
      ? { ok: true, manifest: undefined }
      : { ok: false, output: `permdock cloud push: ${flag} does not exist` };
  }
  try {
    return {
      ok: true,
      manifest: parseSupabaseManifest(readFileSync(path, "utf8")),
    };
  } catch (error) {
    return {
      ok: false,
      output: `permdock cloud push: ${flag ?? MANIFEST_FILE} is not a valid manifest: ${describeError(error)}`,
    };
  }
}

export async function runCloud(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly rest: readonly string[];
  readonly url: string | undefined;
  readonly environment: string | undefined;
  readonly project?: string | undefined;
  readonly manifest?: string | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<CommandResult> {
  const action = input.rest[0];
  if (action === "pull") {
    return runCloudPull({
      cwd: input.cwd,
      config: input.config,
      url: input.url,
      project: input.project ?? input.environment,
      manifest: input.manifest,
      json: input.json,
      env: input.env,
      io: input.io,
    });
  }
  if (action !== "push") {
    return { code: 2, output: USAGE };
  }
  if (
    input.project !== undefined &&
    input.environment !== undefined &&
    input.project !== input.environment
  ) {
    return {
      code: 2,
      output:
        "permdock cloud push: --project and --environment name the same thing; pass one",
    };
  }
  const manifest = readManifest(input.cwd, input.manifest);
  if (!manifest.ok) {
    return { code: 2, output: manifest.output };
  }
  const built = await runCatalog({
    cwd: input.cwd,
    config: input.config,
    format: "json",
    from: undefined,
    include: [],
    now: input.now,
    io: input.io,
  });
  if (built.code !== 0) {
    return { code: built.code, output: built.output };
  }
  const catalog = parseCatalog(built.output);
  const fingerprint = catalogFingerprint(catalog);
  const loaded = await loadConfiguredPolicy(input.cwd, input.config.policy);
  const policy = loaded === undefined ? undefined : pushedPolicy(loaded);
  const hostable = catalog.permissions
    .filter((permission) => permission.hostable === true)
    .map((permission) => permission.key);
  const summary = {
    fingerprint,
    permissions: catalog.permissions.length,
    hostable,
    roles: (catalog.roles ?? []).length,
    plans: (catalog.plans ?? []).length,
    grants: policy?.grants.length ?? 0,
    manifest: manifest.manifest !== undefined,
  };
  const url = cloudUrl(input.url, input.env);
  const environment = firstNonEmpty(
    input.project,
    input.environment,
    input.env["PERMDOCK_CLOUD_ENV"],
    input.env["VERCEL_ENV"],
    "production",
  );
  const describe = (verb: string): string =>
    input.json
      ? JSON.stringify({ ...summary, environment, status: verb })
      : `${verb} catalog ${fingerprint} (${String(summary.permissions)} permissions, ${String(hostable.length)} hostable${summary.manifest ? ", with manifest" : ""}) to ${environment}`;
  if (input.dryRun) {
    return { code: 0, output: describe("would push") };
  }
  const auth = await pushAuth(url, input.env, cliRuntime(input.io, input.env));
  if (!auth.ok) {
    return { code: auth.code, output: auth.output };
  }
  const fetchFn = input.io.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchFn(
      `${url}/v1/environments/${encodeURIComponent(environment)}/catalog`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth.bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          fingerprint,
          catalog,
          ...(policy === undefined ? {} : { policy }),
          ...(manifest.manifest === undefined
            ? {}
            : { manifest: manifest.manifest }),
          permdockVersion: cliVersion(),
        }),
      },
    );
  } catch (error) {
    return {
      code: 1,
      output: `PermDock Cloud unreachable: ${describeError(error)}`,
    };
  }
  if (!response.ok) {
    return {
      code: 1,
      output: `PermDock Cloud rejected the catalog: HTTP ${String(response.status)}`,
    };
  }
  return { code: 0, output: describe("pushed") };
}
