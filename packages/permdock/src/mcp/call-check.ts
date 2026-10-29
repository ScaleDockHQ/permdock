import type { createAgentKernel } from "../agent/kernel.ts";
import type { ToolBinding } from "../agent/types.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy } from "../core/policy-types.ts";
import type { Context, McpCall, Reach } from "./mcp-auth.ts";
import type { Handler } from "./protect-server.ts";
import type { Checked, Refusal } from "./refusals.ts";
import type { McpAuthInfo, McpOnError, McpPermDockOptions } from "./types.ts";

import { refusalText } from "../agent/denied-text.ts";
import { compact } from "../core/compact.ts";
import { authorizationDetailsOf } from "../core/delegation-input.ts";
import { actorMayCallTool } from "../core/delegation.ts";
import {
  challengeScope,
  hasScope,
  scopesReaching,
} from "../core/oauth-scopes.ts";
import { decideAll } from "../server/decide-set.ts";
import { bearerChallenge } from "../server/problem.ts";
import {
  approvalTokenOf,
  contextOf,
  resourceMetadataOf,
  sameResource,
} from "./mcp-auth.ts";
import {
  approvalInput,
  approvalRefusal,
  deniedRefusal,
  failedRefusal,
  plainRefusal,
  stepUpRefusal,
  stillAllowed,
} from "./refusals.ts";
import { report, reportedTenant } from "./report.ts";

/**
 * What every MCP call check reads: the policy, the options it honours and the
 * agent kernel.
 */
