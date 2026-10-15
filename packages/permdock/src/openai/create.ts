import type { AgentPermDock } from "../agent/create.ts";
import type { AgentAdapterOptions } from "../agent/types.ts";
import type { ApprovalRequest } from "../approvals/types.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Principal } from "../core/subject.ts";

import { agentRuntime } from "../agent/create.ts";
import { approvalTokenOf } from "../agent/kernel.ts";
import { adapterOptions } from "../approvals/app.ts";
import { compact } from "../core/compact.ts";

/** The app context passed to `run(agent, input, { context })`. */
export type OpenAiContext = {
  readonly user?: unknown;
  readonly agentId?: string;
  readonly permdockApproval?: string;
  readonly [key: string]: unknown;
};

/** Structural `RunContext` from `@openai/agents`: the app context sits under `context`. */
export type OpenAiRunContext = {
  readonly context?: unknown;
};

export type OpenAiPermDockOptions<TUser = unknown> = AgentAdapterOptions<
  OpenAiContext,
  TUser
>;

export type OpenAiTool = {
  readonly name: string;
};

/** Structural `RunToolApprovalItem` from `@openai/agents`. */
export type OpenAiInterruption = {
  readonly type?: string;
  readonly name?: string | undefined;
  readonly arguments?: string | undefined;
  readonly rawItem?: {
    readonly type?: string;
    readonly callId?: string;
    readonly name?: string;
    readonly arguments?: unknown;
  };
};

/** Structural `RunState` from `@openai/agents`. */
export type OpenAiRunState<TItem> = {
  approve(item: TItem, options?: { alwaysApprove?: boolean }): unknown;
  reject(
    item: TItem,
    options?: { alwaysReject?: boolean; message?: string },
  ): unknown;
};

export type OpenAiPermDock<V extends PolicyVocabulary = PolicyVocabulary> =
  AgentPermDock<OpenAiContext, V> & {
    /** A `ToolApprovalFunction`: pass it as a tool's `needsApproval`. */
    readonly needsApproval: (
      permission: Permission,
    ) => (
      runContext: OpenAiRunContext | undefined,
      input: unknown,
      callId?: string,
    ) => Promise<boolean>;
    readonly guardTools: <T extends OpenAiTool>(
      tools: readonly T[],
      context: OpenAiContext,
    ) => Promise<readonly T[]>;
    readonly resolveInterruptions: <TItem extends OpenAiInterruption>(
      state: OpenAiRunState<TItem>,
      interruptions: readonly TItem[],
      options: { readonly context: OpenAiContext },
    ) => Promise<readonly ApprovalRequest[]>;
    readonly getPermDock: (context: OpenAiContext) => Promise<PermDock<V>>;
  };

function appContext(runContext: OpenAiRunContext | undefined): OpenAiContext {
  const context = runContext?.context;
  // SAFETY: the object the app passed to the run as its context, which the app types as OpenAiContext.
  return typeof context === "object" && context !== null
    ? (context as OpenAiContext)
    : {};
}

type ParsedCall =
  | { readonly ok: true; readonly name: string; readonly args: unknown }
  | { readonly ok: false };

function parseCall(item: OpenAiInterruption): ParsedCall {
  const name = item.name ?? item.rawItem?.name;
  if (typeof name !== "string") {
    return { ok: false };
  }
  const raw = item.arguments ?? item.rawItem?.arguments;
  if (typeof raw !== "string") {
    return typeof raw === "object" && raw !== null
      ? { ok: true, name, args: raw }
      : { ok: false };
  }
  try {
    const args: unknown = JSON.parse(raw);
    return { ok: true, name, args };
  } catch {
    return { ok: false };
  }
}

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  given: OpenAiPermDockOptions<TUser>,
): OpenAiPermDock<V> {
  const options = adapterOptions(policy, given);
  const store = options.store;
  const { agent, kernel } = agentRuntime(policy, options, "openai");

  const byPermission = new Map<string, string>();
  for (const [name, binding] of Object.entries(options.operations)) {
    byPermission.set(binding.permission.key, name);
  }
  const passes = (toolName: string): boolean =>
    options.unmapped === "allow" &&
    !Object.hasOwn(options.operations, toolName);

  // A denial also pauses the run: `resolveInterruptions` rejects it with the
  // reason, so the model sees why instead of the tool running.
  const needsApproval =
    (permission: Permission) =>
    async (
      runContext: OpenAiRunContext | undefined,
      input: unknown,
    ): Promise<boolean> => {
      const toolName = byPermission.get(permission.key);
      if (toolName === undefined) {
        return true;
      }
      const context = appContext(runContext);
      const binding = options.operations[toolName];
      if (binding === undefined) {
        return true;
      }
      const checked = await kernel.check(binding, input, context, {
        simulate: true,
      });
      return !checked.ok || checked.raw.outcome !== "granted";
    };

  const guardTools = async <T extends OpenAiTool>(
    tools: readonly T[],
    context: OpenAiContext,
  ): Promise<readonly T[]> => {
    const allowed = await kernel.allowedToolNames(context);
    return tools.filter((tool) => allowed.has(tool.name) || passes(tool.name));
  };

  const resolveOne = async <TItem extends OpenAiInterruption>(
    state: OpenAiRunState<TItem>,
    item: TItem,
    context: OpenAiContext,
  ): Promise<ApprovalRequest | null> => {
    const call = parseCall(item);
    if (!call.ok) {
      await state.reject(item, { message: "Denied: unreadable tool call." });
      return null;
    }
    if (passes(call.name)) {
      return null;
    }
    const verdict = await kernel.decideTool(
      call.name,
      call.args,
      context,
      compact({ resumeToken: approvalTokenOf(context) }),
    );
    if (verdict.outcome === "granted") {
      await state.approve(item);
      return null;
    }
    if (verdict.outcome === "denied") {
      await state.reject(item, { message: verdict.reason });
      return null;
    }
    if (store === undefined) {
      return null;
    }
    try {
      return await store.get(verdict.token);
    } catch {
      return null;
    }
  };

  const resolveInterruptions = async <TItem extends OpenAiInterruption>(
    state: OpenAiRunState<TItem>,
    interruptions: readonly TItem[],
    resolveOptions: { readonly context: OpenAiContext },
  ): Promise<readonly ApprovalRequest[]> => {
    const resolved = [];
    for (const item of interruptions) {
      // oxlint-disable-next-line no-await-in-loop -- approve / reject mutate the run state in interruption order
      resolved.push(await resolveOne(state, item, resolveOptions.context));
    }
    return resolved.filter((record) => record !== null);
  };

  return Object.freeze({
    ...agent,
    needsApproval,
    guardTools,
    resolveInterruptions,
  });
}
