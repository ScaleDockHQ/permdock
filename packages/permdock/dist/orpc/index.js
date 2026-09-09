import { t as compact } from "../compact-CxSqQNw0.js";
import { o as invalidSignatureResponse } from "../evaluations-04mKRGwn.js";
import { t as createPermDock$1 } from "../create-q024YbJD.js";
import { ORPCError } from "@orpc/server";
//#region src/orpc/create.ts
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
function toOpts(mw, input, next) {
	return compact({
		context: mw.context,
		input,
		path: mw.path,
		next
	});
}
function problemMessage(cause, fallback) {
	if (cause !== null && typeof cause === "object" && "detail" in cause && typeof cause.detail === "string" && cause.detail.length > 0) return cause.detail;
	return fallback;
}
async function throwOrpcError(response) {
	let data;
	try {
		data = await response.json();
	} catch {
		data = { status: response.status };
	}
	const code = response.status === 401 ? "UNAUTHORIZED" : response.status === 400 ? "BAD_REQUEST" : "FORBIDDEN";
	throw new ORPCError(code, {
		message: problemMessage(data, code),
		data
	});
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
		snapshots: options.snapshots,
		webBotAuth: options.webBotAuth
	}));
	const bind = (opts) => {
		const ctx = opts.context;
		const hit = requestByCtx.get(ctx);
		if (hit !== void 0) {
			optsByRequest.set(hit, opts);
			return hit;
		}
		const fromCtx = requestFromCtx(ctx);
		const path = opts.path?.join(".") ?? "orpc";
		const request = fromCtx ?? new Request(`http://localhost/orpc/${path}`, { method: "POST" });
		requestByCtx.set(ctx, request);
		optsByRequest.set(request, opts);
		return request;
	};
	const attach = (ctx, request) => {
		requestByCtx.set(ctx, request);
	};
	const permdock = () => ((mwOptions, input) => {
		const opts = toOpts(mwOptions, input, mwOptions.next);
		const request = bind(opts);
		const ctx = opts.context;
		let built = instances.get(ctx);
		if (built === void 0) {
			built = kernel.permdock(request);
			instances.set(ctx, built);
		}
		return built.then((instance) => {
			const nextCtx = {
				...opts.context,
				permdock: instance
			};
			attach(nextCtx, request);
			return mwOptions.next({ context: nextCtx });
		}, (error) => {
			const response = invalidSignatureResponse(error);
			if (response !== void 0) return throwOrpcError(response);
			throw error;
		});
	});
	const protect = (permission, loadData) => (async (mwOptions, input) => {
		const opts = toOpts(mwOptions, input, mwOptions.next);
		const request = bind(opts);
		const guard = await kernel.protect(permission, loadData === void 0 ? void 0 : () => loadData(opts))(request);
		if (guard.ok) {
			const nextCtx = {
				...opts.context,
				permdock: guard.permdock,
				permdockData: guard.data
			};
			attach(nextCtx, request);
			return mwOptions.next({ context: nextCtx });
		}
		return throwOrpcError(guard.response);
	});
	const permdockHandler = (request) => {
		bind({
			context: { req: request },
			path: ["permdock"],
			next: (nextOpts) => Promise.resolve(nextOpts ?? { context: { req: request } })
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
			protect,
			security: kernelOpenApi.security,
			securitySchemes: kernelOpenApi.securitySchemes
		}
	};
}
//#endregion
export { createPermDock };
