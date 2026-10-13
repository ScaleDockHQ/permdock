import type { createAgentKernel } from "../agent/kernel.ts";
import type { ToolBinding } from "../agent/types.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy } from "../core/policy-types.ts";
import type { Handler } from "./protect-server.ts";
import type { McpAuthInfo, McpPermDockOptions } from "./types.ts";

import { deniedText } from "../agent/denied-text.ts";
import { compact } from "../core/compact.ts";
import {
  challengeScope,
  hasScope,
  scopesReaching,
} from "../core/oauth-scopes.ts";
import { bearerChallenge } from "../server/problem.ts";
import {
  type Context,
  type McpCall,
  type Reach,
  approvalTokenOf,
  contextOf,
  resourceMetadataOf,
  sameResource,
} from "./mcp-auth.ts";
import {
  type Checked,
  type Refusal,
  approvalInput,
  approvalRefusal,
  deniedRefusal,
  failedRefusal,
  plainRefusal,
  stepUpRefusal,
  stillAllowed,
} from "./refusals.ts";

/** What every MCP call check reads: the policy, the options it honours and the agent kernel. */
export type McpChecks = {
  readonly policy: Policy;
  readonly options: Pick<
    McpPermDockOptions,
    | "resource"
    | "requireAuthInfo"
    | "approval"
    | "requestState"
    | "stepUp"
    | "onDenied"
  >;
  readonly kernel: ReturnType<typeof createAgentKernel<McpCall>>;
};

export function reachOf(
  policy: Policy,
  permission: Permission,
  declared: readonly [string, ...string[]] | undefined,
): Reach {
  return declared === undefined
    ? {
        scopes: scopesReaching(policy, permission),
        challenge: challengeScope(policy, permission),
      }
    : { scopes: declared, challenge: declared[0] };
}

function forThisServer(checks: McpChecks, authInfo: McpAuthInfo): boolean {
  return (
    checks.options.resource === undefined ||
    sameResource(checks.options.resource, authInfo.resource)
  );
}

function reachable(
  checks: McpChecks,
  authInfo: McpAuthInfo | undefined,
  reach: Reach,
): boolean {
  return authInfo === undefined
    ? checks.options.requireAuthInfo !== true
    : forThisServer(checks, authInfo) &&
        hasScope(authInfo.scopes, reach.scopes);
}

/** The refusal a token earns before any decision: none, the wrong resource, or a missing scope. */
function credentialRefusal(
  checks: McpChecks,
  permission: Permission,
  reach: Reach,
  authInfo: McpAuthInfo | undefined,
): Refusal | undefined {
  if (authInfo === undefined) {
    return checks.options.requireAuthInfo === true
      ? plainRefusal(permission, "Denied: no verified credentials.", {
          error: "invalid_token",
        })
      : undefined;
  }
  if (!forThisServer(checks, authInfo)) {
    return plainRefusal(
      permission,
      "Denied: the token was not issued for this server.",
      { error: "invalid_token" },
    );
  }
  if (hasScope(authInfo.scopes, reach.scopes)) {
    return undefined;
  }
  const resourceMetadata = resourceMetadataOf(authInfo);
  const challenged = reach.challenge;
  return plainRefusal(
    permission,
    `Denied: ${permission.key} needs the ${challenged} scope.`,
    compact({
      error: "insufficient_scope",
      scope: challenged,
      resource_metadata: resourceMetadata,
      www_authenticate: bearerChallenge(
        compact({
          error: "insufficient_scope" as const,
          scopes: [challenged],
          resourceMetadata,
        }),
      ),
    }),
  );
}

/** The completion re-check of a long-running tool: the call must still be allowed, or approved with the same token. */
async function recheck(
  checks: McpChecks,
  binding: ToolBinding,
  call: McpCall,
  permission: Permission,
  approved: string | undefined,
): Promise<Checked> {
  const rechecked = await checks.kernel.check(binding, undefined, call, {
    simulate: true,
  });
  if (!rechecked.ok) {
    return { ok: false, refusal: failedRefusal(permission, rechecked.failure) };
  }
  if (stillAllowed(rechecked.raw, approved)) {
    return { ok: true };
  }
  return {
    ok: false,
    refusal:
      rechecked.raw.outcome === "denied"
        ? {
            ...deniedRefusal(rechecked.raw, permission, rechecked.data),
            decision: rechecked.raw,
            permdock: rechecked.permdock,
          }
        : plainRefusal(
            permission,
            `Denied: ${permission.key} was revoked before the call completed.`,
            {},
          ),
  };
}

