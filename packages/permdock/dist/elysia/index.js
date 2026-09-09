import { t as compact } from "../compact-CxSqQNw0.js";
import { n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "../errors-DDT8tC4N.js";
import { t as applyOtel } from "../instrument-C8d4LNIv.js";
import { i as discoverViaSignatureAgent, r as InvalidSignatureError, u as problemResponse } from "../evaluations-04mKRGwn.js";
import { t as createPermDock$1 } from "../create-D_4aH9ul.js";
import { Elysia } from "elysia";
//#region src/elysia/create.ts
function createPermDock(policy, options) {
	const contexts = /* @__PURE__ */ new WeakMap();
	const bound = /* @__PURE__ */ new WeakMap();
	const tenantOption = options.tenant;
	const kernel = createPermDock$1(policy, compact({
		subject: (request) => {
			const ctx = contexts.get(request);
			return ctx === void 0 ? null : options.subject(ctx);
		},
		tenant: typeof tenantOption === "function" ? (request) => {
			const ctx = contexts.get(request);
			return ctx === void 0 ? void 0 : tenantOption(ctx);
		} : tenantOption,
		memberships: options.memberships,
		customRoles: options.customRoles,
		store: options.store,
		sink: options.sink,
		snapshots: options.snapshots,
		webBotAuth: options.webBotAuth,
		wrap: (dock) => applyOtel(dock, options.otel)
	}));
	const bind = (ctx) => {
		const hit = bound.get(ctx);
		if (hit !== void 0) return hit;
		const next = toRequest(ctx);
		bound.set(ctx, next);
		contexts.set(next, ctx);
		return next;
	};
	const decorate = (ctx, instance, data) => {
		const scoped = ctx;
		scoped.permdock = instance;
		if (data !== void 0) scoped.permdockData = data;
	};
	const permdock = () => new Elysia({ name: "permdock" }).derive({ as: "global" }, async (ctx) => {
		const instance = await kernel.permdock(bind(ctx));
		decorate(ctx, instance);
		return { permdock: instance };
	}).onError(({ error }) => {
		if (error instanceof InvalidSignatureError) return error.response;
		if (error instanceof PermDockDeniedError) return problemResponse(error.toProblemDetails(), void 0, error.decision);
		if (error instanceof PermDockApprovalRequiredError) return problemResponse(error.toProblemDetails(), void 0, error.decision);
		if (error instanceof PermDockValidationError) return problemResponse(error.toProblemDetails());
	});
	const protect = (permission, loadData) => async (ctx) => {
		const guard = await kernel.protect(permission, loadData === void 0 ? void 0 : () => loadData(ctx))(bind(ctx));
		if (!guard.ok) return guard.response;
		decorate(ctx, guard.permdock, guard.data);
	};
	const permdockHandler = () => {
		const { POST, GET } = kernel.handler();
		return new Elysia({ name: "permdock-handler" }).post("/", (ctx) => POST(bind(ctx))).get("/", (ctx) => GET(bind(ctx)));
	};
	return {
		permdock,
		protect,
		permdockHandler,
		openapi: kernel.openapi
	};
}
function toRequest(ctx) {
	const method = ctx.request.method;
	if (method === "GET" || method === "HEAD" || ctx.body === void 0) return ctx.request;
	const headers = new Headers(ctx.request.headers);
	const body = typeof ctx.body === "string" ? ctx.body : JSON.stringify(ctx.body);
	if (!headers.has("content-type")) headers.set("content-type", "application/json");
	return new Request(ctx.request.url, {
		method,
		headers,
		body
	});
}
//#endregion
export { InvalidSignatureError, createPermDock, discoverViaSignatureAgent };
