import { C as MembershipSource, D as SnapshotSource, K as Permission, o as Policy, w as RoleSource, y as DecisionSink } from "../policy-DdqgAkJT.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { r as PermDock } from "../permdock-CaK4qAlv.js";
import { a as OtelOptions } from "../types-Dla0k4NU.js";
import { n as OpenApiHooks, t as Guard } from "../create-DGPVmkEj.js";
import { a as toRequest, i as sendResponse, n as fromResponse, r as isServerResponse, t as NodeRequest } from "../http-DQtjxCmn.js";
import { IncomingMessage, ServerResponse } from "node:http";
//#region src/node/create.d.ts
type NodePermDockOptions = {
  readonly subject: (req: NodeRequest) => unknown;
  readonly tenant?: string | ((req: NodeRequest) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
};
type NodePermDock = {
  readonly permdock: (req: IncomingMessage) => Promise<PermDock>;
  readonly protect: (permission: Permission, loadData?: (req: NodeRequest) => unknown) => (req: IncomingMessage) => Promise<Guard>;
  readonly send: typeof sendResponse;
  readonly permdockHandler: () => (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly toRequest: typeof toRequest;
  readonly fromResponse: typeof fromResponse;
  readonly openapi: OpenApiHooks;
};
export declare function createPermDock(policy: Policy, options: NodePermDockOptions): NodePermDock;
//#endregion
export { type NodePermDock, type NodePermDockOptions, type NodeRequest, fromResponse, isServerResponse, sendResponse, toRequest };