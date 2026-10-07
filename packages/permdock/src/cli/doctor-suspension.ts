import type { DoctorFinding, DoctorInput } from "./doctor-types.ts";

import { formerKeys, listPermissions } from "../core/permissions.ts";
import { keptKeys } from "../supabase/keep.ts";
import { policyOf } from "./doctor-collect.ts";

/**
 * PD061: a suspended scope keeps permissions. Each scope's kept keys are
 * listed for review, since its members hold them while the instance is
 * suspended, and a key the definitions do not declare is named apart.
 */
export async function pd061(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const scopes = Object.entries(input.config.rls?.suspension?.scopes ?? {});
  const kept = scopes.flatMap(
    ([scope, row]): {
      readonly scope: string;
      readonly keys: readonly string[];
      readonly invalid?: true;
    }[] => {
      try {
        const keys = keptKeys(row);
        return keys.length === 0 ? [] : [{ scope, keys }];
      } catch {
        return [{ scope, keys: [], invalid: true }];
      }
    },
  );
  if (kept.length === 0) {
    return [];
  }
  const policy = await policyOf(input);
  const declared = new Set<string>();
  const former = new Map<string, string>();
  for (const leaf of policy === undefined
    ? []
    : listPermissions(policy.permissions)) {
    declared.add(leaf.key);
    for (const old of formerKeys(leaf)) {
      former.set(old, leaf.key);
    }
  }
  return kept.flatMap((item): DoctorFinding[] => {
    if (item.invalid === true) {
      return [
        {
          code: "PD061",
          severity: "warning",
          message: `rls.suspension.scopes.${item.scope}.keep has an entry that is neither a permission nor a permission key, so generate refuses it`,
          fix: "list permission references or their keys in keep",
        },
      ];
    }
    const findings: DoctorFinding[] = [
      {
        code: "PD061",
        severity: "warning",
        message: `members of a suspended ${item.scope} still hold ${item.keys.join(", ")}`,
        fix: `keep only what a suspended ${item.scope} must still do, such as restoring it or cancelling its deletion, in rls.suspension.scopes.${item.scope}.keep`,
      },
    ];
    if (policy === undefined) {
      return findings;
    }
    const unknown = item.keys.filter((key) => !declared.has(key));
    if (unknown.length > 0) {
      findings.push({
        code: "PD061",
        severity: "warning",
        message: `rls.suspension.scopes.${item.scope}.keep names ${unknown
          .map((key) =>
            former.has(key)
              ? `${key} (renamed to ${String(former.get(key))})`
              : key,
          )
          .join(
            ", ",
          )}, which the definitions do not declare, so a suspended ${item.scope} keeps nothing for them`,
        fix: "keep permission references instead of keys, or replace each key with its current name",
      });
    }
    return findings;
  });
}
