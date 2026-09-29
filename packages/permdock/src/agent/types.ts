import type { ApprovalStore } from '../approvals/types.ts';
import type { Decision } from '../core/decision.ts';
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
import type { Permission } from '../core/permissions.ts';
import type { Delegation } from '../core/subject.ts';

export type ToolBinding = {
  readonly permission: Permission;
  readonly data?: (args: unknown) => unknown;
};

export type ToolMap = Readonly<Record<string, ToolBinding>>;

export type AgentKernelOptions<TContext, TUser = unknown> = {
  readonly subject: (context: TContext) => TUser | Promise<TUser>;
  readonly actor?: (context: TContext) => unknown;
  readonly delegation?: (
    context: TContext,
  ) => Delegation | undefined | Promise<Delegation | undefined>;
  readonly tenant?:
    | string
    | ((context: TContext) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
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
  readonly adapter: string;
};

export type ToolVerdict =
  | {
      readonly outcome: 'granted';
      readonly decision: Extract<Decision, { readonly outcome: 'granted' }>;
      readonly permission: Permission;
      readonly data: unknown;
    }
  | {
      readonly outcome: 'denied';
      readonly decision: Extract<
        Decision,
        { readonly outcome: 'denied' }
      > | null;
      readonly permission: Permission | undefined;
      readonly reason: string;
    }
  | {
      readonly outcome: 'approval-required';
      readonly decision: Extract<
        Decision,
        { readonly outcome: 'approval-required' }
      >;
      readonly permission: Permission;
      readonly data: unknown;
      readonly token: string;
      readonly summary: string;
    };

export type DecideToolOptions = {
  readonly resumeToken?: string;
  /**
   * Treat an existing pending record as a re-check of a call that already
   * asked: deny with `approval-pending` instead of asking again. For runtimes
   * that re-run the approval hook after a human answers and run the tool on
   * anything but a denial.
   */
  readonly denyPending?: boolean;
};
