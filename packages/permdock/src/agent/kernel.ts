import type { Decision } from "../core/decision.ts";
import type { DecideOptions, PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Report } from "../core/request-context.ts";
import type { Principal } from "../core/subject.ts";
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
import { withApp } from "../core/app.ts";
import { resolveOrNull } from "../core/build-instance.ts";
import { compact } from "../core/compact.ts";
import { actorMayCallTool } from "../core/delegation.ts";
import {
  buildReportingInstance,
  requestContext,
} from "../core/request-context.ts";
import { resourceRef } from "../core/resource-ref.ts";
import { refusalText } from "./denied-text.ts";
import { modelReason, thrownReason, unmappedReason } from "./reason.ts";
import { eligiblePreview, stepUpFor } from "./step-up.ts";

/**
 * The resume token an agent run carries under the namespaced `permdockApproval`
 * key.
 */
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
    readonly call: "adapter" | "simulate";
    readonly operation?: NonNullable<DecideOptions["operation"]>;
    readonly args?: unknown;
  },
): Decision {
  // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
  return (
    permdock.decide as (
      next: Permission,
      row?: unknown,
      decideOptions?: DecideOptions,
    ) => Decision
  )(permission, data, how);
}

export function createAgentKernel<
  TContext,
  TUser = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, Principal, V>,
  given: AgentKernelOptions<TContext, TUser>,
): {
  /**
   * One instance per context object while a call is in flight; later calls
   * re-read the subject.
   */
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
  /**
   * With `eligible`, also the tools an activation of an eligible role would
   * open; a listing hint.
   */
  readonly allowedToolNames: (
    context: TContext,
    listOptions?: { readonly eligible?: boolean },
  ) => Promise<ReadonlySet<string>>;
  /**
   * Sends `error` to the `on('error')` handlers of an instance this kernel
   * built.
   */
  readonly report: (permdock: PermDock<V> | undefined, error: unknown) => void;
} {
  const options = withApp(policy, given);
  const cache = new WeakMap<object, Promise<PermDock<V>>>();
  const reporters = new WeakMap<PermDock<V>, Report>();

  const report = (permdock: PermDock<V> | undefined, error: unknown): void => {
    if (permdock !== undefined) {
      reporters.get(permdock)?.(error);
    }
  };

  const instance = (context: TContext): Promise<PermDock<V>> => {
    if (typeof context === "object" && context !== null) {
      const hit = cache.get(context);
      if (hit !== undefined) {
        return hit;
      }
    }
    const built = (async (): Promise<PermDock<V>> => {
      const user = await resolveOrNull(() => options.subject(context));
      const actor = await actorFrom(options.actor, context);
      const delegate = options.delegation;
      const delegation =
        delegate === undefined
          ? undefined
          : ((await resolveOrNull(() => delegate(context))) ?? undefined);
      const { tenant } = await tenantScope(options.tenant, context);
      const errors: unknown[] = [];
      const requestValues = await requestContext(
        options.context,
        context,
        errors,
      );
      const wrap = options.wrap;
      const typedWrap = (created: PermDock<V>): PermDock<V> =>
        // SAFETY: wrap returns the instance it was given, decorated; the vocabulary is unchanged.
        wrap === undefined ? created : (wrap(created) as PermDock<V>);
      const { permdock, report: reportTo } = await buildReportingInstance({
        policy,
        user,
        sources: options,
        scope: { tenant, actor, delegation, context: requestValues },
        errors,
        wrap: typedWrap,
      });
      reporters.set(permdock, reportTo);
      return permdock;
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
      readonly call: "adapter" | "simulate";
      readonly decideOptions: CheckOptions;
      readonly tool?: string;
    },
  ): Promise<CheckResult<V>> => {
    const onError = (error: unknown): void => {
      try {
        how.decideOptions.onError?.(error);
      } catch {
        // A failing sink must not turn a failure into a throw (invariant 1).
      }
    };
    let permdock: PermDock<V> | undefined;
    try {
      permdock = await instance(context);
      if (
        how.tool !== undefined &&
        !actorMayCallTool(permdock.subject.actor, how.tool)
      ) {
        const refused: Decision = {
          outcome: "denied",
          denials: [{ role: null, reason: "agent-tool-not-delegated" }],
          alternatives: [],
        };
        return {
          ok: true,
          permdock,
          data: undefined,
          raw: refused,
          decision: refused,
        };
      }
      let data: unknown;
      if (binding.data !== undefined) {
        try {
          data = await binding.data(args);
        } catch (error) {
          onError(error);
          return { ok: false, failure: "load-failed", permdock };
        }
        if (
          binding.permission.kind === "instance" &&
          (data === null || data === undefined)
        ) {
          return { ok: false, failure: "no-data", permdock };
        }
      }
      const raw = runDecide(
        permdock,
        binding.permission,
        data,
        compact({
          adapter: options.adapter,
          boundary,
          call: how.call,
          args,
          operation:
            binding.meta === undefined
              ? undefined
              : { name: binding.name ?? "", meta: binding.meta },
        }),
      );
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
    } catch (error) {
      onError(error);
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
    run(
      binding,
      args,
      context,
      compact({
        resume: checkOptions.simulate !== true,
        call: checkOptions.simulate === true ? "simulate" : "adapter",
        decideOptions: checkOptions,
        tool: checkOptions.tool,
      }),
    );

  const verdictOf = (
    checked: CheckResult<V>,
    binding: ToolBinding,
    toolName: string,
  ): ToolVerdict => {
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
    return compact<ToolVerdict>({
      outcome: "denied",
      decision,
      permission: binding.permission,
      reason: modelReason(
        decision,
        binding.permission,
        permdock.subject.principal?.id,
      ),
      stepUp:
        options.stepUp === true
          ? stepUpFor(permdock, binding.permission, data, decision)
          : undefined,
    });
  };

  const evaluate = async (
    binding: ToolBinding,
    toolName: string,
    args: unknown,
    context: TContext,
    decideOptions: DecideToolOptions = {},
  ): Promise<ToolVerdict> => {
    const checked = await check(binding, args, context, {
      ...decideOptions,
      tool: toolName,
    });
    return relabel(verdictOf(checked, binding, toolName), checked.permdock);
  };

  const relabel = (
    verdict: ToolVerdict,
    permdock: PermDock<V> | undefined,
  ): ToolVerdict => {
    const hook = options.deniedText;
    if (hook === undefined || verdict.outcome === "granted") {
      return verdict;
    }
    const onError = (error: unknown): void => {
      report(permdock, error);
    };
    if (verdict.outcome === "denied") {
      return {
        ...verdict,
        reason: refusalText(
          hook,
          {
            decision: verdict.decision,
            permission: verdict.permission,
            text: verdict.reason,
          },
          onError,
        ),
      };
    }
    return {
      ...verdict,
      summary: refusalText(
        hook,
        {
          decision: verdict.decision,
          permission: verdict.permission,
          text: verdict.summary,
        },
        onError,
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
      call: "adapter",
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
      return Promise.resolve(
        relabel(
          {
            outcome: "denied",
            decision: null,
            permission: undefined,
            reason: unmappedReason(toolName),
          },
          undefined,
        ),
      );
    }
    return evaluate(binding, toolName, args, context, decideOptions);
  };

  const allowedToolNames = async (
    context: TContext,
    listOptions: { readonly eligible?: boolean } = {},
  ): Promise<ReadonlySet<string>> => {
    const permdock = await instance(context);
    const preview =
      listOptions.eligible === true ? eligiblePreview(permdock) : undefined;
    const allowed = new Set<string>();
    for (const [name, binding] of Object.entries(tools)) {
      if (
        actorMayCallTool(permdock.subject.actor, name) &&
        (permdock.mayUse(binding.permission) ||
          preview?.mayUse(binding.permission) === true)
      ) {
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
    report,
  };
}
