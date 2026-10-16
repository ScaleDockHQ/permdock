import type { HostedGrantDropReason, PolicyDocument } from "../core/hosted.ts";
import type { Policy } from "../core/policy-types.ts";
import type {
  CatalogEventData,
  CatalogFinding,
  CatalogFindingCode,
} from "../core/sink.ts";
import type { CatalogDocument } from "./types.ts";

import { freezeDeep } from "../core/freeze.ts";
import { hostedGrantDrops } from "../core/hosted.ts";
import { operationFindings } from "./operation-findings.ts";

/** The finding a drop reason becomes; `null` for a reason the catalog did not cause. */
function findingCode(reason: HostedGrantDropReason): CatalogFindingCode | null {
  switch (reason) {
    case "unknown-permission":
      return "permission-removed";
    case "not-hostable":
      return "not-hostable";
    case "unknown-grantee":
      return "grantee-removed";
    case "weaker-approval":
      return "approval-tightened";
    case "non-portable":
    case "invalid":
      return null;
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

/**
 * The hosted grants of `document` that `policy` no longer accepts, as drift
 * findings with the grant id set. A grant dropped for a reason the catalog
 * cannot cause (`non-portable`, `invalid`) is not a finding.
 */
export function hostedGrantFindings(
  policy: Policy,
  document: PolicyDocument | null,
): readonly CatalogFinding[] {
  if (document === null) {
    return [];
  }
  return hostedGrantDrops(policy, document).flatMap(
    (drop): CatalogFinding[] => {
      const code = findingCode(drop.reason);
      return code === null
        ? []
        : [
            freezeDeep({
              code,
              permission: drop.permission,
              ...(drop.grant === "" ? {} : { grant: drop.grant }),
            }),
          ];
    },
  );
}

export type CatalogDriftInput = {
  readonly previous: CatalogDocument;
  readonly next: CatalogDocument;
  /** The policy rebuilt from `next` (`policyFromCatalog`), which live hosted grants must still pass. */
  readonly policy: Policy;
  /** The live hosted grants; absent or `null` when the environment has none. */
  readonly document?: PolicyDocument | null;
};

/**
 * The `data` of a `com.permdock.catalog.drifted` event: the hosted grants
 * `next` breaks, then the operations whose risk rose or whose approval was
 * removed between `previous` and `next`.
 */
export function catalogDrift(input: CatalogDriftInput): CatalogEventData {
  const findings = [
    ...hostedGrantFindings(input.policy, input.document ?? null),
    ...operationFindings(input.previous, input.next),
  ];
  return freezeDeep({
    kind: "drift" as const,
    fingerprint: input.next.fingerprint ?? "",
    ...(input.previous.fingerprint === undefined
      ? {}
      : { previous: input.previous.fingerprint }),
    findings,
  });
}
