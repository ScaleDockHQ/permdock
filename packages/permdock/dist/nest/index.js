import { d as PermDockDeniedError, f as PermDockValidationError, u as PermDockApprovalRequiredError } from "../snapshot-CEl3OGkJ.js";
import { t as compact } from "../compact-CxCColYy.js";
import { a as problemResponse } from "../evaluations-DrCAt2dS.js";
import { t as createPermDock$1 } from "../create-CYzzrAXg.js";
import { Catch, Controller, Get, Inject, Injectable, Module, Post, Req, Res, createParamDecorator } from "@nestjs/common";
import { APP_FILTER, Reflector } from "@nestjs/core";
//#region src/nest/http.ts
function toRequest(req) {
	const host = headerValue(req.headers.host) ?? "localhost";
	const url = `${req.protocol ?? "http"}://${host}${req.originalUrl ?? req.url ?? "/"}`;
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (typeof value === "string") {
			headers.set(key, value);
			continue;
		}
		if (Array.isArray(value)) for (const item of value) headers.append(key, item);
	}
	const method = req.method ?? "GET";
	if (method === "GET" || method === "HEAD") return new Request(url, {
		method,
		headers
	});
	const body = bodyOf(req, headers);
	if (body === void 0) return new Request(url, {
		method,
		headers
	});
	return new Request(url, {
		method,
		headers,
		body
	});
}
function headerValue(value) {
	if (typeof value === "string" && value.length > 0) return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
}
function bodyOf(req, headers) {
	if (req.body === void 0) return;
	if (typeof req.body === "string") return req.body;
	if (!headers.has("content-type")) headers.set("content-type", "application/json");
	return JSON.stringify(req.body);
}
async function sendResponse(res, response) {
	res.statusCode = response.status;
	for (const [key, value] of response.headers.entries()) res.setHeader(key, value);
	const body = Buffer.from(await response.arrayBuffer());
	res.end(body);
}
function isServerResponse(value) {
	return typeof value === "object" && value !== null && "setHeader" in value && typeof value.setHeader === "function" && "end" in value;
}
//#endregion
//#region src/nest/create.ts
const PROTECT_KEY = "permdock:protect";
var PermDockHttpError = class extends Error {
	name = "PermDockHttpError";
	response;
	constructor(response) {
		super("permdock denied");
		this.response = response;
	}
};
function reflectMeta() {
	const ref = Reflect;
	if (typeof ref.getMetadata !== "function" || typeof ref.defineMetadata !== "function") throw new TypeError("reflect-metadata is required for permdock/nest");
	return ref;
}
function applyMethod(cls, key, decorator) {
	const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, key);
	if (descriptor === void 0) throw new TypeError(`missing ${key} handler`);
	decorator(cls.prototype, key, descriptor);
}
function applyParameter(cls, key, index, decorator) {
	decorator(cls.prototype, key, index);
}
function rulesOf(target) {
	const found = reflectMeta().getMetadata(PROTECT_KEY, target);
	if (!Array.isArray(found)) return [];
	return found;
}
function createPermDock(policy, options) {
	const contexts = /* @__PURE__ */ new WeakMap();
	const bound = /* @__PURE__ */ new WeakMap();
	const tenantOption = options.tenant;
	const kernel = createPermDock$1(policy, compact({
		subject: (request) => {
			const req = contexts.get(request);
			return req === void 0 ? null : options.subject(req);
		},
		tenant: typeof tenantOption === "function" ? (request) => {
			const req = contexts.get(request);
			return req === void 0 ? void 0 : tenantOption(req);
		} : tenantOption,
		memberships: options.memberships,
		customRoles: options.customRoles,
		store: options.store,
		sink: options.sink,
		snapshots: options.snapshots
	}));
	const applyProtect = async (remaining, req, request) => {
		const [rule, ...rest] = remaining;
		if (rule === void 0) return;
		const loader = rule.loadData;
		const guard = await kernel.protect(rule.permission, loader === void 0 ? void 0 : () => loader(req))(request);
		if (!guard.ok) throw new PermDockHttpError(guard.response);
		req.permdock = guard.permdock;
		req.permdockData = guard.data;
		await applyProtect(rest, req, request);
	};
	const bind = (req) => {
		const hit = bound.get(req);
		if (hit !== void 0) return hit;
		const request = toRequest(req);
		bound.set(req, request);
		contexts.set(request, req);
		return request;
	};
	class PermDockGuard {
		reflector;
		constructor(reflector) {
			this.reflector = reflector;
		}
		async canActivate(context) {
			if (context.getType() !== "http") return true;
			const req = context.switchToHttp().getRequest();
			const request = bind(req);
			req.permdock = await kernel.permdock(request);
			const fromClass = this.reflector.get(PROTECT_KEY, context.getClass());
			const fromHandler = this.reflector.get(PROTECT_KEY, context.getHandler());
			const rules = [...Array.isArray(fromClass) ? fromClass : rulesOf(context.getClass()), ...Array.isArray(fromHandler) ? fromHandler : rulesOf(context.getHandler())];
			await applyProtect(rules, req, request);
			return true;
		}
	}
	Inject(Reflector)(PermDockGuard, void 0, 0);
	Injectable()(PermDockGuard);
	class PermDockExceptionFilter {
		send = sendResponse;
		async catch(exception, host) {
			const response = host.switchToHttp().getResponse();
			if (!isServerResponse(response)) throw new TypeError("unsupported Nest response");
			if (exception instanceof PermDockHttpError) {
				await this.send(response, exception.response);
				return;
			}
			if (exception instanceof PermDockDeniedError) {
				await this.send(response, problemResponse(exception.toProblemDetails(), void 0, exception.decision));
				return;
			}
			if (exception instanceof PermDockApprovalRequiredError) {
				await this.send(response, problemResponse(exception.toProblemDetails(), void 0, exception.decision));
				return;
			}
			if (exception instanceof PermDockValidationError) {
				await this.send(response, problemResponse(exception.toProblemDetails()));
				return;
			}
			throw new TypeError("unhandled permdock exception");
		}
	}
	Catch(PermDockHttpError, PermDockDeniedError, PermDockApprovalRequiredError, PermDockValidationError)(PermDockExceptionFilter);
	Injectable()(PermDockExceptionFilter);
	class PermDockRoot {
		static adapter = "nest";
	}
	Module({
		providers: [
			{
				provide: PermDockGuard,
				useFactory: (reflector) => new PermDockGuard(reflector),
				inject: [Reflector]
			},
			{
				provide: PermDockExceptionFilter,
				useFactory: () => new PermDockExceptionFilter()
			},
			{
				provide: APP_FILTER,
				useExisting: PermDockExceptionFilter
			}
		],
		exports: [PermDockGuard, PermDockExceptionFilter]
	})(PermDockRoot);
	const Protect = (permission, loadData) => {
		const rule = compact({
			permission,
			loadData
		});
		return ((target, _propertyKey, descriptor) => {
			const store = descriptor === void 0 ? target : descriptor.value;
			if (typeof store !== "function" && (typeof store !== "object" || store === null)) throw new TypeError("Protect requires a class or method");
			const existing = rulesOf(store);
			reflectMeta().defineMetadata(PROTECT_KEY, [...existing, rule], store);
		});
	};
	const injectPermDock = createParamDecorator((_data, ctx) => {
		if (ctx.getType() !== "http") return;
		return ctx.switchToHttp().getRequest().permdock;
	});
	const InjectPermDock = () => injectPermDock();
	const permdockHandler = () => {
		const { POST, GET } = kernel.handler();
		class EvaluationsController {
			send = sendResponse;
			async post(req, res) {
				await this.send(res, await POST(bind(req)));
			}
			async get(req, res) {
				await this.send(res, await GET(bind(req)));
			}
		}
		Controller("api/permdock")(EvaluationsController);
		applyMethod(EvaluationsController, "post", Post());
		applyMethod(EvaluationsController, "get", Get());
		applyParameter(EvaluationsController, "post", 0, Req());
		applyParameter(EvaluationsController, "post", 1, Res({ passthrough: false }));
		applyParameter(EvaluationsController, "get", 0, Req());
		applyParameter(EvaluationsController, "get", 1, Res({ passthrough: false }));
		return EvaluationsController;
	};
	return {
		PermDockModule: PermDockRoot,
		PermDockGuard,
		Protect,
		InjectPermDock,
		PermDockExceptionFilter,
		permdockHandler,
		openapi: kernel.openapi
	};
}
//#endregion
export { createPermDock, sendResponse, toRequest };
