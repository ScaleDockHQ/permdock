import { M as TokenFailureCause, P as TokenVerifier, o as Policy } from "../policy-btMlTuxm.js";
import { c as JwtJwks, t as DiscoveryInput } from "../types-DCGm4-_E.js";
//#region src/ssf/types.d.ts
type CaepEventName = "session-revoked" | "credential-change" | "assurance-level-change" | "token-claims-change" | "device-compliance-change";
type SetSubject = {
  readonly format: string;
  readonly [key: string]: unknown;
};
type SsfSubject = {
  readonly id: string;
  readonly session?: string;
  readonly issuer?: string;
};
type SsfSubjectMapper = (setSubject: SetSubject, meta?: {
  readonly session?: string;
  readonly issuer?: string;
}) => string | SsfSubject | null | undefined | Promise<string | SsfSubject | null | undefined>;
type SsfEventInput = {
  readonly subject: SsfSubject;
  readonly event: Readonly<Record<string, unknown>>;
  readonly event_timestamp?: number;
  readonly jti: string;
  readonly type: string;
};
type SsfEventHandler = (input: SsfEventInput) => void | Promise<void>;
type SsfOnEvent = { readonly [K in CaepEventName]?: SsfEventHandler; } & {
  readonly "*"?: SsfEventHandler;
};
type ReplayStore = {
  seen(jti: string): boolean | Promise<boolean>;
  remember(jti: string): void | Promise<void>;
};
type SsfAuditEvent = {
  readonly type: string;
  readonly subject?: SsfSubject;
  readonly transmitter?: string;
  readonly jti?: string;
  readonly replayed?: true;
  readonly unknown?: "event" | "subject";
  readonly err?: string;
  readonly cause?: TokenFailureCause;
};
type SsfEventListener = (event: SsfAuditEvent) => void;
type PollOptions = {
  readonly endpoint: string;
  readonly every?: number | string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
};
type PollHandle = {
  readonly stop: () => void;
};
type PollResult = {
  readonly acked: readonly string[];
};
type SsfOptions = {
  readonly issuer?: string;
  readonly audience: string | readonly string[];
  readonly jwks?: JwtJwks | string;
  readonly discovery?: DiscoveryInput;
  readonly verifier?: TokenVerifier;
  readonly subject: SsfSubjectMapper;
  readonly onEvent?: SsfOnEvent;
  readonly replay?: ReplayStore;
  readonly clockTolerance?: number;
};
type SsfReceiver = {
  push(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
  poll(options: PollOptions): Promise<PollResult> | PollHandle;
  on(event: "event", handler: SsfEventListener): () => void;
};
type SsfAdapter = {
  readonly receiver: SsfReceiver;
};
//#endregion
//#region src/ssf/create.d.ts
export declare function createPermDock(policy: Policy, options: SsfOptions): SsfAdapter;
//#endregion
//#region src/ssf/replay.d.ts
export declare function memoryReplayStore(): ReplayStore;
//#endregion
export type { CaepEventName, PollHandle, PollOptions, PollResult, ReplayStore, SetSubject, SsfAdapter, SsfAuditEvent, SsfEventHandler, SsfEventInput, SsfEventListener, SsfOnEvent, SsfOptions, SsfReceiver, SsfSubject, SsfSubjectMapper };