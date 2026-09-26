import type { ApprovalStore } from '../approvals/types.ts';
import type { ProblemDetails } from '../core/errors.ts';
import type {
  DecisionSink,
  LimitStore,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { Permission } from '../core/permissions.ts';
import type { AuthorizationDetail } from '../core/subject.ts';

export type A2AAuth = {
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly extra?: {
    readonly authorizationDetails?: readonly AuthorizationDetail[];
    readonly approval?: string;
  };
};

export type A2ASecurityScheme = {
  readonly type: string;
  readonly oauth2MetadataUrl?: string;
  readonly scheme?: string;
};

export type A2ACardInfo = {
  readonly name: string;
  readonly url: string;
  readonly version: string;
  readonly description?: string;
};

export type A2ASkillConfig = {
  readonly permission: Permission;
  readonly description?: string;
  readonly data?: (task: unknown) => Promise<unknown>;
};

export type A2ASkill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly securityRequirements: readonly Readonly<
    Record<string, readonly string[]>
  >[];
};

export type A2AAgentCard = {
  readonly name: string;
  readonly description?: string;
  readonly url: string;
  readonly version: string;
  readonly protocolVersion: '1.0';
  readonly securitySchemes: Readonly<Record<string, A2ASecurityScheme>>;
  readonly skills: readonly A2ASkill[];
};

export type A2ATaskOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 401 | 403;
      readonly state: 'failed' | 'input-required';
      readonly problem: ProblemDetails;
      readonly wwwAuthenticate?: string;
    };

export type A2APermDockOptions<TUser = unknown> = {
  readonly subject: (auth: A2AAuth) => TUser | Promise<TUser>;
  readonly card: A2ACardInfo;
  readonly securitySchemes: Readonly<Record<string, A2ASecurityScheme>>;
  readonly skills: Readonly<Record<string, A2ASkillConfig>>;
  readonly tenant?:
    | string
    | ((auth: A2AAuth) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  readonly snapshots?: SnapshotSource;
};

export type A2APermDock = {
  readonly agentCard: () => A2AAgentCard;
  readonly extendedAgentCard: (auth: A2AAuth) => Promise<A2AAgentCard>;
  readonly protectSkill: (
    selector: (task: unknown) => string,
  ) => (task: unknown, auth: A2AAuth) => Promise<A2ATaskOutcome>;
  readonly sign: (
    card: A2AAgentCard,
    sign: (payload: string) => Promise<string>,
  ) => Promise<{ readonly card: A2AAgentCard; readonly signature: string }>;
};
