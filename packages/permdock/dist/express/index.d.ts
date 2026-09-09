import { E as RoleSource, J as Permission, T as MembershipSource, k as SnapshotSource, o as Policy, y as DecisionSink } from "../policy-CrXDbTAD.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { r as PermDock } from "../permdock-DlRpl_Uu.js";
import { a as OtelOptions } from "../types-B6Kl8wqK.js";
import { n as OpenApiHooks } from "../create-CpRLW1im.js";
import { a as toRequest, i as sendResponse } from "../http-DQtjxCmn.js";
import { ErrorRequestHandler, Request, RequestHandler, Response, Router } from "express";
//#region src/express/create.d.ts
type ExpressPermDockOptions = {
  readonly subject: (req: Request) => unknown;
  readonly tenant?: string | ((req: Request) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
};
type PermDockRequest<T = unknown> = Request & {
  permdock: PermDock;
  permdockData?: T;
};
type ExpressPermDock = {
  readonly permdock: () => RequestHandler;
  readonly protect: (permission: Permission, loadData?: (req: Request) => unknown) => RequestHandler;
  readonly errorHandler: () => ErrorRequestHandler;
  readonly permdockHandler: () => Router;
  readonly handler: (fn: (req: PermDockRequest, res: Response) => unknown) => RequestHandler;
  readonly openapi: OpenApiHooks;
};
export declare function createPermDock(policy: Policy, options: ExpressPermDockOptions): ExpressPermDock;
//#endregion
export { type ExpressPermDock, type ExpressPermDockOptions, type PermDockRequest, sendResponse, toRequest };