import type { ToolBinding, ToolMap, ToolVerdict } from '../agent/types.ts';
import type { ApprovalRequest, ApprovalStore } from '../approvals/types.ts';
import type { PolicySource } from '../core/hosted.ts';
import type {
  DecisionSink,
  EntitlementSource,
  LimitStore,
  MembershipSource,
  RelationSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { Delegation, Principal } from '../core/subject.ts';

import { createAgentKernel } from '../agent/kernel.ts';
import { boundedMap } from '../agent/lru.ts';
import { isApprovalError } from '../approvals/errors.ts';
import { resolveApproval } from '../approvals/helpers.ts';
import { memoryApprovalStore } from '../approvals/store.ts';
import { compact } from '../core/compact.ts';

/** Structural `SessionAuthContext` from `eve`. */
export type EvePrincipal = {
  readonly principalId: string;
  readonly principalType?: string;
  readonly authenticator?: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
};

/** Structural `ApprovalContext` from `eve/tools/approval`. */
export type EveApprovalContext = {
  readonly session?: {
    readonly id?: string;
    readonly auth?: {
      readonly initiator?: EvePrincipal | null;
      readonly current?: EvePrincipal | null;
    };
  };
  readonly callId?: string;
  readonly toolName: string;
  readonly toolInput?: unknown;
};

/** Structural `ApprovalResponseContext` from `eve/tools/approval`. */
export type EveResponseContext = {
  readonly request: {
    readonly callId: string;
    readonly requestId?: string;
    readonly toolName: string;
    readonly toolInput?: unknown;
  };
  /** Who answered and how; eve settles the request only on `allowed`. */
  readonly response: {
    readonly decision: 'approve' | 'cancel';
    readonly principal: EvePrincipal;
  };
  readonly session: {
    readonly id: string;
    readonly initiator: EvePrincipal | null;
  };
};

/** What `subject`, `actor` and `tenant` receive. */
export type EveContext = Pick<EveApprovalContext, 'session' | 'callId'>;

export type EveApprovers =
  | { readonly roles: readonly string[] }
  | ((responder: EvePrincipal, request: ApprovalRequest) => boolean);

export type EvePermDockOptions<TUser = unknown> = {
  readonly subject?: (context: EveContext) => TUser | Promise<TUser>;
  readonly actor?: (context: EveContext) => unknown;
  readonly delegation?: (
    context: EveContext,
  ) => Delegation | undefined | Promise<Delegation | undefined>;
  readonly tenant?:
    | string
    | ((
        context: EveContext,
      ) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
  readonly approvers?: EveApprovers;
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  /** The object graph for relation grants that walk a parent chain; without it they deny. */
  readonly relations?: RelationSource;
  readonly entitlements?: EntitlementSource;
  readonly customRoles?: RoleSource;
  /** Hosted grants, read once per instance; see `PolicySource`. */
  readonly policies?: PolicySource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  readonly snapshots?: SnapshotSource;
};

export type EveRequestResult =
  | 'not-applicable'
  | 'user-approval'
  | { readonly type: 'denied'; readonly reason: string };

export type EveResponseResult =
  | { readonly status: 'allowed' }
  | { readonly status: 'rejected'; readonly reason: string };

/** An eve `ApprovalConfiguration`: pass it as a tool's `approval`. */
export type EveApprovalPair = {
  readonly request: (ctx: EveApprovalContext) => Promise<EveRequestResult>;
  readonly response: (ctx: EveResponseContext) => Promise<EveResponseResult>;
};

export type EvePermDock = {
  readonly approval: EveApprovalPair;
  readonly approvalFor: (
    permission: Permission,
    data?: (input: unknown) => unknown,
  ) => EveApprovalPair;
  readonly permdock: (ctx: EveContext) => Promise<PermDock>;
};

const TOKENS_PER_PROCESS = 1000;

export function rolesOf(principal: EvePrincipal | null | undefined): string[] {
  const roles = principal?.attributes?.['roles'];
  if (typeof roles === 'string') {
    return [roles];
  }
  if (!Array.isArray(roles)) {
    return [];
  }
  return roles.filter((role): role is string => typeof role === 'string');
}

export function subjectFromSession(context: EveContext): unknown {
  const initiator = context.session?.auth?.initiator;
  if (initiator === undefined || initiator === null) {
    return null;
  }
  return { id: initiator.principalId, roles: rolesOf(initiator) };
}

export function actorFromSession(context: EveContext): unknown {
  const auth = context.session?.auth;
  const initiator = auth?.initiator;
  const current = auth?.current;
  if (
    current !== undefined &&
    current !== null &&
    initiator !== undefined &&
    initiator !== null &&
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
  responder: EvePrincipal,
  request: ApprovalRequest,
): boolean {
  if (approvers === undefined) {
    return true;
  }
  if (typeof approvers === 'function') {
    return approvers(responder, request);
  }
  const held = new Set(rolesOf(responder));
  return approvers.roles.some((role) => held.has(role));
}

function callKey(sessionId: string | undefined, callId: string): string {
  return JSON.stringify([sessionId ?? null, callId]);
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: EvePermDockOptions<TUser>,
): EvePermDock {
  const store = options.store ?? memoryApprovalStore();
  const tokensByCall = boundedMap<string, string>(TOKENS_PER_PROCESS);
  // SAFETY: without options.subject, TUser is the { id, roles } user subjectFromSession builds, or null.
  const kernel = createAgentKernel<EveContext, TUser>(policy, {
    ...compact({
      tenant: options.tenant,
      delegation: options.delegation,
      memberships: options.memberships,
      relations: options.relations,
      entitlements: options.entitlements,
      customRoles: options.customRoles,
      policies: options.policies,
      sink: options.sink,
      limits: options.limits,
      snapshots: options.snapshots,
    }),
    subject:
      options.subject ??
      (subjectFromSession as (context: EveContext) => TUser | Promise<TUser>),
    actor: options.actor ?? actorFromSession,
    tools: options.tools,
    store,
    adapter: 'eve',
  });

  // The responder is mapped by the same `subject` as an initiator, so the
  // approver carries the memberships and tenant the grant's `by` checks.
  const approverOf = async (
    responder: EvePrincipal,
    sessionId: string,
  ): Promise<Principal | null> => {
    try {
      const dock = await kernel.instance({
        session: {
          id: sessionId,
          auth: { initiator: responder, current: responder },
        },
      });
      return dock.subject.principal ?? null;
    } catch {
      return null;
    }
  };

  const pairFor = (
    bindingFor: (toolName: string) => ToolBinding | undefined,
  ): EveApprovalPair => {
    // eve re-runs `request` after a human answers and runs the tool on
    // anything but a denial, so a pending record for the same token is a
    // re-check that nobody approved.
    const request = async (
      ctx: EveApprovalContext,
    ): Promise<EveRequestResult> => {
      const binding = bindingFor(ctx.toolName);
      const verdict =
        binding === undefined
          ? await kernel.decideTool(ctx.toolName, ctx.toolInput, ctx)
          : await kernel.evaluate(binding, ctx.toolName, ctx.toolInput, ctx, {
              denyPending: true,
            });
      if (verdict.outcome === 'approval-required' && ctx.callId !== undefined) {
        tokensByCall.set(callKey(ctx.session?.id, ctx.callId), verdict.token);
      }
      return mapVerdict(verdict);
    };

    const tokenOf = (ctx: EveResponseContext): Promise<string | undefined> => {
      const cached = tokensByCall.get(
        callKey(ctx.session.id, ctx.request.callId),
      );
      if (cached !== undefined) {
        return Promise.resolve(cached);
      }
      const binding = bindingFor(ctx.request.toolName);
      if (binding === undefined) {
        return Promise.resolve(undefined);
      }
      const initiator = ctx.session.initiator;
      return kernel.tokenFor(binding, ctx.request.toolInput, {
        session: {
          id: ctx.session.id,
          auth: { initiator, current: initiator },
        },
        callId: ctx.request.callId,
      });
    };

    const response = async (
      ctx: EveResponseContext,
    ): Promise<EveResponseResult> => {
      const token = await tokenOf(ctx);
      if (token === undefined) {
        return { status: 'rejected', reason: 'approval-not-found' };
      }
      let current: ApprovalRequest | null;
      try {
        current = await store.get(token);
      } catch {
        current = null;
      }
      if (current === null) {
        return { status: 'rejected', reason: 'approval-not-found' };
      }
      const responder = ctx.response.principal;
      if (current.subject.actor?.id === responder.principalId) {
        return {
          status: 'rejected',
          reason: 'approver is the actor of this request',
        };
      }
      if (!mayApprove(options.approvers, responder, current)) {
        return { status: 'rejected', reason: 'approver is not eligible' };
      }
      const approver = await approverOf(responder, ctx.session.id);
      if (approver === null) {
        return { status: 'rejected', reason: 'approver is not eligible' };
      }
      try {
        await resolveApproval(store, token, {
          status: ctx.response.decision === 'approve' ? 'approved' : 'rejected',
          by: { principal: approver, context: {} },
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

  const approval = pairFor((toolName) =>
    Object.hasOwn(options.tools, toolName)
      ? options.tools[toolName]
      : undefined,
  );

  const approvalFor = (
    permission: Permission,
    data?: (input: unknown) => unknown,
  ): EveApprovalPair => {
    const binding: ToolBinding = compact({ permission, data });
    return pairFor(() => binding);
  };

  return {
    approval,
    approvalFor,
    permdock: (ctx) => kernel.instance(ctx),
  };
}
