import { o as Policy } from "../policy-CIG-jCsG.js";
import { r as Permission } from "../permissions-CkmCCiYs.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { c as RoleSource, d as SnapshotSource, r as DecisionSink, s as MembershipSource } from "../interfaces-BPpihPRB.js";
import { r as PermDock } from "../permdock-BHYt07KR.js";
import { a as OtelOptions } from "../types-AyNP587R.js";
import { n as OpenApiHooks, t as Guard } from "../create-BJhgSpGs.js";
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