async function decideCall(
  checks: McpChecks,
  permission: Permission,
  reach: Reach,
  load: (() => unknown) | undefined,
  context: Context,
  handlerContext: unknown,
  capabilities: (() => unknown) | undefined,
  completion?: { readonly approved: string | undefined },
): Promise<Checked> {
  const authInfo = context.http?.authInfo;
  const refused = credentialRefusal(checks, permission, reach, authInfo);
  if (refused !== undefined) {
    return { ok: false, refusal: refused };
  }
  const binding = compact<ToolBinding>({
    permission,
    data: load === undefined ? undefined : (): unknown => load(),
  });
  const call: McpCall = compact({ authInfo });
  if (completion !== undefined) {
    return recheck(checks, binding, call, permission, completion.approved);
  }
  const checked = await checks.kernel.check(
    binding,
    undefined,
    call,
    compact({ resumeToken: approvalTokenOf(context) }),
  );
  if (!checked.ok) {
    return { ok: false, refusal: failedRefusal(permission, checked.failure) };
  }
  const { raw, decision, data } = checked;
  switch (decision.outcome) {
    case "granted":
      return raw.outcome === "approval-required"
        ? { ok: true, approved: raw.token }
        : { ok: true };
    case "denied":
      return {
        ok: false,
        refusal: {
          ...(decision.denials.some(
            (denial) => denial.reason === "insufficient-user-authentication",
          )
            ? stepUpRefusal(
                checks.options.stepUp?.at,
                decision,
                permission,
                data,
                context,
                capabilities,
              )
            : deniedRefusal(decision, permission, data)),
          decision,
          permdock: checked.permdock,
        },
      };
    case "approval-required":
      try {
        return {
          ok: false,
          refusal: compact<Refusal>({
            ...approvalRefusal(decision, permission, data),
            decision,
            permdock: checked.permdock,
            inputRequired: await approvalInput(
              checks.options,
              decision,
              handlerContext,
              context,
              capabilities,
            ),
          }),
        };
      } catch {
        return { ok: false, refusal: failedRefusal(permission, "failed") };
      }
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

/** `decideCall` with the refusal text replaced by `onDenied`'s. */
async function checkCall(
  checks: McpChecks,
  permission: Permission,
  reach: Reach,
  load: (() => unknown) | undefined,
  context: Context,
  handlerContext: unknown,
  capabilities: (() => unknown) | undefined,
  completion?: { readonly approved: string | undefined },
): Promise<Checked> {
  const checked = await decideCall(
    checks,
    permission,
    reach,
    load,
    context,
    handlerContext,
    capabilities,
    completion,
  );
  const { onDenied } = checks.options;
  if (checked.ok || onDenied === undefined) {
    return checked;
  }
  const { refusal } = checked;
  return {
    ok: false,
    refusal: {
      ...refusal,
      text: deniedText(
        onDenied,
        {
          decision: refusal.decision ?? null,
          permission,
          text: refusal.text,
        },
        (error) => {
          checks.kernel.report(refusal.permdock, error);
        },
      ),
    },
  };
}

/** The keys a list shows: unguarded ones, and guarded ones the token reaches and the subject may use. */
export async function visible(
  checks: McpChecks,
  context: Context,
  permissionOf: (key: string) => Permission | undefined,
  keys: readonly string[],
  declaredOf: (
    key: string,
  ) => readonly [string, ...string[]] | undefined = () => undefined,
): Promise<ReadonlySet<string>> {
  const authInfo = context.http?.authInfo;
  const shown = new Set<string>();
  const guarded: {
    readonly key: string;
    readonly permission: Permission;
  }[] = [];
  for (const key of keys) {
    const permission = permissionOf(key);
    if (permission === undefined) {
      shown.add(key);
    } else if (
      reachable(
        checks,
        authInfo,
        reachOf(checks.policy, permission, declaredOf(key)),
      )
    ) {
      guarded.push({ key, permission });
    }
  }
  if (guarded.length === 0) {
    return shown;
  }
  let permdock: PermDock;
  try {
    permdock = await checks.kernel.instance(compact({ authInfo }));
  } catch {
    // A subject that cannot be built sees no guarded entry.
    return shown;
  }
  for (const entry of guarded) {
    if (permdock.mayUse(entry.permission)) {
      shown.add(entry.key);
    }
  }
  return shown;
}

export type GuardExtra = {
  readonly after?: (context: Context) => Promise<void>;
  readonly longRunning?: boolean;
  readonly capabilities?: () => unknown;
  readonly reach?: Reach;
};

/** `handler` behind the call check; a refusal goes to `onRefusal` instead. */
export function guard(
  checks: McpChecks,
  permission: Permission,
  load: ((...args: unknown[]) => unknown) | undefined,
  handler: Handler,
  dataArgs: (params: readonly unknown[]) => readonly unknown[],
  onRefusal: (refusal: Refusal) => unknown,
  extra: GuardExtra = {},
): Handler {
  return async (...params: unknown[]): Promise<unknown> => {
    const raw = params.at(-1);
    const context = contextOf(raw);
    const loader =
      load === undefined ? undefined : (): unknown => load(...dataArgs(params));
    const reach = extra.reach ?? reachOf(checks.policy, permission, undefined);
    const checked = await checkCall(
      checks,
      permission,
      reach,
      loader,
      context,
      raw,
      extra.capabilities,
    );
    let result: unknown;
    if (checked.ok) {
      result = await handler(...params);
      if (extra.longRunning === true) {
        const again = await checkCall(
          checks,
          permission,
          reach,
          loader,
          context,
          raw,
          extra.capabilities,
          { approved: checked.approved },
        );
        if (!again.ok) {
          result = onRefusal(again.refusal);
        }
      }
    } else {
      result = onRefusal(checked.refusal);
    }
    await extra.after?.(context);
    return result;
  };
}
