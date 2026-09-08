import { l as SnapshotSource, o as MembershipSource, r as DecisionSink, s as RoleSource } from "../interfaces-CnUn1fRe.js";
import { s as ApprovalStore } from "../types-DzwcM0QE.js";
import { T as Permission, p as Policy } from "../decision-B2jL7xrt.js";
import { n as OpenApiHooks } from "../create-CIa8vkyc.js";
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
};
type HonoPermDock = {
  readonly permdock: () => MiddlewareHandler;
  readonly protect: (permission: Permission, loadData?: (c: Context) => unknown) => MiddlewareHandler;
  readonly permdockHandler: () => Hono;
  readonly openapi: OpenApiHooks;
};
export declare function createPermDock(policy: Policy, options: HonoPermDockOptions): HonoPermDock;
//#endregion
export type { HonoPermDock, HonoPermDockOptions };