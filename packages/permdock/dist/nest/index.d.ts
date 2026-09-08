import { s as ApprovalStore } from "../types-DwRNNTg4.js";
import { o as Policy, v as Permission } from "../policy-Dvre0Da9.js";
import { l as SnapshotSource, o as MembershipSource, r as DecisionSink, s as RoleSource } from "../interfaces-DMSVa7et.js";
import { r as PermDock } from "../permdock-ChXNJ7qn.js";
import { n as OpenApiHooks } from "../create-KZgWsU_G.js";
import { CanActivate, ExceptionFilter, Type } from "@nestjs/common";
import { IncomingMessage, ServerResponse } from "node:http";
//#region src/nest/http.d.ts
type NestHttpRequest = IncomingMessage & {
  readonly originalUrl?: string;
  readonly protocol?: string;
  readonly body?: unknown;
  readonly params?: Record<string, string>;
};
export declare function toRequest(req: NestHttpRequest): Request;
export declare function sendResponse(res: ServerResponse, response: Response): Promise<void>;
//#endregion
//#region src/nest/create.d.ts
type NestRequest = NestHttpRequest & {
  permdock?: PermDock;
  permdockData?: unknown;
};
type NestPermDockOptions = {
  readonly subject: (req: NestRequest) => unknown;
  readonly tenant?: string | ((req: NestRequest) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};
type NestProtect = (permission: Permission, loadData?: (req: NestRequest) => unknown) => ClassDecorator & MethodDecorator;
type NestPermDock = {
  readonly PermDockModule: Type<unknown>;
  readonly PermDockGuard: Type<CanActivate>;
  readonly Protect: NestProtect;
  readonly InjectPermDock: () => ParameterDecorator;
  readonly PermDockExceptionFilter: Type<ExceptionFilter>;
  readonly permdockHandler: () => Type<unknown>;
  readonly openapi: OpenApiHooks;
};
export declare function createPermDock(policy: Policy, options: NestPermDockOptions): NestPermDock;
//#endregion
export type { NestPermDock, NestPermDockOptions, NestProtect, NestRequest };