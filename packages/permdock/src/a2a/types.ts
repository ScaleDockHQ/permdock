import type { ApprovalStore } from "../approvals/types.ts";
import type { ProblemDetails } from "../core/errors.ts";
import type { PolicySource } from "../core/hosted.ts";
import type {
  DecisionSink,
  EntitlementSource,
  LimitStore,
  MembershipSource,
  RelationSource,
  RoleSource,
  SnapshotSource,
} from "../core/interfaces.ts";
import type { Permission } from "../core/permissions.ts";
import type { AuthorizationDetail } from "../core/subject.ts";

export type A2aAuth = {
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly extra?: {
    readonly authorizationDetails?: readonly AuthorizationDetail[];
    readonly approval?: string;
  };
};

/** OpenAPI-style input; the card carries the A2A 1.0 union form. */
export type A2aSecurityScheme =
  | {
      readonly type: "oauth2";
      readonly oauth2MetadataUrl: string;
      readonly description?: string;
    }
  | {
      readonly type: "http";
      readonly scheme: string;
      readonly bearerFormat?: string;
      readonly description?: string;
    }
  | {
      readonly type: "openIdConnect";
      readonly openIdConnectUrl: string;
      readonly description?: string;
    }
  | { readonly type: "mutualTLS"; readonly description?: string }
  | {
      readonly type: "apiKey";
      readonly in: "query" | "header" | "cookie";
      readonly name: string;
      readonly description?: string;
    };

/** A2A 1.0 `SecurityScheme`: exactly one member set. */
export type A2aWireSecurityScheme =
  | {
      readonly oauth2SecurityScheme: {
        readonly oauth2MetadataUrl: string;
        readonly description?: string;
      };
    }
  | {
      readonly httpAuthSecurityScheme: {
        readonly scheme: string;
        readonly bearerFormat?: string;
        readonly description?: string;
      };
    }
  | {
      readonly openIdConnectSecurityScheme: {
        readonly openIdConnectUrl: string;
        readonly description?: string;
      };
    }
  | { readonly mtlsSecurityScheme: { readonly description?: string } }
  | {
      readonly apiKeySecurityScheme: {
        readonly location: "query" | "header" | "cookie";
        readonly name: string;
        readonly description?: string;
      };
    };

export type A2aCardInfo = {
  readonly name: string;
  /** Required by A2A 1.0; defaults to `name`. */
  readonly description?: string;
  /** The preferred interface URL, the first `supportedInterfaces` entry. */
  readonly url: string;
  readonly version: string;
  /** Defaults to `JSONRPC`. */
  readonly protocolBinding?: "JSONRPC" | "GRPC" | "HTTP+JSON";
  readonly provider?: { readonly organization: string; readonly url: string };
  readonly documentationUrl?: string;
  readonly iconUrl?: string;
  /** Media types; default `['text/plain']`. */
  readonly defaultInputModes?: readonly string[];
  readonly defaultOutputModes?: readonly string[];
  readonly streaming?: boolean;
  readonly pushNotifications?: boolean;
};

export type A2aSkillConfig = {
  readonly permission: Permission;
  readonly description?: string;
  /** Required by A2A 1.0; defaults to the permission's resource. */
  readonly tags?: readonly string[];
  readonly data?: (task: unknown) => Promise<unknown>;
};

/** A2A 1.0 `SecurityRequirement`: scheme name to required scopes. */
export type A2aSecurityRequirement = {
  readonly schemes: Readonly<
    Record<string, { readonly list: readonly string[] }>
  >;
};

export type A2aSkill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly securityRequirements: readonly A2aSecurityRequirement[];
};

/** A2A 1.0 `AgentCardSignature`: a JWS over the card without `signatures`. */
export type A2aAgentCardSignature = {
  readonly protected: string;
  readonly signature: string;
};

export type A2aAgentCard = {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly supportedInterfaces: readonly {
    readonly url: string;
    readonly protocolBinding: string;
    readonly protocolVersion: "1.0";
  }[];
  readonly provider?: { readonly organization: string; readonly url: string };
  readonly documentationUrl?: string;
  readonly iconUrl?: string;
  readonly capabilities: {
    readonly extendedAgentCard: true;
    readonly streaming?: boolean;
    readonly pushNotifications?: boolean;
  };
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly securitySchemes: Readonly<Record<string, A2aWireSecurityScheme>>;
  readonly skills: readonly A2aSkill[];
  readonly signatures?: readonly A2aAgentCardSignature[];
};

export type A2aTaskOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 401 | 403;
      readonly state: "failed" | "input-required";
      readonly problem: ProblemDetails;
      readonly wwwAuthenticate?: string;
    };

export type A2aPermDockOptions<TUser = unknown> = {
  readonly subject: (auth: A2aAuth) => TUser | Promise<TUser>;
  readonly card: A2aCardInfo;
  readonly securitySchemes: Readonly<Record<string, A2aSecurityScheme>>;
  readonly skills: Readonly<Record<string, A2aSkillConfig>>;
  readonly tenant?:
    | string
    | ((auth: A2aAuth) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  /** The object graph for relation grants that walk a parent chain; without it they deny. */
  readonly relations?: RelationSource;
  readonly entitlements?: EntitlementSource;
  readonly customRoles?: RoleSource;
  /** Hosted grants, read once per instance; see `PolicySource`. */
  readonly policies?: PolicySource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  readonly snapshots?: SnapshotSource;
};

export type A2aPermDock = {
  readonly agentCard: () => A2aAgentCard;
  readonly extendedAgentCard: (auth: A2aAuth) => Promise<A2aAgentCard>;
  readonly protectSkill: (
    selector: (task: unknown) => string,
  ) => (task: unknown, auth: A2aAuth) => Promise<A2aTaskOutcome>;
  /**
   * Appends an A2A 1.0 signature. `sign` returns a compact JWS over the
   * RFC 8785 canonical card it is given; the payload is detached.
   */
  readonly sign: (
    card: A2aAgentCard,
    sign: (payload: string) => Promise<string>,
  ) => Promise<A2aAgentCard>;
};
