import { o as Policy } from "../policy-CL40bNGn.js";
import { s as ApprovalStore } from "../types-DwRNNTg4.js";
import { c as RoleSource, d as SnapshotSource, r as DecisionSink, s as MembershipSource } from "../interfaces-BuUjSMjB.js";
//#region src/authzen/types.d.ts
type AuthzenResourceAdapter = {
  readonly load?: (id: string) => unknown;
  readonly list?: (query: {
    readonly where?: unknown;
  }) => readonly unknown[] | Promise<readonly unknown[]>;
};
type AuthzenSubjectRecord = {
  readonly id: string;
  readonly [key: string]: unknown;
};
type AuthzenPermDockOptions = {
  readonly subject: (request: Request) => unknown;
  readonly anonymous?: boolean;
  readonly trustedPep?: boolean;
  readonly resources?: Readonly<Record<string, AuthzenResourceAdapter>>;
  readonly subjects?: {
    readonly list?: () => readonly AuthzenSubjectRecord[] | Promise<readonly AuthzenSubjectRecord[]>;
  };
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly maxEvaluations?: number;
};
type AuthzenPermDock = {
  readonly handler: (request: Request) => Promise<Response>;
};
type AuthzenFactory = (policy: Policy, options: AuthzenPermDockOptions) => AuthzenPermDock;
//#endregion
//#region src/authzen/create.d.ts
export declare const createPermDock: AuthzenFactory;
//#endregion
export type { AuthzenFactory, AuthzenPermDock, AuthzenPermDockOptions, AuthzenResourceAdapter, AuthzenSubjectRecord };