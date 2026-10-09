import type { Decision } from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { Delegation, Principal } from "../core/subject.ts";
import type { Boundary } from "../core/validation.ts";
import type {
  AgentKernelOptions,
  CheckOptions,
  CheckResult,
  DecideToolOptions,
  ToolBinding,
  ToolVerdict,
} from "./types.ts";

import { resumeDecision, storedApprovalToken } from "../approvals/helpers.ts";
import { actorFrom, tenantScope } from "../core/adapter-context.ts";
import { compact } from "../core/compact.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { mayUse } from "../core/may-use.ts";
import { createPermDock as createCorePermDock } from "../core/permdock.ts";
import { resourceRef } from "../core/resource-ref.ts";
import { modelReason, thrownReason, unmappedReason } from "./reason.ts";

/** The resume token an agent run carries under the namespaced `permdockApproval` key. */
export function approvalTokenOf(context: unknown): string | undefined {
  if (context === null || typeof context !== "object") {
    return undefined;
  }
  // SAFETY: checked above to be a non-null object; the token is typeof-checked below.
  const token = (context as { readonly permdockApproval?: unknown })
    .permdockApproval;
  return typeof token === "string" && token !== "" ? token : undefined;
}

function runDecide(
  permdock: PermDock,
  permission: Permission,
  data: unknown,
  how: {
    readonly adapter: string;
    readonly boundary: Boundary;
    readonly source: "adapter" | "simulate";
  },
): Decision {
  // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
  return (
    permdock.decide as (
      next: Permission,
      row?: unknown,
      decideOptions?: {
        readonly source: "adapter" | "simulate";
        readonly adapter: string;
        readonly boundary: Boundary;
      },
    ) => Decision
  )(permission, data, how);
}

