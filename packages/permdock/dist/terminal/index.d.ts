import { g as Subject } from "../ast-BtUySn6K.js";
import { o as Policy, v as Permission } from "../policy-CL40bNGn.js";
import { s as ApprovalStore } from "../types-DwRNNTg4.js";
import { n as Decision } from "../decision-Cjr-7xoX.js";
import { i as ProblemDetails } from "../errors-DZNvOxVD.js";
import { c as RoleSource, r as DecisionSink, s as MembershipSource } from "../interfaces-BuUjSMjB.js";
import { r as PermDock } from "../permdock-CKANy_yd.js";
//#region src/terminal/types.d.ts
type TokenSourceName = "device" | "keychain" | "env" | "ci-oidc";
type TokenSource = TokenSourceName | {
  readonly env: string;
} | {
  readonly source: TokenSourceName;
  readonly env?: string;
};
type TokenHelper = (sources: readonly TokenSource[]) => Promise<string | null>;
type TokenContext = {
  readonly token: TokenHelper;
  readonly profile: string;
};
type DeviceFlowOptions = {
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
type InteractiveConfirm = (input: {
  readonly permission: string;
  readonly resource: {
    readonly type: string;
    readonly id?: string;
  };
  readonly reason: string;
  readonly token: string;
}) => Promise<boolean>;
type TerminalRuntime = {
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
type TerminalStorageOptions = {
  readonly service: string;
  readonly dir?: string;
};
type ApprovalHint = {
  readonly at?: string;
  readonly hint?: string;
};
type TerminalPermDockOptions = {
  readonly subject: (context: TokenContext) => unknown;
  readonly actor?: (context: TokenContext) => unknown;
  readonly tenant?: string;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly storage?: TerminalStorageOptions;
  readonly device?: DeviceFlowOptions;
  readonly interactive?: boolean | {
    readonly confirm: InteractiveConfirm;
  };
  readonly output?: {
    readonly json?: boolean;
  };
  readonly approval?: ApprovalHint;
  readonly runtime?: TerminalRuntime;
};
type PermDockResolveOptions = {
  readonly refresh?: boolean;
  readonly source?: TokenSourceName;
  readonly as?: string;
};
type CommandEntry = {
  readonly name: string;
  readonly permission: Permission;
  readonly description: string;
};
type FilterCommandsOptions = {
  readonly mode: "hide" | "annotate";
  readonly permdock?: PermDock;
};
type FormatOptions = {
  readonly json?: boolean;
  readonly permission?: Permission;
  readonly instance?: string;
  readonly subject?: Subject;
  readonly approval?: ApprovalHint;
};
type TerminalProblemDetails = ProblemDetails & {
  readonly approval?: ApprovalHint;
};
type ProtectContext<T = unknown> = {
  readonly permdock: PermDock;
  readonly data: T;
  readonly decision: Extract<Decision, {
    readonly outcome: "granted";
  }>;
};
type TerminalPermDock = {
  readonly permdock: (options?: PermDockResolveOptions) => Promise<PermDock>;
  readonly protect: <TArgs extends readonly unknown[], TData = unknown>(permission: Permission, load?: (...args: TArgs) => TData | Promise<TData>) => (action: (context: ProtectContext<TData>, ...args: TArgs) => unknown) => (...args: TArgs) => Promise<unknown>;
  readonly filterCommands: (entries: readonly CommandEntry[], options?: FilterCommandsOptions) => readonly CommandEntry[];
  readonly format: (decision: Decision, options?: FormatOptions) => string;
  readonly exitCode: (decision: Decision) => number;
  readonly logout: () => Promise<void>;
};
//#endregion
//#region src/terminal/create.d.ts
export declare function createPermDock(policy: Policy, options: TerminalPermDockOptions): TerminalPermDock;
//#endregion
//#region src/terminal/exit.d.ts
export declare const EX_OK = 0;
export declare const EX_TEMPFAIL = 75;
export declare const EX_NOPERM = 77;
export declare const EX_CONFIG = 78;
export declare class TerminalExit extends Error {
  override readonly name: "TerminalExit";
  readonly code: number;
  constructor(code: number);
}
//#endregion
//#region src/terminal/format.d.ts
export declare function exitCode(decision: Decision): number;
export declare function formatDecision(decision: Decision, options?: FormatOptions): string;
//#endregion
//#region src/terminal/token.d.ts
export declare function looksLikeJwt(value: string): boolean;
//#endregion
export type { CommandEntry, DeviceFlowOptions, FilterCommandsOptions, FormatOptions, PermDockResolveOptions, ProtectContext, TerminalPermDock, TerminalPermDockOptions, TerminalProblemDetails, TerminalRuntime, TokenContext, TokenHelper, TokenSource, TokenSourceName };