import type { ApprovalStore } from "../approvals/types.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
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

export type AuthzenPermDockOptions<TUser = unknown> = InstanceOptions & {
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
  readonly store?: ApprovalStore;
  readonly maxEvaluations?: number;
};

export type AuthzenPermDock = {
  readonly permdockHandler: (request: Request) => Promise<Response>;
};

export type AuthzenFactory = <TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: AuthzenPermDockOptions<TUser>,
) => AuthzenPermDock;