export function createAgentKernel<
  TContext,
  TUser = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, Principal, V>,
  options: AgentKernelOptions<TContext, TUser>,
): {
  /** One instance per context object while a call is in flight; later calls re-read the subject. */
  readonly instance: (context: TContext) => Promise<PermDock<V>>;
  readonly decideTool: (
    toolName: string,
    args: unknown,
    context: TContext,
    decideOptions?: DecideToolOptions,
  ) => Promise<ToolVerdict>;
  readonly evaluate: (
    binding: ToolBinding,
    toolName: string,
    args: unknown,
    context: TContext,
    decideOptions?: DecideToolOptions,
  ) => Promise<ToolVerdict>;
  /**
   * Builds the instance, loads and checks the row, decides and resumes an
   * approval. Never throws: a throwing loader, a missing row and any other
   * error come back as a failure, which denies.
   */
  readonly check: (
    binding: ToolBinding,
    args: unknown,
    context: TContext,
    checkOptions?: CheckOptions,
  ) => Promise<CheckResult<V>>;
  /** The approval token a call would park under, without touching the store. */
  readonly tokenFor: (
    binding: ToolBinding,
    args: unknown,
    context: TContext,
  ) => Promise<string | undefined>;
  readonly allowedToolNames: (
    context: TContext,
  ) => Promise<ReadonlySet<string>>;
} {
  const cache = new WeakMap<object, Promise<PermDock<V>>>();

  const instance = (context: TContext): Promise<PermDock<V>> => {
    if (typeof context === "object" && context !== null) {
      const hit = cache.get(context);
      if (hit !== undefined) {
        return hit;
      }
    }
    const built = (async (): Promise<PermDock<V>> => {
      let user: TUser | null = null;
      try {
        user = await options.subject(context);
      } catch {
        user = null;
      }
      const actor = await actorFrom(options.actor, context);
      let delegation: Delegation | undefined;
      if (options.delegation !== undefined) {
        try {
          delegation = await options.delegation(context);
        } catch {
          delegation = undefined;
        }
      }
      const { tenant } = await tenantScope(options.tenant, context);
      const created = await createCorePermDock(
        policy,
        user,
        compact({
          tenant,
          actor,
          delegation,
          ...instanceOptions(options),
        }),
      );
      // SAFETY: wrap returns the instance it was given, decorated; the vocabulary is unchanged.
      return (options.wrap?.(created) ?? created) as PermDock<V>;
    })();
    if (typeof context === "object" && context !== null) {
      cache.set(context, built);
      const release = (): void => {
        if (cache.get(context) === built) {
          cache.delete(context);
        }
      };
      built.then(release, release);
    }
    return built;
  };

  const boundary = options.boundary ?? "tool-args";
  const tools = options.tools ?? {};

  const run = async (
    binding: ToolBinding,
    args: unknown,
    context: TContext,
    how: {
      readonly resume: boolean;
      readonly source: "adapter" | "simulate";
      readonly decideOptions: DecideToolOptions;
    },
  ): Promise<CheckResult<V>> => {
    let permdock: PermDock<V> | undefined;
    try {
      permdock = await instance(context);
      let data: unknown;
      if (binding.data !== undefined) {
        try {
          data = await binding.data(args);
        } catch {
          return { ok: false, failure: "load-failed", permdock };
        }
        if (
          binding.permission.kind === "instance" &&
          (data === null || data === undefined)
        ) {
          return { ok: false, failure: "no-data", permdock };
        }
      }
      const raw = runDecide(permdock, binding.permission, data, {
        adapter: options.adapter,
        boundary,
        source: how.source,
      });
      const decision = how.resume
        ? await resumeDecision({
            decision: raw,
            permission: binding.permission,
            subject: permdock.subject,
            store: options.store,
            resource: resourceRef(binding.permission, data),
            adapter: options.adapter,
            token:
              how.decideOptions.resumeToken ??
              (await storedApprovalToken(options.store, raw, {
                denyPending: how.decideOptions.denyPending === true,
              })),
          })
        : raw;
      return { ok: true, permdock, data, raw, decision };
    } catch {
      return compact<CheckResult<V>>({
        ok: false,
        failure: "failed",
        permdock,
      });
    }
  };

  const check = (
    binding: ToolBinding,
    args: unknown,
    context: TContext,
    checkOptions: CheckOptions = {},
  ): Promise<CheckResult<V>> =>
    run(binding, args, context, {
      resume: checkOptions.simulate !== true,
      source: checkOptions.simulate === true ? "simulate" : "adapter",
      decideOptions: checkOptions,
    });

  const evaluate = async (
    binding: ToolBinding,
    toolName: string,
    args: unknown,
    context: TContext,
    decideOptions: DecideToolOptions = {},
  ): Promise<ToolVerdict> => {
    const checked = await check(binding, args, context, decideOptions);
    if (!checked.ok) {
      if (checked.failure !== "no-data" || checked.permdock === undefined) {
        return {
          outcome: "denied",
          decision: null,
          permission: binding.permission,
          reason: thrownReason(toolName),
        };
      }
      const decision = {
        outcome: "denied" as const,
        denials: [{ role: null, reason: "validation" as const }],
        alternatives: [],
      };
      return {
        outcome: "denied",
        decision,
        permission: binding.permission,
        reason: modelReason(
          decision,
          binding.permission,
          checked.permdock.subject.principal?.id,
        ),
      };
    }
    const { permdock, decision, data } = checked;
    if (decision.outcome === "granted") {
      return {
        outcome: "granted",
        decision,
        permission: binding.permission,
        data,
      };
    }
    if (decision.outcome === "approval-required") {
      return {
        outcome: "approval-required",
        decision,
        permission: binding.permission,
        data,
        token: decision.token,
        summary: modelReason(
          decision,
          binding.permission,
          permdock.subject.principal?.id,
        ),
      };
    }
    return {
      outcome: "denied",
      decision,
      permission: binding.permission,
      reason: modelReason(
        decision,
        binding.permission,
        permdock.subject.principal?.id,
      ),
    };
  };

  const tokenFor = async (
    binding: ToolBinding,
    args: unknown,
    context: TContext,
  ): Promise<string | undefined> => {
    const checked = await run(binding, args, context, {
      resume: false,
      source: "adapter",
      decideOptions: {},
    });
    return checked.ok && checked.raw.outcome === "approval-required"
      ? checked.raw.token
      : undefined;
  };

  const decideTool = (
    toolName: string,
    args: unknown,
    context: TContext,
    decideOptions: DecideToolOptions = {},
  ): Promise<ToolVerdict> => {
    const binding = Object.hasOwn(tools, toolName)
      ? tools[toolName]
      : undefined;
    if (binding === undefined) {
      return Promise.resolve({
        outcome: "denied",
        decision: null,
        permission: undefined,
        reason: unmappedReason(toolName),
      });
    }
    return evaluate(binding, toolName, args, context, decideOptions);
  };

  const allowedToolNames = async (
    context: TContext,
  ): Promise<ReadonlySet<string>> => {
    const permdock = await instance(context);
    const allowed = new Set<string>();
    for (const [name, binding] of Object.entries(tools)) {
      if (mayUse(permdock, binding.permission)) {
        allowed.add(name);
      }
    }
    return allowed;
  };

  return {
    instance,
    decideTool,
    evaluate,
    check,
    tokenFor,
    allowedToolNames,
  };
}
