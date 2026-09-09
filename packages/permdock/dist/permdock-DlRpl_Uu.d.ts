import { d as Subject, l as Membership, o as Delegation, t as Actor } from "./subject-BcgWbogX.js";
import { A as SnapshotV2, B as Decision, E as RoleSource, J as Permission, N as TokenSigner, T as MembershipSource, _ as DecisionEvent, o as Policy, st as Condition, w as LimitStore, y as DecisionSink } from "./policy-CrXDbTAD.js";
//#region src/core/describe.d.ts
type DecisionDescription = {
  readonly kind: "granted" | "denied" | "approval" | "tenant" | "delegation" | "server-only";
  readonly title: string;
  readonly detail: string;
  readonly alternatives: readonly Permission[];
};
declare function describe(decision: Decision): DecisionDescription;
//#endregion
//#region src/core/snapshot.d.ts
declare function parseSnapshot(json: unknown): SnapshotV2;
//#endregion
//#region src/core/validation.d.ts
type Boundary = "http-body" | "mcp-args" | "tool-args" | "decision-endpoint" | "manual";
//#endregion
//#region src/core/from-snapshot.d.ts
declare function fromSnapshot(snapshot: SnapshotV2, options?: {
  readonly tenant?: string;
  readonly team?: string;
}): PermDock;
declare function emptySnapshot(): SnapshotV2;
//#endregion
//#region src/core/permdock.d.ts
type DecideOptions = {
  readonly trusted?: boolean;
  readonly boundary?: Boundary;
  readonly now?: number;
  readonly source?: DecisionEvent["source"];
  readonly adapter?: string;
  readonly onDenied?: (decision: Decision) => never | void;
  readonly field?: string;
};
type RowPair<T> = {
  readonly current: T;
  readonly next: T;
};
type WhereResult = {
  readonly condition: Condition | {
    readonly op: "or";
    readonly conditions: readonly [];
  };
  readonly partial: boolean;
};
type PermDock = {
  readonly can: {
    (permission: Permission<string, unknown, "instance">, data: unknown, options?: DecideOptions): boolean;
    (permission: Permission<string, unknown, "collection">, data?: unknown, options?: DecideOptions): boolean;
  };
  readonly decide: {
    (permission: Permission<string, unknown, "instance">, data: unknown, options?: DecideOptions): Decision;
    (permission: Permission<string, unknown, "collection">, data?: unknown, options?: DecideOptions): Decision;
  };
  readonly assert: {
    (permission: Permission<string, unknown, "instance">, data: unknown, options?: DecideOptions): Extract<Decision, {
      readonly outcome: "granted";
    }>;
    (permission: Permission<string, unknown, "collection">, data?: unknown, options?: DecideOptions): Extract<Decision, {
      readonly outcome: "granted";
    }>;
  };
  readonly filter: <T>(permission: Permission<string, T, "instance">, rows: readonly T[], options?: DecideOptions) => T[];
  readonly pick: <T>(permission: Permission<string, T, "instance">, row: T, options?: DecideOptions) => Partial<T>;
  readonly where: (permission: Permission) => WhereResult;
  readonly simulate: {
    (checks: readonly (readonly [Permission, unknown?])[]): Decision[];
    (preview: {
      readonly roles?: readonly string[];
      readonly memberships?: readonly Membership[];
      readonly tenant?: string;
    }): PermDock;
  };
  readonly snapshot: (options?: {
    readonly include?: readonly (Permission | {
      readonly [key: string]: unknown;
    })[];
    readonly tenants?: "all";
    readonly signer?: TokenSigner;
    readonly audience?: string | readonly string[];
  }) => SnapshotV2 | Promise<string>;
  readonly on: (event: "decision" | "denied" | "approval" | "auth" | "error", handler: (payload: unknown) => void) => () => void;
  readonly tenant: (id: string) => PermDock;
  readonly team: (id: string) => PermDock;
  readonly memberships: () => readonly Membership[];
  readonly tenants: () => readonly string[];
  readonly roles: (options?: {
    readonly tenant?: string;
  }) => readonly string[];
  readonly assignable: () => readonly string[];
  readonly subject: Subject;
};
type CreatePermDockOptions = {
  readonly tenant?: string;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  readonly session?: string;
  readonly expiresAt?: number;
};
declare function createPermDock(policy: Policy, user: unknown, options?: CreatePermDockOptions): PermDock | Promise<PermDock>;
//#endregion
export { WhereResult as a, fromSnapshot as c, describe as d, RowPair as i, parseSnapshot as l, DecideOptions as n, createPermDock as o, PermDock as r, emptySnapshot as s, CreatePermDockOptions as t, DecisionDescription as u };