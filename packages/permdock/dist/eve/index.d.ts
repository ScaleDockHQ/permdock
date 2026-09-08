import { l as SnapshotSource, o as MembershipSource, r as DecisionSink, s as RoleSource } from "../interfaces-CnUn1fRe.js";
import { i as ApprovalRequest, s as ApprovalStore } from "../types-DzwcM0QE.js";
import { T as Permission, p as Policy } from "../decision-B2jL7xrt.js";
import { t as ToolMap } from "../types-DhFmgz_o.js";
import { r as PermDock } from "../permdock-DN6lGjHN.js";
//#region src/eve/create.d.ts
type EvePrincipal = {
  readonly principalId: string;
  readonly principalType?: string;
  readonly authenticator?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
};
type EveContext = {
  readonly session?: {
    readonly auth?: {
      readonly initiator?: EvePrincipal;
      readonly current?: EvePrincipal;
    };
  };
  readonly callId?: string;
  readonly token?: string;
};
type EveApprovalArgs = {
  readonly toolName: string;
  readonly toolInput?: unknown;
  readonly callId?: string;
};
type EveResponder = {
  readonly principalId: string;
  readonly roles?: readonly string[];
};
type EveApprovers = {
  readonly roles: readonly string[];
} | ((responder: EveResponder, request: ApprovalRequest) => boolean);
type EvePermDockOptions = {
  readonly subject?: (context: EveContext) => unknown;
  readonly actor?: (context: EveContext) => unknown;
  readonly tenant?: string | ((context: EveContext) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
  readonly approvers?: EveApprovers;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};
type EveRequestResult = "not-applicable" | "user-approval" | {
  readonly type: "denied";
  readonly reason: string;
};
type EveResponseResult = {
  readonly status: "allowed";
} | {
  readonly status: "rejected";
  readonly reason: string;
};
type EveApprovalPair = {
  readonly request: (ctx: EveContext, args: EveApprovalArgs) => Promise<EveRequestResult>;
  readonly response: (responder: EveResponder, args: {
    readonly callId?: string;
    readonly token?: string;
  }) => Promise<EveResponseResult>;
};
type EvePermDock = {
  readonly approval: EveApprovalPair;
  readonly approvalFor: (permission: Permission, data?: (input: unknown) => unknown) => EveApprovalPair;
  readonly permdock: (ctx: EveContext) => Promise<PermDock>;
};
export declare function subjectFromSession(context: EveContext): unknown;
export declare function actorFromSession(context: EveContext): unknown;
export declare function createPermDock(policy: Policy, options: EvePermDockOptions): EvePermDock;
//#endregion
export type { EveApprovalArgs, EveApprovalPair, EveApprovers, EveContext, EvePermDock, EvePermDockOptions, EvePrincipal, EveRequestResult, EveResponder, EveResponseResult };