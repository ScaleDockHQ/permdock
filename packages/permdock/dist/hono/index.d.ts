import { l as SnapshotSource, o as MembershipSource, r as DecisionSink, s as RoleSource } from "../interfaces-D45oN5-b.js";
import { s as ApprovalStore } from "../types-DcgC3zN4.js";
import { T as Permission, p as Policy } from "../decision-JylG_mtz.js";
import { n as OpenApiHooks } from "../create-DFGET_O9.js";
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