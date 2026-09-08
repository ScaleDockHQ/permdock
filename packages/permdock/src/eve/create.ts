import type { ToolBinding, ToolMap, ToolVerdict } from '../agent/types.ts';
import type { ApprovalRequest, ApprovalStore } from '../approvals/types.ts';
import type {
  DecisionSink,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';

import { createAgentKernel } from '../agent/kernel.ts';
import { isApprovalError } from '../approvals/errors.ts';
import { resolveApproval } from '../approvals/helpers.ts';
import { memoryApprovalStore } from '../approvals/store.ts';
import { compact } from '../core/compact.ts';

export type EvePrincipal = {
  readonly principalId: string;
  readonly principalType?: string;
  readonly authenticator?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
};

export type EveContext = {
  readonly session?: {
    readonly auth?: {
      readonly initiator?: EvePrincipal;
      readonly current?: EvePrincipal;
    };
  };
  readonly callId?: string;
  readonly token?: string;
};

export type EveApprovalArgs = {
  readonly toolName: string;
  readonly toolInput?: unknown;
  readonly callId?: string;
};

export type EveResponder = {
  readonly principalId: string;
  readonly roles?: readonly string[];
};

export type EveApprovers =
  | { readonly roles: readonly string[] }
  | ((responder: EveResponder, request: ApprovalRequest) => boolean);

export type EvePermDockOptions = {
  readonly subject?: (context: EveContext) => unknown;
  readonly actor?: (context: EveContext) => unknown;
  readonly tenant?:
    | string
    | ((
        context: EveContext,
      ) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
  readonly approvers?: EveApprovers;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};

export type EveRequestResult =
  | 'not-applicable'
  | 'user-approval'
  | { readonly type: 'denied'; readonly reason: string };

export type EveResponseResult =
  | { readonly status: 'allowed' }
  | { readonly status: 'rejected'; readonly reason: string };

export type EveApprovalPair = {
  readonly request: (
    ctx: EveContext,
    args: EveApprovalArgs,
  ) => Promise<EveRequestResult>;
  readonly response: (
    responder: EveResponder,
    args: { readonly callId?: string; readonly token?: string },
  ) => Promise<EveResponseResult>;
};

export type EvePermDock = {
  readonly approval: EveApprovalPair;
  readonly approvalFor: (
    permission: Permission,
    data?: (input: unknown) => unknown,
  ) => EveApprovalPair;
  readonly permdock: (ctx: EveContext) => Promise<PermDock>;
};

function serverRoles(
  attributes: Readonly<Record<string, unknown>> | undefined,
): readonly string[] {
  const roles = attributes?.roles;
  if (!Array.isArray(roles)) {
    return [];
  }
  return roles.filter((role) => typeof role === 'string');
}

export function subjectFromSession(context: EveContext): unknown {
  const initiator = context.session?.auth?.initiator;
  if (initiator === undefined) {
    return null;
  }
  return {
    id: initiator.principalId,
    roles: serverRoles(initiator.attributes),
  };
}

export function actorFromSession(context: EveContext): unknown {
  const auth = context.session?.auth;
  const initiator = auth?.initiator;
  const current = auth?.current;
  if (
    current !== undefined &&
    initiator !== undefined &&
    current.principalId !== initiator.principalId
  ) {
    return { id: current.principalId, kind: 'eve' };
  }
  return { id: 'eve:app', kind: 'eve' };
}

function mapVerdict(verdict: ToolVerdict): EveRequestResult {
  if (verdict.outcome === 'granted') {
    return 'not-applicable';
  }
  if (verdict.outcome === 'approval-required') {
    return 'user-approval';
  }
  return { type: 'denied', reason: verdict.reason };
}

function mayApprove(
  approvers: EveApprovers | undefined,
  responder: EveResponder,
  request: ApprovalRequest,
): boolean {
  if (approvers === undefined) {
    return true;
  }
  if (typeof approvers === 'function') {
    return approvers(responder, request);
  }
  const held = new Set(responder.roles ?? []);
  return approvers.roles.some((role) => held.has(role));
}

export function createPermDock(
  policy: Policy,
  options: EvePermDockOptions,
): EvePermDock {
  const store = options.store ?? memoryApprovalStore();
  const tokensByCall = new Map<string, string>();
  const kernel = createAgentKernel(policy, {
    ...compact({
      tenant: options.tenant,
      memberships: options.memberships,
      customRoles: options.customRoles,
      sink: options.sink,
      snapshots: options.snapshots,
    }),
    subject: options.subject ?? subjectFromSession,
    actor: options.actor ?? actorFromSession,
    tools: options.tools,
    store,
    adapter: 'eve',
  });

  const pairFor = (
    decide: (ctx: EveContext, args: EveApprovalArgs) => Promise<ToolVerdict>,
  ): EveApprovalPair => {
    const request = async (
      ctx: EveContext,
      args: EveApprovalArgs,
    ): Promise<EveRequestResult> => {
      const resumeToken =
        (args.callId === undefined
          ? undefined
          : tokensByCall.get(args.callId)) ?? ctx.token;
      const verdict = await decide(ctx, args);
      if (
        verdict.outcome === 'approval-required' &&
        args.callId !== undefined
      ) {
        tokensByCall.set(args.callId, verdict.token);
      }
      if (resumeToken !== undefined && verdict.outcome === 'granted') {
        return 'not-applicable';
      }
      return mapVerdict(verdict);
    };

    const response = async (
      responder: EveResponder,
      args: { readonly callId?: string; readonly token?: string },
    ): Promise<EveResponseResult> => {
      const token =
        args.token ??
        (args.callId === undefined ? undefined : tokensByCall.get(args.callId));
      if (token === undefined) {
        return { status: 'rejected', reason: 'approval-not-found' };
      }
      const current = await store.get(token);
      if (current === null) {
        return { status: 'rejected', reason: 'approval-not-found' };
      }
      if (current.subject.actor?.id === responder.principalId) {
        return {
          status: 'rejected',
          reason: 'approver is the actor of this request',
        };
      }
      if (!mayApprove(options.approvers, responder, current)) {
        return { status: 'rejected', reason: 'approver is not eligible' };
      }
      try {
        await resolveApproval(store, token, {
          status: 'approved',
          by: {
            principal: {
              id: responder.principalId,
              roles: responder.roles ?? [],
            },
            context: {},
          },
        });
        return { status: 'allowed' };
      } catch (error) {
        if (isApprovalError(error)) {
          return { status: 'rejected', reason: error.message };
        }
        return { status: 'rejected', reason: 'approval-not-found' };
      }
    };

    return { request, response };
  };

  const approval = pairFor((ctx, args) => {
    const resumeToken =
      (args.callId === undefined ? undefined : tokensByCall.get(args.callId)) ??
      ctx.token;
    return kernel.decideTool(
      args.toolName,
      args.toolInput,
      ctx,
      compact({ resumeToken }),
    );
  });

  const approvalFor = (
    permission: Permission,
    data?: (input: unknown) => unknown,
  ): EveApprovalPair => {
    const binding: ToolBinding = compact({ permission, data });
    return pairFor((ctx, args) => {
      const resumeToken =
        (args.callId === undefined
          ? undefined
          : tokensByCall.get(args.callId)) ?? ctx.token;
      return kernel.evaluate(
        binding,
        args.toolName,
        args.toolInput,
        ctx,
        compact({ resumeToken }),
      );
    });
  };

  return {
    approval,
    approvalFor,
    permdock: (ctx) => kernel.instance(ctx),
  };
}
