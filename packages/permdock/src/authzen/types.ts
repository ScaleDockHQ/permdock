import type { ApprovalStore } from '../approvals/types.ts';
import type {
  DecisionSink,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { Policy } from '../core/policy.ts';

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

export type AuthzenPermDockOptions = {
  readonly subject: (request: Request) => unknown;
  readonly anonymous?: boolean;
  readonly trustedPep?: boolean;
  readonly resources?: Readonly<Record<string, AuthzenResourceAdapter>>;
  readonly subjects?: {
    readonly list?: () =>
      | readonly AuthzenSubjectRecord[]
      | Promise<readonly AuthzenSubjectRecord[]>;
  };
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly maxEvaluations?: number;
};

export type AuthzenPermDock = {
  readonly handler: (request: Request) => Promise<Response>;
};

export type AuthzenFactory = (
  policy: Policy,
  options: AuthzenPermDockOptions,
) => AuthzenPermDock;
