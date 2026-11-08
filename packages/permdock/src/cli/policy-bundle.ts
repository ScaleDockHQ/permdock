import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Policy } from "../index.ts";
import type { CommandResult } from "./core/result.ts";
import type { PermDockConfig } from "./types.ts";

import { applyFiles, fileSummary } from "./core/files.ts";
import { buildContext } from "./rls/generate-context.ts";
import { generateOptions, isRefusal } from "./rls/generate-options.ts";
import { inheritTargets } from "./rls/rows.ts";
import { compileGrants } from "./sql/compile.ts";
import {
  bundleLoaderSql,
  POLICY_BUNDLE_FORMAT,
  POLICY_BUNDLE_VERSION,
  policyBundle,
} from "./sql/policy-bundle.ts";
import { tableNames } from "./sql/tables.ts";

export type PolicyBundleKind = "bundle" | "sql";

export type PolicyBundleInput = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly policy: Policy;
  readonly kind: PolicyBundleKind;
  readonly out: string | undefined;
  readonly check: boolean;
  readonly dryRun: boolean;
};

/**
 * Compiles the policy's static grants the way `rls generate` does, so the
 * bundle holds the rows the inline form would seed.
 */
function compileBundle(
  config: PermDockConfig,
  policy: Policy,
  cwd: string,
): {
  readonly bundle: ReturnType<typeof policyBundle>;
  readonly rows: number;
  readonly loader: (kind: PolicyBundleKind) => string;
} {
  const rls = config.rls;
  const generate = {
    cwd,
    config,
    target: "sql",
    dialect: rls?.dialect ?? "supabase",
    rbac: false,
    check: false,
    skipClosures: true,
    inlineFunctions: false,
    io: { stdout: () => undefined, stderr: () => undefined },
  } as const;
  const options = generateOptions(generate);
  if (isRefusal(options)) {
    throw new TypeError(options.refusal);
  }
  const built = buildContext(generate, policy, options);
  if (isRefusal(built)) {
    throw new TypeError(built.refusal);
  }
  const compiled = compileGrants(
    policy,
    built.ctx,
    tableNames(rls?.tables),
    [],
    true,
    rls?.rowHelpers !== undefined || inheritTargets(policy).length > 0,
  );
  const bundle = policyBundle(compiled.rolePermissions);
  return {
    bundle,
    rows: compiled.rolePermissions.length,
    loader: (kind) =>
      kind === "bundle"
        ? `${bundle.text}\n`
        : `-- permdock policy bundle ${bundle.hash}\n${bundleLoaderSql(built.ctx, bundle)}\n`,
  };
}

/**
 * Prints the bundle or its loader SQL, or writes it to `out`. `--check`
 * compares `out` with the policy and writes nothing.
 */
export function runPolicyBundle(input: PolicyBundleInput): CommandResult {
  const { bundle, rows, loader } = compileBundle(
    input.config,
    input.policy,
    input.cwd,
  );
  const text = loader(input.kind);
  const data = {
    format: POLICY_BUNDLE_FORMAT,
    v: POLICY_BUNDLE_VERSION,
    kind: input.kind,
    hash: bundle.hash,
    rows,
    ...(input.out === undefined ? {} : { out: input.out }),
  };
  if (input.out === undefined) {
    return { code: 0, output: text, data };
  }
  if (input.check) {
    const path = resolve(input.cwd, input.out);
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const stale = current !== text;
    return {
      code: stale ? 1 : 0,
      output: stale
        ? `${input.out} is stale: the policy bundle is ${bundle.hash}; run permdock policy bundle --out ${input.out}`
        : `${input.out} is up to date (${bundle.hash})`,
      data: { ...data, stale },
    };
  }
  const applied = applyFiles(input.cwd, [{ path: input.out, text }], {
    dryRun: input.dryRun,
  });
  return {
    code: 0,
    output: `${fileSummary(applied, input.dryRun)}\n${bundle.hash}`,
    data,
  };
}
