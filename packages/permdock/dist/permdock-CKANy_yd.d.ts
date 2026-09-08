import { d as Delegation, g as Subject, m as Membership, o as Actor, t as Condition } from "./ast-BtUySn6K.js";
import { o as Policy, v as Permission } from "./policy-CL40bNGn.js";
import { n as Decision } from "./decision-Cjr-7xoX.js";
import { c as RoleSource, f as SnapshotV2, h as TokenSigner, n as DecisionEvent, r as DecisionSink, s as MembershipSource } from "./interfaces-BuUjSMjB.js";
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
  readonly session?: string;
  readonly expiresAt?: number;
};
declare function createPermDock(policy: Policy, user: unknown, options?: CreatePermDockOptions): PermDock | Promise<PermDock>;
//#endregion
export { WhereResult as a, fromSnapshot as c, describe as d, RowPair as i, parseSnapshot as l, DecideOptions as n, createPermDock as o, PermDock as r, emptySnapshot as s, CreatePermDockOptions as t, DecisionDescription as u };