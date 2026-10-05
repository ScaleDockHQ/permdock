import type { ToolMap } from "../agent/types.ts";
import type { ToolVerdict } from "../agent/types.ts";
import type { ApprovalStore } from "../approvals/types.ts";
import type { ApprovalPolicySource } from "../core/approval-policies.ts";
import type { PolicySource } from "../core/hosted.ts";
import type {
  DecisionSink,
  EntitlementSource,
  LimitStore,
  MembershipSource,
  RelationSource,
  RoleSource,
  RoleSourceFactory,
  SnapshotSource,
} from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy } from "../core/policy.ts";
import type { Delegation, Principal } from "../core/subject.ts";

import { approvalTokenOf, createAgentKernel } from "../agent/kernel.ts";
import { compact } from "../core/compact.ts";
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
} from "../core/errors.ts";

export type AiSdkContext = {
  readonly runtimeContext?: unknown;
  readonly permdockApproval?: string;
  readonly [key: string]: unknown;
};

export type AiSdkPermDockOptions<TUser = unknown> = {
  readonly subject: (context: AiSdkContext) => TUser | Promise<TUser>;
  readonly actor?: (context: AiSdkContext) => unknown;
  readonly delegation?: (
    context: AiSdkContext,
  ) => Delegation | undefined | Promise<Delegation | undefined>;
  readonly tenant?:
    | string
    | ((
        context: AiSdkContext,
      ) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  /** The object graph for relation grants that walk a parent chain; without it they deny. */
  readonly relations?: RelationSource;
  /** Approval requirements kept as data (`ApprovalPolicySource`); they add to the code's and never remove one. A throw denies. */
  readonly approvalPolicies?: ApprovalPolicySource;
  readonly entitlements?: EntitlementSource;
  readonly customRoles?: RoleSource | RoleSourceFactory;
  /** Hosted grants, read once per instance; see `PolicySource`. */
  readonly policies?: PolicySource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  readonly snapshots?: SnapshotSource;
};

export type ToolApprovalStatus =
  | "approved"
  | { readonly type: "denied"; readonly reason: string }
  | {
      readonly type: "user-approval";
      readonly reason: string;
      readonly token: string;
    };

/** Structural `GenericToolApprovalFunction` options from `ai`. */
export type ToolApprovalCall = {
  readonly toolCall: {
    readonly toolName: string;
    readonly toolCallId?: string;
    readonly input?: unknown;
  };
  readonly messages?: readonly unknown[];
  readonly runtimeContext?: unknown;
};

/** Structural `ToolNeedsApprovalFunction` options from `ai`. */
export type NeedsApprovalOptions = {
  readonly toolCallId?: string;
  readonly messages?: readonly unknown[];
  readonly context?: unknown;
};

type CallParams = {
  readonly tools?: readonly { readonly name?: string }[];
  readonly toolChoice?: unknown;
};

/** Structural `LanguageModelMiddleware` (specification `v4`) from `ai`. */
export type LanguageModelMiddleware = {
  readonly specificationVersion: "v4";
  readonly transformParams: <TParams extends CallParams>(options: {
    readonly params: TParams;
  }) => Promise<TParams>;
};

export type AiSdkPermDock = {
  readonly toolApproval: (
    call: ToolApprovalCall,
  ) => Promise<ToolApprovalStatus>;
  /** Hides tools the subject in `context` can never use, before the model sees them. */
  readonly capabilityMiddleware: (
    context: AiSdkContext,
  ) => LanguageModelMiddleware;
  readonly needsApproval: (
    permission: Permission,
  ) => (input: unknown, options?: NeedsApprovalOptions) => Promise<boolean>;
};

function contextOf(call: ToolApprovalCall): AiSdkContext {
  // SAFETY: an object; AiSdkContext's fields are unknown but permdockApproval, which is typeof-checked.
  const runtime =
    call.runtimeContext !== null && typeof call.runtimeContext === "object"
      ? (call.runtimeContext as AiSdkContext)
      : {};
  return compact<AiSdkContext>({
    ...runtime,
    runtimeContext: call.runtimeContext,
  });
}

function toolContextOf(options: NeedsApprovalOptions): AiSdkContext {
  // SAFETY: an object; AiSdkContext's fields are unknown but permdockApproval, which is typeof-checked.
  const tool =
    options.context !== null && typeof options.context === "object"
      ? (options.context as AiSdkContext)
      : {};
  return compact<AiSdkContext>({ ...tool, toolContext: options.context });
}

/**
 * Whether `messages` already carry an approval request for `toolCallId`: the
 * SDK is re-checking a call a user approved, and treats any answer other
 * than `denied` as approval.
 */
function isRecheck(messages: unknown, toolCallId: unknown): boolean {
  if (!Array.isArray(messages) || typeof toolCallId !== "string") {
    return false;
  }
  return messages.some((message: unknown) => {
    if (typeof message !== "object" || message === null) {
      return false;
    }
    // SAFETY: checked above to be a non-null object; role and content are only compared and tested.
    const { role, content } = message as {
      readonly role?: unknown;
      readonly content?: unknown;
    };
    // SAFETY: each part is checked to be a non-null object before its fields are compared.
    return (
      role === "assistant" &&
      Array.isArray(content) &&
      content.some(
        (part: unknown) =>
          typeof part === "object" &&
          part !== null &&
          (part as { readonly type?: unknown }).type ===
            "tool-approval-request" &&
          (part as { readonly toolCallId?: unknown }).toolCallId === toolCallId,
      )
    );
  });
}

function resourceOf(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  // SAFETY: read only from a non-null object; id is typeof-checked below.
  const id =
    typeof data === "object" && data !== null
      ? (data as { readonly id?: unknown }).id
      : undefined;
  return typeof id === "string" || typeof id === "number"
    ? { type: permission.resource, id: String(id) }
    : { type: permission.resource };
}

function deniedError(
  verdict: Extract<ToolVerdict, { readonly outcome: "denied" }>,
  permission: Permission,
  permdock: PermDock,
): PermDockDeniedError {
  return new PermDockDeniedError({
    decision: verdict.decision ?? {
      outcome: "denied",
      denials: [],
      alternatives: [],
    },
    permission: permission.key,
    scope: permission.scope,
    resource: { type: permission.resource },
    subject: permdock.subject,
    message: verdict.reason,
  });
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: AiSdkPermDockOptions<TUser>,
): AiSdkPermDock {
  const kernel = createAgentKernel(policy, {
    ...compact({
      actor: options.actor,
      delegation: options.delegation,
      tenant: options.tenant,
      memberships: options.memberships,
      relations: options.relations,
      approvalPolicies: options.approvalPolicies,
      entitlements: options.entitlements,
      customRoles: options.customRoles,
      policies: options.policies,
      store: options.store,
      sink: options.sink,
      limits: options.limits,
      snapshots: options.snapshots,
    }),
    subject: options.subject,
    tools: options.tools,
    adapter: "ai-sdk",
  });

  const byPermission = new Map<string, string>();
  for (const [name, binding] of Object.entries(options.tools)) {
    byPermission.set(binding.permission.key, name);
  }

  const decide = (
    toolName: string,
    args: unknown,
    context: AiSdkContext,
  ): Promise<ToolVerdict> =>
    kernel.decideTool(
      toolName,
      args,
      context,
      compact({ resumeToken: approvalTokenOf(context) }),
    );

  const toolApproval = async (
    call: ToolApprovalCall,
  ): Promise<ToolApprovalStatus> => {
    const context = contextOf(call);
    const verdict = await decide(
      call.toolCall.toolName,
      call.toolCall.input,
      context,
    );
    if (verdict.outcome === "granted") {
      return "approved";
    }
    if (verdict.outcome === "denied") {
      return { type: "denied", reason: verdict.reason };
    }
    if (isRecheck(call.messages, call.toolCall.toolCallId)) {
      return {
        type: "denied",
        reason: `${verdict.summary} No approval is recorded for this call.`,
      };
    }
    return {
      type: "user-approval",
      reason: verdict.summary,
      token: verdict.token,
    };
  };

  const capabilityMiddleware = (
    context: AiSdkContext,
  ): LanguageModelMiddleware => ({
    specificationVersion: "v4",
    transformParams: async <TParams extends CallParams>({
      params,
    }: {
      readonly params: TParams;
    }): Promise<TParams> => {
      if (params.tools === undefined) {
        return params;
      }
      const allowed = await kernel.allowedToolNames(context);
      const tools = params.tools.filter(
        (tool) => typeof tool.name === "string" && allowed.has(tool.name),
      );
      // SAFETY: every read is optional and compared, so any other toolChoice leaves forcedAway false.
      const choice = params.toolChoice as
        | { readonly type?: unknown; readonly toolName?: unknown }
        | undefined;
      const forcedAway =
        choice?.type === "tool" &&
        !(typeof choice.toolName === "string" && allowed.has(choice.toolName));
      return {
        ...params,
        tools,
        ...(forcedAway ? { toolChoice: { type: "none" } } : {}),
      };
    },
  });

  const needsApproval =
    (permission: Permission) =>
    async (
      input: unknown,
      needsOptions: NeedsApprovalOptions = {},
    ): Promise<boolean> => {
      const context = toolContextOf(needsOptions);
      const toolName = byPermission.get(permission.key);
      if (toolName === undefined) {
        throw deniedError(
          {
            outcome: "denied",
            decision: null,
            permission,
            reason: `${permission.key} is not bound to a tool.`,
          },
          permission,
          await kernel.instance(context),
        );
      }
      const verdict = await decide(toolName, input, context);
      if (verdict.outcome === "granted") {
        return false;
      }
      if (verdict.outcome === "denied") {
        throw deniedError(verdict, permission, await kernel.instance(context));
      }
      if (isRecheck(needsOptions.messages, needsOptions.toolCallId)) {
        throw new PermDockApprovalRequiredError({
          decision: verdict.decision,
          permission: permission.key,
          scope: permission.scope,
          resource: resourceOf(permission, verdict.data),
          message: `${verdict.summary} No approval is recorded for this call.`,
        });
      }
      return true;
    };

  return { toolApproval, capabilityMiddleware, needsApproval };
}
