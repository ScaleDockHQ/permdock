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
import type { Policy } from "../core/policy.ts";
import type { Principal } from "../core/subject.ts";

export type AuthzenResourceAdapter = {
  readonly load?: (id: string) => unknown;
  readonly list?: (query: {
    readonly where?: unknown;
  }) => readonly unknown[] | Promise<readonly unknown[]>;
};

export type AuthzenSubjectRecord = {
  readonly id: string;
  readonly [key: string]: unknown;
};

export type AuthzenPermDockOptions<TUser = unknown> = {
  readonly subject: (request: Request) => TUser | Promise<TUser>;
  readonly anonymous?: boolean;
  /**
   * Allow-list over the authenticated PEP. Only a PEP it returns `true` for
   * may evaluate the body's `subject`, `actor` and `delegation`; every other
   * caller is evaluated as itself. Off by default.
   */
  readonly trustedPep?: (pep: unknown) => boolean;
  readonly resources?: Readonly<Record<string, AuthzenResourceAdapter>>;
  readonly subjects?: {
    readonly list?: () =>
      | readonly AuthzenSubjectRecord[]
      | Promise<readonly AuthzenSubjectRecord[]>;
  };
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
  readonly maxEvaluations?: number;
};

export type AuthzenPermDock = {
  readonly permdockHandler: (request: Request) => Promise<Response>;
};

export type AuthzenFactory = <TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: AuthzenPermDockOptions<TUser>,
) => AuthzenPermDock;
