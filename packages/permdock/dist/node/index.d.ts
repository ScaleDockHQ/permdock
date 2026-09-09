import { E as RoleSource, J as Permission, T as MembershipSource, k as SnapshotSource, o as Policy, y as DecisionSink } from "../policy-CrXDbTAD.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { r as PermDock } from "../permdock-DlRpl_Uu.js";
import { a as OtelOptions } from "../types-B6Kl8wqK.js";
import { c as InvalidSignatureError, f as WebBotAuthOptions, n as OpenApiHooks, p as discoverViaSignatureAgent, t as Guard } from "../create-DOYrE6Dq.js";
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
  readonly webBotAuth?: WebBotAuthOptions;
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
export { InvalidSignatureError, type NodePermDock, type NodePermDockOptions, type NodeRequest, discoverViaSignatureAgent, fromResponse, isServerResponse, sendResponse, toRequest };