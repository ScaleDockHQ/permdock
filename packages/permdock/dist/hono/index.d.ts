import { E as RoleSource, J as Permission, T as MembershipSource, k as SnapshotSource, o as Policy, y as DecisionSink } from "../policy-btMlTuxm.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { a as OtelOptions } from "../types-CDUTMqdb.js";
import { c as InvalidSignatureError, f as WebBotAuthOptions, n as OpenApiHooks, p as discoverViaSignatureAgent } from "../create-0pHTFWwI.js";
import { Context, Hono, MiddlewareHandler } from "hono";
//#region src/hono/create.d.ts
type HonoPermDockOptions = {
  readonly subject: (c: Context) => unknown;
  readonly tenant?: string | ((c: Context) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
  readonly webBotAuth?: WebBotAuthOptions;
};
type HonoPermDock = {
  readonly permdock: () => MiddlewareHandler;
  readonly protect: (permission: Permission, loadData?: (c: Context) => unknown) => MiddlewareHandler;
  readonly permdockHandler: () => Hono;
  readonly openapi: OpenApiHooks;
};
export declare function createPermDock(policy: Policy, options: HonoPermDockOptions): HonoPermDock;
//#endregion
export { type HonoPermDock, type HonoPermDockOptions, InvalidSignatureError, discoverViaSignatureAgent };