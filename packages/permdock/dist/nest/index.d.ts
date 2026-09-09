import { E as RoleSource, J as Permission, T as MembershipSource, k as SnapshotSource, o as Policy, y as DecisionSink } from "../policy-B9ZJilUm.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { r as PermDock } from "../permdock-Dzaw5_Cl.js";
import { a as OtelOptions } from "../types-AP0rP7Bm.js";
import { c as InvalidSignatureError, f as WebBotAuthOptions, n as OpenApiHooks, p as discoverViaSignatureAgent } from "../create-UsvhcOpB.js";
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
  readonly webBotAuth?: WebBotAuthOptions;
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
export { InvalidSignatureError, type NestPermDock, type NestPermDockOptions, type NestProtect, type NestRequest, discoverViaSignatureAgent, sendResponse, toRequest };