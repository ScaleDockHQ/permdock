import { o as Policy, v as Permission } from "../policy-DsqYfECx.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { c as RoleSource, d as SnapshotSource, r as DecisionSink, s as MembershipSource } from "../interfaces-B19qT0zU.js";
import { t as ToolMap } from "../types-CWalSXVe.js";
//#region src/ai-sdk/create.d.ts
type AiSdkContext = {
  readonly runtimeContext?: unknown;
  readonly approval?: string;
  readonly token?: string;
  readonly [key: string]: unknown;
};
type AiSdkPermDockOptions = {
  readonly subject: (context: AiSdkContext) => unknown;
  readonly actor?: (context: AiSdkContext) => unknown;
  readonly tenant?: string | ((context: AiSdkContext) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};
type ToolApprovalStatus = "approved" | {
  readonly type: "denied";
  readonly reason: string;
} | {
  readonly type: "user-approval";
  readonly reason: string;
  readonly token: string;
};
type ToolApprovalCall = {
  readonly toolCall: {
    readonly toolName: string;
    readonly input?: unknown;
    readonly args?: unknown;
  };
  readonly runtimeContext?: unknown;
};
type LanguageModelMiddleware = {
  readonly specificationVersion: "v3";
  readonly transformParams: (options: {
    readonly params: {
      readonly tools?: Readonly<Record<string, unknown>> | readonly {
        readonly name?: string;
      }[];
    };
  }) => Promise<{
    readonly tools?: Readonly<Record<string, unknown>> | readonly {
      readonly name?: string;
    }[];
  }>;
};
type AiSdkPermDock = {
  readonly toolApproval: (call: ToolApprovalCall) => Promise<ToolApprovalStatus>;
  readonly capabilityMiddleware: LanguageModelMiddleware;
  readonly needsApproval: (permission: Permission) => (input: unknown, context?: AiSdkContext) => Promise<boolean>;
};
export declare function createPermDock(policy: Policy, options: AiSdkPermDockOptions): AiSdkPermDock;
//#endregion
export type { AiSdkContext, AiSdkPermDock, AiSdkPermDockOptions, LanguageModelMiddleware, ToolApprovalCall, ToolApprovalStatus };