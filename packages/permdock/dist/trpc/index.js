import { t as compact } from "../compact-CxSqQNw0.js";
import { t as createPermDock$1 } from "../create-BPNB9OJt.js";
import { TRPCError } from "@trpc/server";
//#region src/trpc/create.ts
function requestFromCtx(ctx) {
	if ("request" in ctx) {
		const rec = ctx;
		if (rec.request instanceof Request) return rec.request;
	}
	if ("req" in ctx) {
		const rec = ctx;
		if (rec.req instanceof Request) return rec.req;
	}
}
function problemMessage(cause, fallback) {
	if (cause !== null && typeof cause === "object" && "detail" in cause && typeof cause.detail === "string" && cause.detail.length > 0) return cause.detail;
	return fallback;
}
async function throwTrpcError(response) {
	let cause;
	try {
		cause = await response.json();
	} catch {
		cause = { status: response.status };
	}
	const code = response.status === 401 ? "UNAUTHORIZED" : response.status === 400 ? "BAD_REQUEST" : "FORBIDDEN";
	throw new TRPCError({
		code,
		message: problemMessage(cause, code),
		cause
	});
}
function errorFormatter(opts) {
	const cause = opts.error.cause;
	if (cause === null || typeof cause !== "object") return opts.shape;
	return {
		...opts.shape,
		data: {
			...opts.shape.data,
			...cause
		}
	};
}
function createPermDock(policy, options) {
	const optsByRequest = /* @__PURE__ */ new WeakMap();
	const requestByCtx = /* @__PURE__ */ new WeakMap();
	const instances = /* @__PURE__ */ new WeakMap();
	const tenantOption = options.tenant;
	const kernel = createPermDock$1(policy, compact({
		subject: (request) => {
			const opts = optsByRequest.get(request);
			return opts === void 0 ? null : options.subject(opts);
		},
		tenant: typeof tenantOption === "function" ? (request) => {
			const opts = optsByRequest.get(request);
			return opts === void 0 ? void 0 : tenantOption(opts);
		} : tenantOption,
		memberships: options.memberships,
		customRoles: options.customRoles,
		store: options.store,
		sink: options.sink,
		snapshots: options.snapshots
	}));
	const bind = (opts) => {
		const ctx = opts.ctx;
		const hit = requestByCtx.get(ctx);
		if (hit !== void 0) {
			optsByRequest.set(hit, opts);
			return hit;
		}
		const request = requestFromCtx(ctx) ?? new Request(`http://localhost/trpc/${opts.path}`, { method: "POST" });
		requestByCtx.set(ctx, request);
		optsByRequest.set(request, opts);
		return request;
	};
	const attach = (ctx, request) => {
		requestByCtx.set(ctx, request);
	};
	const permdock = () => ((opts) => {
		const request = bind(opts);
		const ctx = opts.ctx;
		let built = instances.get(ctx);
		if (built === void 0) {
			built = kernel.permdock(request);
			instances.set(ctx, built);
		}
		return built.then((instance) => {
			const nextCtx = {
				...opts.ctx,
				permdock: instance
			};
			attach(nextCtx, request);
			return opts.next({ ctx: nextCtx });
		});
	});
	const protect = (permission, loadData) => (async (opts) => {
		const request = bind(opts);
		const guard = await kernel.protect(permission, loadData === void 0 ? void 0 : () => loadData(opts))(request);
		if (guard.ok) {
			const nextCtx = {
				...opts.ctx,
				permdock: guard.permdock,
				permdockData: guard.data
			};
			attach(nextCtx, request);
			return opts.next({ ctx: nextCtx });
		}
		return throwTrpcError(guard.response);
	});
	const permdockHandler = (request) => {
		bind({
			ctx: { req: request },
			path: "permdock",
			type: "unknown",
			next: (nextOpts) => Promise.resolve(nextOpts ?? { ctx: { req: request } })
		});
		const { POST, GET } = kernel.handler();
		return Promise.resolve(request.method === "GET" ? GET(request) : POST(request));
	};
	const kernelOpenApi = kernel.openapi;
	return {
		permdock,
		protect,
		permdockHandler,
		openapi: {
			security: (permission) => ({ openapi: {
				protect: true,
				...kernelOpenApi.security(permission)
			} }),
			securitySchemes: kernelOpenApi.securitySchemes
		},
		errorFormatter
	};
}
//#endregion
export { createPermDock, errorFormatter };
