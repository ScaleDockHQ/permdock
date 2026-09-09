import { o as Policy, v as Permission } from "../policy-Ypk6zTSJ.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { c as RoleSource, d as SnapshotSource, r as DecisionSink, s as MembershipSource } from "../interfaces-BPpihPRB.js";
import { r as PermDock } from "../permdock-CIIsAPlk.js";
import { a as OtelOptions } from "../types-AyNP587R.js";
import { n as OpenApiHooks } from "../create-Blrfo0ym.js";
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
  readonly otel?: OtelOptions;
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