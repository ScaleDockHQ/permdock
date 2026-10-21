import type { Decision } from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Principal } from "../core/subject.ts";
import type {
  AgentAdapterOptions,
  DecideToolOptions,
  ModelMap,
  ToolBinding,
  ToolVerdict,
} from "./types.ts";

import { withApp } from "../core/app.ts";
import { compact } from "../core/compact.ts";
import { deniedFor } from "../core/decide-for.ts";
import { freezeDeep } from "../core/freeze.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { composeWraps } from "../core/wrap.ts";
import { createAgentKernel } from "./kernel.ts";

export type AgentPermDockOptions<
  TContext,
  TUser = unknown,
> = AgentAdapterOptions<TContext, TUser>;

/** What one operation call decides: granted with the loaded row, denied with the text a model reads, or parked for approval. */
export type OperationVerdict = ToolVerdict;

/** `providerOptions` for the Vercel AI Gateway: spend and usage attributed to the caller. */
export type GatewayOptions = {
  readonly gateway: {
    readonly user?: string;
    readonly tags?: readonly string[];
  };
};

/**
 * The runtime-neutral agent contract: operations decided by name, the model
 * gate and the results filter. `permdock/ai-sdk`, `permdock/openai`,
 * `permdock/claude-agent` and `permdock/eve` each return one, plus the hooks
 * their runtime calls.
 */
export type AgentPermDock<
  TContext,
  V extends PolicyVocabulary = PolicyVocabulary,
> = {
  /** One instance per context object while a call is in flight; later calls re-read the subject. */
  readonly getPermDock: (context: TContext) => Promise<PermDock<V>>;
  /**
   * Decides operation `name` on `input`: loads the row through the
   * operation's `data`, validates it, decides and resumes an approval. Never
   * throws; an operation `operations` does not name is denied.
   */
  readonly decideOperation: (
    name: string,
    input: unknown,
    context: TContext,
    options?: DecideToolOptions,
  ) => Promise<OperationVerdict>;
  /** Operation names the subject could be granted for some row; a listing hint, never a decision. */
  readonly allowedOperations: (
    context: TContext,
  ) => Promise<ReadonlySet<string>>;
  /** The approval token a call would park under, without touching the store. */
  readonly tokenFor: (
    name: string,
    input: unknown,
    context: TContext,
  ) => Promise<string | undefined>;
  /** Decides whether the subject may call model `modelId`. A model `models` does not name is denied. */
  readonly decideModel: (
    modelId: string,
    context: TContext,
  ) => Promise<Decision>;
  /** The ids in `models` the subject is granted, in declaration order. */
  readonly permittedModels: (context: TContext) => Promise<readonly string[]>;
  /**
   * The rows of an operation's output the subject may see, by the
   * operation's `results` permission. Without `results` the rows come back
   * unchanged; an operation `operations` does not name returns none.
   */
  readonly filterResults: <T>(
    name: string,
    rows: readonly T[],
    context: TContext,
  ) => Promise<T[]>;
  /** `providerOptions.gateway` with the principal as `user` and the tenant and actor as tags. */
  readonly gatewayOptions: (context: TContext) => Promise<GatewayOptions>;
};

/** What an adapter builds its runtime hooks on: the public contract and the kernel under it. */
export type AgentRuntime<TContext, V extends PolicyVocabulary> = {
  readonly agent: AgentPermDock<TContext, V>;
  readonly kernel: ReturnType<typeof createAgentKernel<TContext, unknown, V>>;
};

function modelRow(modelId: string): { readonly id: string } {
  return { id: modelId };
}

function unlistedModel(modelId: string): Decision {
  return freezeDeep({
    outcome: "denied",
    denials: [{ role: null, reason: "no-grant", detail: { model: modelId } }],
    alternatives: [],
  });
}

function decideModelOn(
  permdock: PermDock,
  models: ModelMap | undefined,
  modelId: string,
  adapter: string,
): Decision {
  const permission: Permission | undefined =
    models !== undefined && Object.hasOwn(models, modelId)
      ? models[modelId]
      : undefined;
  if (permission === undefined) {
    return unlistedModel(modelId);
  }
  try {
    return permdock.decide(
      permission,
      permission.kind === "instance" ? modelRow(modelId) : undefined,
      { trusted: true, adapter, call: "adapter", model: modelId },
    );
  } catch {
    return deniedFor(permission, "closure-error");
  }
}

