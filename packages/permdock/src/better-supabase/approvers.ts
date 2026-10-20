import type { AuthorizationRequirement } from "better-supabase/config";

import type { CatalogDocument } from "../catalog/types.ts";
import type { ApproverInput } from "../core/approvers.ts";

import { asApprover } from "../core/approval-normalize.ts";
import { approverLeaves } from "../core/approvers.ts";
import { quoteSqlLiteral, sqlIdent } from "../core/sql.ts";

/**
 * Who may approve each better-supabase request kind: `'ai-tool'` (a tool
 * call), `'support-session'`, or `'<subject type>.<action>'` from the
 * approvals block.
 */
export type ProviderApprovers = Readonly<Record<string, ApproverInput>>;

/** `rls.approvals`' approver check, executable by `authenticated`. */
export const IS_APPROVER = "permdock_is_approver";

type IsApproverInput = {
  readonly approvers: ProviderApprovers;
  /** `rls.schema` as written in the manifest. */
  readonly schema: string;
  /** Whether the manifest's `rls.helpers` lists `permdock_is_approver`. */
  readonly listed: boolean;
  /**
   * Whether the listed helper takes `p_requester, p_resource`, which
   * `rls.approvals.delegations` writes. The template then passes
   * better-supabase's `{requester}`, so a delegate inside an active cover
   * matches.
   */
  readonly covers?: boolean;
  readonly tenantScope: string;
  readonly rootTenant: boolean;
  readonly catalog: CatalogDocument | undefined;
};

type IsApproverOutput = {
  readonly template?: string;
  readonly requires?: AuthorizationRequirement;
  readonly problems: readonly string[];
};

/** The resource a cover's `resources` names for a request kind: `job` for `job.update`, else the kind. */
function resourceOf(kind: string): string {
  const dot = kind.indexOf(".");
  return dot <= 0 ? kind : kind.slice(0, dot);
}

/**
 * better-supabase's `isApprover` template: one `case` over `{kind}` whose
 * branches call `permdock_is_approver` with the kind's approvers as JSON.
 * A kind with no branch is `false`. Only `user`, `holder` and `anyOf`
 * approvers match in SQL; other leaves are reported and match nobody.
 */
export function isApproverTemplate(input: IsApproverInput): IsApproverOutput {
  const problems: string[] = [];
  if (!input.listed) {
    return {
      problems: [
        `approvers needs ${input.schema}.${IS_APPROVER}, which \`permdock rls generate\` writes with rls.approvals. Run it, then \`permdock supabase inspect --out\`.`,
      ],
    };
  }
  const fn = `${sqlIdent(input.schema)}.${sqlIdent(IS_APPROVER)}`;
  const keys =
    input.catalog === undefined
      ? undefined
      : new Set(input.catalog.permissions.map((permission) => permission.key));
  const branches: string[] = [];
  for (const [kind, given] of Object.entries(input.approvers)) {
    if (kind === "") {
      problems.push("approvers has an empty kind, which no request has.");
      continue;
    }
    const approvers = asApprover(given);
    for (const leaf of approverLeaves(approvers)) {
      if (leaf.kind === "user") continue;
      if (leaf.kind !== "permission") {
        problems.push(
          `The ${kind} approvers name a ${leaf.kind} approver, which ${IS_APPROVER} cannot check in SQL, so it matches nobody. Use user(), holder() or anyOf().`,
        );
      } else if (keys !== undefined && !keys.has(leaf.permission)) {
        problems.push(
          `The ${kind} approver permission ${leaf.permission} is not in the catalog. Run \`permdock catalog\` after adding it to the policy.`,
        );
      }
    }
    const json = `${quoteSqlLiteral(JSON.stringify(approvers))}::jsonb`;
    branches.push(
      input.covers === true
        ? `when ${quoteSqlLiteral(kind)} then ${fn}(${json}, ({tenant})::text, ({requester})::text, ${quoteSqlLiteral(resourceOf(kind))})`
        : `when ${quoteSqlLiteral(kind)} then ${fn}(${json}, ({tenant})::text)`,
    );
  }
  if (branches.length === 0) {
    problems.push("approvers names no kind, so isApprover is not set.");
    return { problems };
  }
  if (!input.rootTenant) {
    problems.push(
      `The tenant scope "${input.tenantScope}" is not a root scope, and ${IS_APPROVER} checks holder() approvers at the root scope, so they match nobody.`,
    );
  }
  return {
    template: `case {kind} ${branches.join(" ")} else false end`,
    requires: {
      function: fn,
      args: input.covers === true ? "jsonb, text, text, text" : "jsonb, text",
      role: "postgres",
    },
    problems,
  };
}
