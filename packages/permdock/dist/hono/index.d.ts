import { o as Policy, v as Permission } from "../policy-CL40bNGn.js";
import { s as ApprovalStore } from "../types-DwRNNTg4.js";
import { c as RoleSource, d as SnapshotSource, r as DecisionSink, s as MembershipSource } from "../interfaces-BuUjSMjB.js";
import { a as OtelOptions } from "../types-Bs4xlVvV.js";
import { n as OpenApiHooks } from "../create-B2TIkOnb.js";
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