/** Builds the agent contract and its kernel for an adapter named `adapter`; `runtime.stepUp` sets `stepUp` on denied verdicts. */
export function agentRuntime<
  TContext,
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: AgentPermDockOptions<TContext, TUser>,
  adapter: string,
  runtime: { readonly stepUp?: boolean } = {},
): AgentRuntime<TContext, V> {
  const kernel = createAgentKernel<TContext, TUser, V>(policy, {
    ...compact({
      actor: options.actor,
      delegation: options.delegation,
      tenant: options.tenant,
      store: options.store,
      context: options.context,
      wrap: composeWraps(options.otel, options.wrap),
      deniedText: options.deniedText,
      stepUp: runtime.stepUp,
    }),
    ...instanceOptions(options),
    subject: options.subject,
    tools: options.operations,
    adapter,
  });
  const operations = options.operations;
  const bindingOf = (name: string): ToolBinding | undefined =>
    Object.hasOwn(operations, name) ? operations[name] : undefined;

  const decideModel = async (
    modelId: string,
    context: TContext,
  ): Promise<Decision> => {
    try {
      const permdock = await kernel.instance(context);
      return decideModelOn(permdock, options.models, modelId, adapter);
    } catch {
      return unlistedModel(modelId);
    }
  };

  const permittedModels = async (
    context: TContext,
  ): Promise<readonly string[]> => {
    if (options.models === undefined) {
      return [];
    }
    let permdock: PermDock<V>;
    try {
      permdock = await kernel.instance(context);
    } catch {
      return [];
    }
    return Object.keys(options.models).filter(
      (modelId) =>
        decideModelOn(permdock, options.models, modelId, adapter).outcome ===
        "granted",
    );
  };

  const filterResults = async <T>(
    name: string,
    rows: readonly T[],
    context: TContext,
  ): Promise<T[]> => {
    const binding = bindingOf(name);
    if (binding === undefined) {
      return [];
    }
    if (binding.results === undefined) {
      return [...rows];
    }
    try {
      const permdock = await kernel.instance(context);
      // SAFETY: filter reads each row only through the permission's conditions; T is the caller's row type.
      const results = binding.results as Permission<string, T, "instance">;
      if (results.kind !== "instance") {
        return permdock.can(results, undefined) ? [...rows] : [];
      }
      await permdock.prefetchRelations(results, rows);
      return permdock.filter(results, rows, { adapter, call: "filter" });
    } catch {
      return [];
    }
  };

  const gatewayOptions = async (context: TContext): Promise<GatewayOptions> => {
    let permdock: PermDock<V>;
    try {
      permdock = await kernel.instance(context);
    } catch {
      return { gateway: {} };
    }
    const { principal, actor } = permdock.subject;
    const tags = [
      ...(principal?.tenant === undefined
        ? []
        : [`tenant:${principal.tenant}`]),
      ...(actor === undefined ? [] : [`actor:${actor.kind}`]),
    ];
    return {
      gateway: compact({
        user: principal?.id,
        tags: tags.length > 0 ? tags : undefined,
      }),
    };
  };

  const agent: AgentPermDock<TContext, V> = Object.freeze({
    getPermDock: (context: TContext) => kernel.instance(context),
    decideOperation: (
      name: string,
      input: unknown,
      context: TContext,
      decideOptions?: DecideToolOptions,
    ) => kernel.decideTool(name, input, context, decideOptions),
    allowedOperations: (context: TContext) => kernel.allowedToolNames(context),
    tokenFor: (name: string, input: unknown, context: TContext) => {
      const binding = bindingOf(name);
      return binding === undefined
        ? Promise.resolve(undefined)
        : kernel.tokenFor(binding, input, context);
    },
    decideModel,
    permittedModels,
    filterResults,
    gatewayOptions,
  });
  return { agent, kernel };
}

/**
 * The agent contract for a runtime PermDock has no adapter for: decide
 * operations by name, gate models and filter results. The subject comes from
 * `subject(context)` on the server, never from model output.
 */
export function createPermDock<
  TContext,
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  given: AgentPermDockOptions<TContext, TUser>,
): AgentPermDock<TContext, V> {
  const options = withApp(policy, given);
  return agentRuntime(policy, options, "agent").agent;
}
