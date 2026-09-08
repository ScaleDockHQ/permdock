import { o as Policy, v as Permission } from "../policy-CL40bNGn.js";
import { s as ApprovalStore } from "../types-DwRNNTg4.js";
import { l as SnapshotSource, o as MembershipSource, r as DecisionSink, s as RoleSource } from "../interfaces-DMSVa7et.js";
import { r as PermDock } from "../permdock-CSDl61mA.js";
import { n as OpenApiHooks } from "../create-Bq_Kb-Em.js";
import { FastifyPluginAsync, FastifyReply, FastifyRequest, RouteGenericInterface } from "fastify";
//#region src/fastify/create.d.ts
type FastifyPermDockOptions = {
  readonly subject: (request: FastifyRequest) => unknown;
  readonly tenant?: string | ((request: FastifyRequest) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};
type PermDockRequest<Route extends RouteGenericInterface = RouteGenericInterface> = FastifyRequest<Route> & {
  permdock: PermDock;
  permdockData?: unknown;
};
type FastifyProtect = <Route extends RouteGenericInterface = RouteGenericInterface>(permission: Permission, loadData?: (request: FastifyRequest<Route>) => unknown) => (request: FastifyRequest<Route>, reply: FastifyReply) => Promise<void>;
type FastifyPermDock = {
  readonly permdock: FastifyPluginAsync;
  readonly protect: FastifyProtect;
  readonly permdockHandler: FastifyPluginAsync;
  readonly openapi: OpenApiHooks;
};
export declare function createPermDock(policy: Policy, options: FastifyPermDockOptions): FastifyPermDock;
//#endregion
//#region src/fastify/http.d.ts
export declare function toRequest(request: FastifyRequest): Request;
export declare function sendReply(reply: FastifyReply, response: Response): Promise<void>;
//#endregion
export type { FastifyPermDock, FastifyPermDockOptions, FastifyProtect, PermDockRequest };