import { o as Policy, v as Permission } from "../policy-DsqYfECx.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { c as RoleSource, d as SnapshotSource, r as DecisionSink, s as MembershipSource } from "../interfaces-B19qT0zU.js";
import { r as PermDock } from "../permdock-BFyP-l5_.js";
import { a as OtelOptions } from "../types-DnMGsJ22.js";
import { n as OpenApiHooks } from "../create-BwhCpCoE.js";
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
export type { ElysiaContext, ElysiaCtx, ElysiaPermDock, ElysiaPermDockOptions, ElysiaProtect };