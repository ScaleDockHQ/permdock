import { o as Policy, v as Permission } from "../policy-DsqYfECx.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { c as RoleSource, d as SnapshotSource, r as DecisionSink, s as MembershipSource } from "../interfaces-B19qT0zU.js";
import { r as PermDock } from "../permdock-BFyP-l5_.js";
import { a as OtelOptions } from "../types-DnMGsJ22.js";
import { n as OpenApiHooks } from "../create-BwhCpCoE.js";
import { a as toRequest, i as sendResponse, t as NodeRequest } from "../http-DQtjxCmn.js";
import { CanActivate, ExceptionFilter, Type } from "@nestjs/common";
//#region src/nest/create.d.ts
type NestRequest = NodeRequest & {
  readonly params?: Readonly<Record<string, string>>;
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
  readonly otel?: OtelOptions;
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
export { type NestPermDock, type NestPermDockOptions, type NestProtect, type NestRequest, sendResponse, toRequest };