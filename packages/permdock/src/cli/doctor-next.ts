import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Grant, Policy } from "../index.ts";
import type { DoctorFinding, DoctorInput } from "./doctor-types.ts";
import type { CliIo } from "./types.ts";

import { hasConditionOp } from "../conditions/ast.ts";
import { flattenGrantee } from "../core/grantee.ts";
import { isPrincipalRelation } from "../core/permissions.ts";
import { collectedOf, policyOf } from "./doctor-collect.ts";
import { doctorSrcPath, listSourceFiles, rel } from "./files.ts";

const ROUTE_GLOBS = ["**/api/permdock/route.{ts,tsx,js,jsx,mjs}"];
const ENDPOINT = /\bendpoint\s*(?::|=)\s*\{?\s*['"`]/u;
const NATIVE_IMPORT = /\bfrom\s*['"]permdock\/react-native['"]/u;
const CLIENT_READS = new Set(["usePermission", "reference"]);

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
export async function pd044(
  input: DoctorInput & { readonly now: Date; readonly io: CliIo },
): Promise<readonly DoctorFinding[]> {
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const keys = serverOnlyKeys(policy);
  if (keys.size === 0) {
    return [];
  }
  const collected = await collectedOf(input);
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
  const sources = listSourceFiles(input.cwd, doctorSrcPath(input.config));
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

/**
 * PD065: a file that imports `permdock/react-native` reads a permission whose
 * grant the snapshot cannot answer, so the device answers it only online.
 */
export async function pd065(
  input: DoctorInput & { readonly now: Date; readonly io: CliIo },
): Promise<readonly DoctorFinding[]> {
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const keys = serverOnlyKeys(policy);
  if (keys.size === 0) {
    return [];
  }
  const collected = await collectedOf(input);
  const usages = collected.scan?.usages ?? {};
  const native = new Map<string, boolean>();
  const isNative = (file: string): boolean => {
    let hit = native.get(file);
    if (hit === undefined) {
      try {
        hit = NATIVE_IMPORT.test(readFileSync(join(input.cwd, file), "utf8"));
      } catch {
        hit = false;
      }
      native.set(file, hit);
    }
    return hit;
  };
  return [...keys].toSorted().flatMap((key) =>
    (usages[key] ?? [])
      .filter((usage) => CLIENT_READS.has(usage.call) && isNative(usage.file))
      .map((usage) => ({
        code: "PD065",
        severity: "warning" as const,
        message: `React Native code reads ${key} at ${usage.file}:${String(usage.line)}, whose grant needs the server (a closure, graph relation or period): offline the device answers denied (server-only)`,
        fix: "express the grant with a portable condition if the screen must work offline, or show the offline state for it",
      })),
  );
}
