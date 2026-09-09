import { E as RoleSource, J as Permission, T as MembershipSource, k as SnapshotSource, o as Policy, y as DecisionSink } from "../policy-btMlTuxm.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { r as PermDock } from "../permdock-hQcUhnDS.js";
import { a as OtelOptions } from "../types-CDUTMqdb.js";
import { c as InvalidSignatureError, f as WebBotAuthOptions, n as OpenApiHooks, p as discoverViaSignatureAgent } from "../create-0pHTFWwI.js";
import { Elysia } from "elysia";
//#region src/elysia/create.d.ts
type ElysiaCtx = {
  readonly request: Request;
  readonly body?: unknown;
  readonly params?: Readonly<Record<string, string | undefined>>;
};
type ElysiaPermDockOptions = {
  readonly subject: (ctx: ElysiaCtx) => unknown;
  readonly tenant?: string | ((ctx: ElysiaCtx) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
  readonly webBotAuth?: WebBotAuthOptions;
};
type ElysiaContext = ElysiaCtx & {
  permdock: PermDock;
  permdockData?: unknown;
};
type ElysiaProtect = (permission: Permission, loadData?: (ctx: ElysiaCtx) => unknown) => (ctx: ElysiaCtx) => Promise<Response | undefined>;
type ElysiaPermDock = {
  readonly permdock: () => Elysia;
  readonly protect: ElysiaProtect;
  readonly permdockHandler: () => Elysia;
  readonly openapi: OpenApiHooks;
};
export declare function createPermDock(policy: Policy, options: ElysiaPermDockOptions): ElysiaPermDock;
//#endregion
export { type ElysiaContext, type ElysiaCtx, type ElysiaPermDock, type ElysiaPermDockOptions, type ElysiaProtect, InvalidSignatureError, discoverViaSignatureAgent };