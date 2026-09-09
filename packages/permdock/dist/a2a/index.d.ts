import { r as AuthorizationDetail } from "../subject-BcgWbogX.js";
import { E as RoleSource, J as Permission, T as MembershipSource, k as SnapshotSource, o as Policy, y as DecisionSink } from "../policy-btMlTuxm.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { i as ProblemDetails } from "../errors-BQ3WJ6qi.js";
//#region src/a2a/types.d.ts
type A2AAuth = {
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly extra?: {
    readonly authorizationDetails?: readonly AuthorizationDetail[];
    readonly approval?: string;
  };
};
type A2ASecurityScheme = {
  readonly type: string;
  readonly oauth2MetadataUrl?: string;
  readonly scheme?: string;
};
type A2ACardInfo = {
  readonly name: string;
  readonly url: string;
  readonly version: string;
  readonly description?: string;
};
type A2ASkillConfig = {
  readonly permission: Permission;
  readonly description?: string;
  readonly data?: (task: unknown) => Promise<unknown>;
};
type A2ASkill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly securityRequirements: readonly Readonly<Record<string, readonly string[]>>[];
};
type A2AAgentCard = {
  readonly name: string;
  readonly description?: string;
  readonly url: string;
  readonly version: string;
  readonly protocolVersion: "1.0";
  readonly securitySchemes: Readonly<Record<string, A2ASecurityScheme>>;
  readonly skills: readonly A2ASkill[];
};
type A2ATaskOutcome = {
  readonly ok: true;
} | {
  readonly ok: false;
  readonly status: 401 | 403;
  readonly state: "failed" | "input-required";
  readonly problem: ProblemDetails;
  readonly wwwAuthenticate?: string;
};
type A2APermDockOptions = {
  readonly subject: (auth: A2AAuth) => unknown;
  readonly card: A2ACardInfo;
  readonly securitySchemes: Readonly<Record<string, A2ASecurityScheme>>;
  readonly skills: Readonly<Record<string, A2ASkillConfig>>;
  readonly tenant?: string | ((auth: A2AAuth) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};
type A2APermDock = {
  readonly agentCard: () => A2AAgentCard;
  readonly extendedAgentCard: (auth: A2AAuth) => Promise<A2AAgentCard>;
  readonly protectSkill: (selector: (task: unknown) => string) => (task: unknown, auth: A2AAuth) => Promise<A2ATaskOutcome>;
  readonly sign: (card: A2AAgentCard, sign: (payload: string) => Promise<string>) => Promise<{
    readonly card: A2AAgentCard;
    readonly signature: string;
  }>;
};
//#endregion
//#region src/a2a/create.d.ts
export declare function createPermDock(policy: Policy, options: A2APermDockOptions): A2APermDock;
//#endregion
export type { A2AAgentCard, A2AAuth, A2ACardInfo, A2APermDock, A2APermDockOptions, A2ASecurityScheme, A2ASkill, A2ASkillConfig, A2ATaskOutcome };