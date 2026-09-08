import { s as ApprovalStore } from "../types-DwRNNTg4.js";
import { o as Policy, v as Permission } from "../policy-Dvre0Da9.js";
import { l as SnapshotSource, o as MembershipSource, r as DecisionSink, s as RoleSource } from "../interfaces-DMSVa7et.js";
import { r as PermDock } from "../permdock-ChXNJ7qn.js";
import { n as OpenApiHooks } from "../create-KZgWsU_G.js";
import { ErrorRequestHandler, Request as Request$1, RequestHandler, Response as Response$1, Router } from "express";
import { IncomingMessage, ServerResponse } from "node:http";
//#region src/express/create.d.ts
type ExpressPermDockOptions = {
  readonly subject: (req: Request$1) => unknown;
  readonly tenant?: string | ((req: Request$1) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};
type PermDockRequest<T = unknown> = Request$1 & {
  permdock: PermDock;
  permdockData?: T;
};
type ExpressPermDock = {
  readonly permdock: () => RequestHandler;
  readonly protect: (permission: Permission, loadData?: (req: Request$1) => unknown) => RequestHandler;
  readonly errorHandler: () => ErrorRequestHandler;
  readonly permdockHandler: () => Router;
  readonly handler: (fn: (req: PermDockRequest, res: Response$1) => unknown) => RequestHandler;
  readonly openapi: OpenApiHooks;
};
export declare function createPermDock(policy: Policy, options: ExpressPermDockOptions): ExpressPermDock;
//#endregion
//#region src/express/http.d.ts
type NodeRequest = IncomingMessage & {
  readonly originalUrl?: string;
  readonly protocol?: string;
  readonly body?: unknown;
};
export declare function toRequest(req: NodeRequest): Request;
export declare function sendResponse(res: ServerResponse, response: Response): Promise<void>;
//#endregion
export type { ExpressPermDock, ExpressPermDockOptions, PermDockRequest };