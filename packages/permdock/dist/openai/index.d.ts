import { E as RoleSource, J as Permission, T as MembershipSource, k as SnapshotSource, o as Policy, y as DecisionSink } from "../policy-CrXDbTAD.js";
import { i as ApprovalRequest, s as ApprovalStore } from "../types-D19MSDwi.js";
import { t as ToolMap } from "../types-qPObTMW1.js";
import { r as PermDock } from "../permdock-DlRpl_Uu.js";
//#region src/openai/create.d.ts
type OpenAiContext = {
  readonly user?: unknown;
  readonly agentId?: string;
  readonly approval?: string;
  readonly token?: string;
  readonly [key: string]: unknown;
};
type OpenAiPermDockOptions = {
  readonly subject: (context: OpenAiContext) => unknown;
  readonly actor?: (context: OpenAiContext) => unknown;
  readonly tenant?: string | ((context: OpenAiContext) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};
type OpenAiTool = {
  readonly name: string;
};
type OpenAiInterruption = {
  readonly callId: string;
  readonly rawItem?: {
    readonly name?: string;
    readonly arguments?: unknown;
  };
};
type OpenAiRunState = {
  approve(interruption: OpenAiInterruption): void | Promise<void>;
  reject(interruption: OpenAiInterruption, options?: {
    readonly message?: string;
  }): void | Promise<void>;
};
type OpenAiPermDock = {
  readonly needsApproval: (permission: Permission) => (context: OpenAiContext, args: unknown) => Promise<boolean>;
  readonly guardTools: <T extends OpenAiTool>(tools: readonly T[], context: OpenAiContext) => Promise<readonly T[]>;
  readonly resolveInterruptions: (state: OpenAiRunState, interruptions: readonly OpenAiInterruption[], options: {
    readonly context: OpenAiContext;
  }) => Promise<readonly ApprovalRequest[]>;
  readonly permdock: (context: OpenAiContext) => Promise<PermDock>;
};
export declare function createPermDock(policy: Policy, options: OpenAiPermDockOptions): OpenAiPermDock;
//#endregion
export type { OpenAiContext, OpenAiInterruption, OpenAiPermDock, OpenAiPermDockOptions, OpenAiRunState, OpenAiTool };