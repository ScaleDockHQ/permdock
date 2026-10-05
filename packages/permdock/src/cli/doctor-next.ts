import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Grant, Policy } from "../index.ts";
import type { DoctorFinding } from "./doctor-types.ts";
import type { CliIo, PermDockConfig } from "./types.ts";

import { hasConditionOp } from "../conditions/ast.ts";
import { flattenGrantee } from "../core/grantee.ts";
import { isPrincipalRelation } from "../core/permissions.ts";
import { runCollect } from "./collect.ts";
import { doctorSrcPath, listSourceFiles, rel } from "./files.ts";
import { asPolicy, loadModule, pickNamed } from "./load.ts";

const ROUTE_GLOBS = ["**/api/permdock/route.{ts,tsx,js,jsx,mjs}"];
const ENDPOINT = /\bendpoint\s*(?::|=)\s*\{?\s*['"`]/u;

/** A grant the snapshot marks `portable: false`, so a client check needs the endpoint. */
function serverOnly(policy: Policy, grant: Grant): boolean {
  if (!grant.portable || hasConditionOp(grant.where, "related")) {
    return true;
  }
  const relations = policy.resources.get(grant.permission.resource)?.relations;
  return flattenGrantee(grant.to).some((item) => {
    if (item.kind !== "relation") {
      return false;
    }
    const spec = relations?.[item.relation];
    return (
      item.through !== undefined ||
      (isPrincipalRelation(spec) && spec.period !== undefined)
    );
  });
}

function serverOnlyKeys(policy: Policy): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const grant of [
    ...policy.grants,
    ...policy.roles.flatMap((binding) => binding.grants),
  ]) {
    if (
      grant.hosted === undefined &&
      grant.effect === "allow" &&
      serverOnly(policy, grant)
    ) {
      keys.add(grant.permission.key);
    }
  }
  return keys;
}

/** An `app/**\/api/permdock/route.ts` that exports `permdockHandler`'s result, or an `endpoint` string in the source. */
function hasEndpoint(cwd: string, sources: readonly string[]): boolean {
  const routes = listSourceFiles(cwd, ROUTE_GLOBS).filter((file) =>
    /(?:^|[\\/])app[\\/]/u.test(rel(cwd, file)),
  );
  if (
    routes.some((file) =>
      readFileSync(file, "utf8").includes("permdockHandler"),
    )
  ) {
    return true;
  }
  return sources.some((file) => ENDPOINT.test(readFileSync(file, "utf8")));
}

/**
 * PD044: `usePermission` reads a permission whose grant the snapshot cannot
 * answer, and the app has no endpoint to ask, so the client always denies it.
 */
export async function pd044(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  let policy: Policy;
  try {
    policy = asPolicy(
      pickNamed(await loadModule(resolve(input.cwd, input.config.policy)), [
        "policy",
      ]),
    );
  } catch {
    return [];
  }
  const keys = serverOnlyKeys(policy);
  if (keys.size === 0) {
    return [];
  }
  const srcPath = doctorSrcPath(input.config);
  const collected = await runCollect({
    cwd: input.cwd,
    config: input.config,
    collect: input.config.collect ?? {},
    scanPath: srcPath,
    check: true,
    now: input.now,
    io: input.io,
  });
  const usages = collected.scan?.usages ?? {};
  const hooked = [...keys]
    .toSorted()
    .flatMap((key) =>
      (usages[key] ?? [])
        .filter((usage) => usage.call === "usePermission")
        .map((usage) => ({ key, usage })),
    );
  if (hooked.length === 0) {
    return [];
  }
  const sources = listSourceFiles(input.cwd, srcPath);
  if (hasEndpoint(input.cwd, sources)) {
    return [];
  }
  return hooked.map(({ key, usage }) => ({
    code: "PD044",
    severity: "warning" as const,
    message: `usePermission reads ${key} at ${usage.file}:${String(usage.line)}, whose grant needs the server (a closure, graph relation or period), and no app/**/api/permdock/route.ts exports permdockHandler and no endpoint is configured: the client always answers denied (server-only)`,
    fix: "add app/api/permdock/route.ts exporting permdockHandler(), pass endpoint to createPermDock, or check it on the server with getPermission",
  }));
}
