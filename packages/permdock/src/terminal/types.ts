import type { ApprovalStore } from '../approvals/types.ts';
import type { Decision } from '../core/decision.ts';
import type { ProblemDetails } from '../core/errors.ts';
import type {
  DecisionSink,
  MembershipSource,
  RoleSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Actor, Delegation, Subject } from '../core/subject.ts';

export type TokenSourceName = 'device' | 'keychain' | 'env' | 'ci-oidc';

export type TokenSource =
  | TokenSourceName
  | { readonly env: string }
  | { readonly source: TokenSourceName; readonly env?: string };

export type TokenHelper = (
  sources: readonly TokenSource[],
) => Promise<string | null>;

export type TokenContext = {
  readonly token: TokenHelper;
  readonly profile: string;
};

export type StoredCredential = {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_at?: number;
  readonly token_type?: string;
};

export type DeviceFlowOptions = {
  readonly issuer?: string;
  readonly clientId: string;
  readonly scope?: string;
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly revocationEndpoint?: string;
  readonly open?: (url: string) => void;
  readonly onPrompt?: (info: {
    readonly user_code: string;
    readonly verification_uri: string;
    readonly verification_uri_complete?: string;
  }) => void;
};

export type InteractiveConfirm = (input: {
  readonly permission: string;
  readonly resource: { readonly type: string; readonly id?: string };
  readonly reason: string;
  readonly token: string;
}) => Promise<boolean>;

export type TerminalRuntime = {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdoutIsTTY?: boolean;
  readonly platform?: string;
  readonly now?: () => number;
  readonly write?: (text: string) => void;
  readonly exit?: (code: number) => never;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly homedir?: () => string;
  readonly configDir?: string;
};

export type TerminalStorageOptions = {
  readonly service: string;
  readonly dir?: string;
};

export type ApprovalHint = {
  readonly at?: string;
  readonly hint?: string;
};

export type TerminalPermDockOptions<TUser = unknown> = {
  readonly subject: (context: TokenContext) => TUser | Promise<TUser>;
  readonly actor?: (context: TokenContext) => unknown;
  readonly tenant?: string;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly storage?: TerminalStorageOptions;
  readonly device?: DeviceFlowOptions;
  readonly interactive?: boolean | { readonly confirm: InteractiveConfirm };
  readonly output?: { readonly json?: boolean };
  readonly approval?: ApprovalHint;
  readonly runtime?: TerminalRuntime;
};

export type PermDockResolveOptions = {
  readonly refresh?: boolean;
  readonly source?: TokenSourceName;
  readonly as?: string;
};

export type CommandEntry = {
  readonly name: string;
  readonly permission: Permission;
  readonly description: string;
};

export type FilterCommandsOptions = {
  readonly mode: 'hide' | 'annotate';
  readonly permdock?: PermDock;
};

export type FormatOptions = {
  readonly json?: boolean;
  readonly permission?: Permission;
  readonly instance?: string;
  readonly subject?: Subject;
  readonly approval?: ApprovalHint;
};

export type TerminalProblemDetails = ProblemDetails & {
  readonly approval?: ApprovalHint;
};

export type ProtectContext<T = unknown> = {
  readonly permdock: PermDock;
  readonly data: T;
  readonly decision: Extract<Decision, { readonly outcome: 'granted' }>;
};

export type TerminalActor = {
  readonly actor?: Actor;
  readonly delegation?: Delegation;
};

export type TerminalPermDock = {
  readonly permdock: (options?: PermDockResolveOptions) => Promise<PermDock>;
  readonly protect: <TArgs extends readonly unknown[], TData = unknown>(
    permission: Permission,
    load?: (...args: TArgs) => TData | Promise<TData>,
  ) => (
    action: (context: ProtectContext<TData>, ...args: TArgs) => unknown,
  ) => (...args: TArgs) => Promise<unknown>;
  readonly filterCommands: (
    entries: readonly CommandEntry[],
    options?: FilterCommandsOptions,
  ) => readonly CommandEntry[];
  readonly format: (decision: Decision, options?: FormatOptions) => string;
  readonly exitCode: (decision: Decision) => number;
  readonly logout: () => Promise<void>;
};
