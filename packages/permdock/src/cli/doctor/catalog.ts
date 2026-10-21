import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";
import type { CliIo } from "../types.ts";

import { parseCatalog } from "../../catalog/parse.ts";
import { canonicalJson } from "../../core/canonical-json.ts";
import { catalogOAuthScopes } from "../catalog-doc.ts";
import { catalogPath } from "../catalog-path.ts";
import { rel } from "../files.ts";
import { filesOf } from "../shared/doctor-files.ts";
import { runUsage } from "../usage.ts";
import { collectedOf, policyOf } from "./inputs.ts";

/**
 * A policy that declares `oauthScopes` against a catalog on disk without them,
 * or with another set. `authorizationProvider` builds better-supabase's
 * `delegation.scopes` from the catalog, so its SQL checks deny a token that
 * holds only the coarse scope.
 */
export async function pd070(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const declared = (await policyOf(input))?.oauthScopes ?? [];
  if (declared.length === 0) {
    return [];
  }
  const files = filesOf(input);
  const path = catalogPath(input.config, input.cwd);
  if (!files.exists(path)) {
    return [];
  }
  let listed: unknown;
  try {
    listed = parseCatalog(files.read(path)).oauthScopes;
  } catch {
    return [];
  }
  const expected = catalogOAuthScopes(declared);
  if (
    listed !== undefined &&
    canonicalJson(listed) === canonicalJson(expected)
  ) {
    return [];
  }
  return [
    {
      code: "PD070",
      severity: "warning",
      message:
        listed === undefined
          ? `the policy declares oauthScopes (${expected.map(({ scope }) => scope).join(", ")}) and ${rel(input.cwd, path)} lists none, so better-supabase's SQL checks deny a token that holds only a coarse scope`
          : `${rel(input.cwd, path)} lists other oauthScopes than the policy declares`,
      fix: "pnpm exec permdock collect",
    },
  ];
}

export async function pd002(
  input: DoctorInput & { readonly now: Date; readonly io: CliIo },
): Promise<readonly DoctorFinding[]> {
  const collected = await collectedOf(input);
  if (collected.scan === undefined) {
    return [];
  }
  return collected.scan.unknown.map((usage) => ({
    code: "PD002",
    severity: "error" as const,
    message: `unknown permission ${usage.call} at ${usage.file}:${String(usage.line)}`,
    fix: "use a defined permission reference",
  }));
}

export async function pd003(
  input: DoctorInput & { readonly now: Date; readonly io: CliIo },
): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const usage = await runUsage({
    cwd: input.cwd,
    config: input.config,
    ignore: [],
    strict: false,
    json: true,
    dynamicAsUsed: false,
    now: input.now,
    io: input.io,
    collected: () => collectedOf(input),
    policy: () => policyOf(input),
  });
  if (usage.code === 2) {
    return [];
  }
  // SAFETY: runUsage with json: true and a code other than 2 prints its report with ungranted.
  const report = JSON.parse(usage.output) as {
    readonly ungranted: readonly {
      readonly key: string;
      readonly detail: string;
    }[];
  };
  return report.ungranted.map((item) => ({
    code: "PD003",
    severity: "warning" as const,
    message: `${item.key} is used but never granted (${item.detail})`,
    fix: "add an allow() with a to: selector, or a role() binding, in definePolicy",
  }));
}

export async function pd004(
  input: DoctorInput & { readonly now: Date; readonly io: CliIo },
): Promise<readonly DoctorFinding[]> {
  const collected = await collectedOf(input);
  if (collected.code === 0) {
    return [];
  }
  if (collected.code === 2) {
    return [];
  }
  return [
    {
      code: "PD004",
      severity: "error",
      message: collected.message,
      fix: "pnpm exec permdock collect",
    },
  ];
}

export async function pd067(
  input: DoctorInput & { readonly now: Date; readonly io: CliIo },
): Promise<readonly DoctorFinding[]> {
  if (input.config.operations === undefined) {
    return [];
  }
  const document = (await collectedOf(input)).document;
  if (document?.operations === undefined) {
    return [];
  }
  const declared = new Set(document.permissions.map(({ key }) => key));
  return document.operations.flatMap((operation) =>
    [
      ["permission", operation.permission] as const,
      ["results", operation.results] as const,
    ].flatMap(([field, key]) =>
      key === undefined || declared.has(key)
        ? []
        : [
            {
              code: "PD067",
              severity: "error" as const,
              message: `operation ${operation.name} has ${field} ${key}, which the permissions module does not declare`,
              fix: "pass the same permission tree to defineOperations and to permdock.config.ts permissions, or declare the permission",
            },
          ],
    ),
  );
}