export type McpChecks = {
  readonly policy: Policy;
  readonly options: Pick<
    McpPermDockOptions,
    | "resource"
    | "requireAuthInfo"
    | "approval"
    | "requestState"
    | "stepUp"
    | "deniedText"
    | "tenant"
    | "unscopedTokens"
  >;
  /** Every scope that reaches one of the policy's permissions. */
  readonly policyScopes: ReadonlySet<string>;
  readonly kernel: ReturnType<typeof createAgentKernel<McpCall>>;
  /** Receives an error a check threw; the refusal stays as PermDock built it. */
  readonly onError?: McpOnError;
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

/**
 * Whether `unscopedTokens: 'subject'` lets the subject alone decide this token:
 * it carries none of the policy's scopes and no `authorization_details`.
 */
export function decidesOnSubject(
  options: Pick<McpChecks["options"], "unscopedTokens">,
  policyScopes: ReadonlySet<string>,
  authInfo: McpAuthInfo,
): boolean {
  return (
    options.unscopedTokens === "subject" &&
    authorizationDetailsOf(authInfo.extra) === undefined &&
    !(authInfo.scopes ?? []).some((scope) => policyScopes.has(scope))
  );
}

function scoped(
  checks: McpChecks,
  authInfo: McpAuthInfo,
  reach: Reach,
): boolean {
  return (
    hasScope(authInfo.scopes, reach.scopes) ||
    decidesOnSubject(checks.options, checks.policyScopes, authInfo)
  );
}

function reachable(
  checks: McpChecks,
  authInfo: McpAuthInfo | undefined,
  reach: Reach,
): boolean {
  return authInfo === undefined
    ? checks.options.requireAuthInfo !== true
    : forThisServer(checks, authInfo) && scoped(checks, authInfo, reach);
}

/**
 * The refusal a token earns before any decision: none, the wrong resource, or a
 * missing scope.
 */
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
  if (scoped(checks, authInfo, reach)) {
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

/**
 * The completion re-check of a long-running tool: the call must still be
 * allowed, or approved with the same token.
 */
async function recheck(
  checks: McpChecks,
  binding: ToolBinding,
  args: readonly unknown[],
  call: McpCall,
  permission: Permission,
  approved: string | undefined,
  tool: string | undefined,
  onError: (error: unknown) => void,
): Promise<Checked> {
  const rechecked = await checks.kernel.check(
    binding,
    args,
    call,
    compact({ simulate: true, tool, onError }),
  );
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

/**
 * Sends the errors a check collected to the `onError` sink, after the check, so
 * the tenant resolves only when there is something to report.
 */
async function flush(
  checks: McpChecks,
  authInfo: McpAuthInfo | undefined,
  errors: readonly unknown[],
  permission: string | null,
  name: string,
): Promise<void> {
  if (errors.length === 0 || checks.onError === undefined) return;
  const tenant = await reportedTenant(checks.options.tenant, authInfo);
  for (const error of errors) {
    report(checks.onError, error, { permission, name, tenant });
  }
}

async function decideCall(
  checks: McpChecks,
  permission: Permission,
  reach: Reach,
  args: readonly unknown[],
  load: (() => unknown) | undefined,
  context: Context,
  handlerContext: unknown,
  capabilities: (() => unknown) | undefined,
  completion?: { readonly approved: string | undefined },
  tool?: string,
  name: string = tool ?? permission.key,
): Promise<Checked> {
  const authInfo = context.http?.authInfo;
  const errors: unknown[] = [];
  const onError = (error: unknown): void => {
    errors.push(error);
  };
  try {
    return await decided(
      checks,
      permission,
      reach,
      args,
      load,
      context,
      handlerContext,
      capabilities,
      completion,
      tool,
      onError,
    );
  } finally {
    await flush(checks, authInfo, errors, permission.key, name);
  }
}

async function decided(
  checks: McpChecks,
  permission: Permission,
  reach: Reach,
  args: readonly unknown[],
  load: (() => unknown) | undefined,
  context: Context,
  handlerContext: unknown,
  capabilities: (() => unknown) | undefined,
  completion: { readonly approved: string | undefined } | undefined,
  tool: string | undefined,
  onError: (error: unknown) => void,
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
    return recheck(
      checks,
      binding,
      args,
      call,
      permission,
      completion.approved,
      tool,
      onError,
    );
  }
  const checked = await checks.kernel.check(
    binding,
    args,
    call,
    compact({ resumeToken: approvalTokenOf(context), tool, onError }),
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
      } catch (error) {
        onError(error);
        return { ok: false, refusal: failedRefusal(permission, "failed") };
      }
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

/** `decideCall` with the refusal text replaced by `deniedText`'s. */
async function checkCall(
  checks: McpChecks,
  permission: Permission,
  reach: Reach,
  args: readonly unknown[],
  load: (() => unknown) | undefined,
  context: Context,
  handlerContext: unknown,
  capabilities: (() => unknown) | undefined,
  completion?: { readonly approved: string | undefined },
  tool?: string,
  name: string = tool ?? permission.key,
): Promise<Checked> {
  const checked = await decideCall(
    checks,
    permission,
    reach,
    args,
    load,
    context,
    handlerContext,
    capabilities,
    completion,
    tool,
    name,
  );
  const { deniedText } = checks.options;
  if (checked.ok || deniedText === undefined) {
    return checked;
  }
  const { refusal } = checked;
  return {
    ok: false,
    refusal: {
      ...refusal,
      text: refusalText(
        deniedText,
        { decision: refusal.decision ?? null, permission, text: refusal.text },
        (error) => {
          checks.kernel.report(refusal.permdock, error);
        },
      ),
    },
  };
}

/** What a guarded entry needs: every permission, or one with `anyOf`. */
export type Access = {
  readonly permissions: readonly Permission[];
  readonly anyOf: boolean;
};

export function single(permission: Permission | undefined): Access | undefined {
  return permission === undefined
    ? undefined
    : { permissions: [permission], anyOf: false };
}

/**
 * The keys a list shows: unguarded ones, and guarded ones the token reaches and
 * the subject may use. With `tools`, a guarded key is also a tool name an
 * `agent` actor's `tools` list must name.
 */
export async function visible(
  checks: McpChecks,
  context: Context,
  accessOf: (key: string) => Access | undefined,
  keys: readonly string[],
  declaredOf: (
    key: string,
  ) => readonly [string, ...string[]] | undefined = () => undefined,
  tools = false,
): Promise<ReadonlySet<string>> {
  const authInfo = context.http?.authInfo;
  const shown = new Set<string>();
  const guarded: { readonly key: string; readonly access: Access }[] = [];
  for (const key of keys) {
    const access = accessOf(key);
    if (access === undefined) {
      shown.add(key);
      continue;
    }
    const reached = access.permissions.filter((permission) =>
      reachable(
        checks,
        authInfo,
        reachOf(checks.policy, permission, declaredOf(key)),
      ),
    );
    if (
      access.anyOf
        ? reached.length > 0
        : reached.length === access.permissions.length
    ) {
      guarded.push({ key, access: { ...access, permissions: reached } });
    }
  }
  if (guarded.length === 0) {
    return shown;
  }
  let permdock: PermDock;
  try {
    permdock = await checks.kernel.instance(compact({ authInfo }));
  } catch (error) {
    // A subject that cannot be built sees no guarded entry.
    if (checks.onError !== undefined) {
      const tenant = await reportedTenant(checks.options.tenant, authInfo);
      for (const entry of guarded) {
        report(checks.onError, error, {
          permission: entry.access.permissions[0]?.key ?? null,
          name: entry.key,
          tenant,
        });
      }
    }
    return shown;
  }
  for (const entry of guarded) {
    const usable = (permission: Permission): boolean =>
      permdock.mayUse(permission);
    if (
      (!tools || actorMayCallTool(permdock.subject.actor, entry.key)) &&
      (entry.access.anyOf
        ? entry.access.permissions.some(usable)
        : entry.access.permissions.every(usable))
    ) {
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
  /** The tool's current name, for an `agent` actor's `tools` list. */
  readonly tool?: () => string;
  /** The tool, resource or prompt name an `onError` sink receives. */
  readonly name?: () => string;
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
    // The call's arguments: the loader reads them, and an approval binds them.
    const args = dataArgs(params);
    const loader =
      load === undefined ? undefined : (): unknown => load(...args);
    const reach = extra.reach ?? reachOf(checks.policy, permission, undefined);
    const tool = extra.tool?.();
    const name = extra.name?.() ?? tool ?? permission.key;
    const checked = await checkCall(
      checks,
      permission,
      reach,
      args,
      loader,
      context,
      raw,
      extra.capabilities,
      undefined,
      tool,
      name,
    );
    let result: unknown;
    if (checked.ok) {
      result = await handler(...params);
      if (extra.longRunning === true) {
        const again = await checkCall(
          checks,
          permission,
          reach,
          args,
          loader,
          context,
          raw,
          extra.capabilities,
          { approved: checked.approved },
          tool,
          name,
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

const FROM_DATA = Symbol("permdock.mcp.data");

export type SetLoaders = {
  readonly data?: ((...args: unknown[]) => unknown) | undefined;
  readonly rows?: ((...args: unknown[]) => unknown) | undefined;
};

/**
 * `handler` behind a check of every permission in `access` (or one, with
 * `anyOf`) over the row `data` loads or every row `rows` loads. Credentials are
 * checked before `rows` runs; a refusal goes to `onRefusal`.
 */
export function guardSet(
  checks: McpChecks,
  access: Access,
  loaders: SetLoaders,
  handler: Handler,
  dataArgs: (params: readonly unknown[]) => readonly unknown[],
  onRefusal: (refusal: Refusal) => unknown,
  extra: GuardExtra & {
    readonly declared?: readonly [string, ...string[]] | undefined;
  } = {},
): Handler {
  const { permissions, anyOf } = access;
  const [lead] = permissions;
  if (lead === undefined) {
    throw new TypeError("permdock/mcp: a guarded tool needs a permission");
  }
  const reachFor = (permission: Permission): Reach =>
    reachOf(checks.policy, permission, extra.declared);
  return async (...params: unknown[]): Promise<unknown> => {
    const raw = params.at(-1);
    const context = contextOf(raw);
    const authInfo = context.http?.authInfo;
    const args = dataArgs(params);
    const tool = extra.tool?.();
    const name = extra.name?.() ?? tool ?? lead.key;
    const refusals = permissions.map((permission) =>
      credentialRefusal(checks, permission, reachFor(permission), authInfo),
    );
    const blocked = anyOf
      ? refusals.every((refusal) => refusal !== undefined)
      : refusals.some((refusal) => refusal !== undefined);
    let result: unknown;
    const rows = blocked
      ? []
      : await loadRows(checks, loaders, args, authInfo, lead, name);
    const refusal = blocked
      ? refusals.find((entry) => entry !== undefined)
      : rows.length === 0
        ? plainRefusal(lead, `Denied: ${lead.key} found no rows.`, {})
        : await setRefusal(access, rows, (permission, row) =>
            checkCall(
              checks,
              permission,
              reachFor(permission),
              args,
              row === FROM_DATA
                ? loaders.data === undefined
                  ? undefined
                  : (): unknown => loaders.data?.(...args)
                : (): unknown => row,
              context,
              raw,
              extra.capabilities,
              undefined,
              tool,
              name,
            ),
          );
    if (refusal === undefined) {
      result = await handler(...params);
    } else {
      result = onRefusal(refusal);
    }
    await extra.after?.(context);
    return result;
  };
}

function isRowList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

async function loadRows(
  checks: McpChecks,
  loaders: SetLoaders,
  args: readonly unknown[],
  authInfo: McpAuthInfo | undefined,
  lead: Permission,
  name: string,
): Promise<readonly unknown[]> {
  if (loaders.rows === undefined) {
    return [FROM_DATA];
  }
  try {
    const rows: unknown = await loaders.rows(...args);
    return isRowList(rows) ? rows : [];
  } catch (error) {
    await flush(checks, authInfo, [error], lead.key, name);
    return [];
  }
}

async function setRefusal(
  access: Access,
  rows: readonly unknown[],
  check: (permission: Permission, row: unknown) => Promise<Checked>,
): Promise<Refusal | undefined> {
  const outcome = await decideAll(
    access.permissions,
    rows,
    access.anyOf,
    async (permission, batch) => {
      const results: Checked[] = [];
      for (const row of batch) {
        // Rows decide in order, so a limit is consumed once per granted row.
        // oxlint-disable-next-line eslint/no-await-in-loop
        results.push(await check(permission, row));
      }
      return results;
    },
    (checked) => checked.ok,
  );
  if (outcome.ok) {
    return undefined;
  }
  return outcome.result === undefined || outcome.result.ok
    ? plainRefusal(outcome.permission, `Denied: ${outcome.permission.key}.`, {})
    : outcome.result.refusal;
}
