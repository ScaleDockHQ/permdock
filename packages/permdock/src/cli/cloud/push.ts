import type { CommandResult } from "./shared/result.ts";
import type { CliIo, PermDockConfig } from "./types.ts";

import { parseCatalog } from "../catalog/parse.ts";
import { pushedPolicy } from "../catalog/pushed-policy.ts";
import { catalogFingerprint } from "../index.ts";
import { runCatalog } from "./catalog.ts";
import { describeError } from "./errors.ts";
import { loadConfiguredPolicy } from "./load.ts";

export { pushedPolicy };

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return "";
}

export async function runCloud(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly rest: readonly string[];
  readonly url: string | undefined;
  readonly environment: string | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<CommandResult> {
  const action = input.rest[0];
  if (action !== "push") {
    return {
      code: 2,
      output: `usage: permdock cloud push [--dry-run] [--url <url>] [--environment <env>]`,
    };
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
  };
  const url = firstNonEmpty(input.url, input.env["PERMDOCK_CLOUD_URL"]).replace(
    /\/$/u,
    "",
  );
  const environment = firstNonEmpty(
    input.environment,
    input.env["PERMDOCK_CLOUD_ENV"],
    input.env["VERCEL_ENV"],
    "production",
  );
  const describe = (verb: string): string =>
    input.json
      ? JSON.stringify({ ...summary, environment, status: verb })
      : `${verb} catalog ${fingerprint} (${String(summary.permissions)} permissions, ${String(hostable.length)} hostable) to ${environment}`;
  if (input.dryRun) {
    return { code: 0, output: describe("would push") };
  }
  const key = input.env["PERMDOCK_CLOUD_KEY"] ?? "";
  if (url === "" || key === "") {
    return {
      code: 2,
      output:
        "permdock cloud push needs PERMDOCK_CLOUD_URL (or --url) and PERMDOCK_CLOUD_KEY in the environment",
    };
  }
  const fetchFn = input.io.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchFn(
      `${url}/v1/environments/${encodeURIComponent(environment)}/catalog`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          policy === undefined
            ? { fingerprint, catalog }
            : { fingerprint, catalog, policy },
        ),
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
