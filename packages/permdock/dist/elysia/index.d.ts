import { o as Policy, v as Permission } from "../policy-CL40bNGn.js";
import { s as ApprovalStore } from "../types-DwRNNTg4.js";
import { l as SnapshotSource, o as MembershipSource, r as DecisionSink, s as RoleSource } from "../interfaces-DMSVa7et.js";
import { r as PermDock } from "../permdock-CSDl61mA.js";
import { n as OpenApiHooks } from "../create-Bq_Kb-Em.js";
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