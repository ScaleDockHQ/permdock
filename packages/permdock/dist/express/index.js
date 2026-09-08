import { d as PermDockDeniedError, f as PermDockValidationError, u as PermDockApprovalRequiredError } from "../snapshot-CEl3OGkJ.js";
import { t as compact } from "../compact-CxCColYy.js";
import { a as problemResponse } from "../evaluations-DrCAt2dS.js";
import { t as createPermDock$1 } from "../create-CYzzrAXg.js";
import express from "express";
//#region src/express/http.ts
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
//#endregion
//#region src/express/create.ts
function run(work, next) {
	work().catch(next);
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
	const bind = (req) => {
		const hit = bound.get(req);
		if (hit !== void 0) return hit;
		const request = toRequest(req);
		bound.set(req, request);
		contexts.set(request, req);
		return request;
	};
	const permdock = () => (req, _res, next) => {
		run(async () => {
			req.permdock = await kernel.permdock(bind(req));
			next();
		}, next);
	};
	const protect = (permission, loadData) => (req, res, next) => {
		run(async () => {
			const guard = await kernel.protect(permission, loadData === void 0 ? void 0 : () => loadData(req))(bind(req));
			if (!guard.ok) {
				await sendResponse(res, guard.response);
				return;
			}
			const scoped = req;
			scoped.permdock = guard.permdock;
			scoped.permdockData = guard.data;
			next();
		}, next);
	};
	const errorHandler = () => (err, _req, res, next) => {
		if (err instanceof PermDockDeniedError) {
			run(async () => {
				await sendResponse(res, problemResponse(err.toProblemDetails(), void 0, err.decision));
			}, next);
			return;
		}
		if (err instanceof PermDockApprovalRequiredError) {
			run(async () => {
				await sendResponse(res, problemResponse(err.toProblemDetails(), void 0, err.decision));
			}, next);
			return;
		}
		if (err instanceof PermDockValidationError) {
			run(async () => {
				await sendResponse(res, problemResponse(err.toProblemDetails()));
			}, next);
			return;
		}
		next(err);
	};
	const permdockHandler = () => {
		const { POST, GET } = kernel.handler();
		const router = express.Router();
		router.post("/", (req, res, next) => {
			run(async () => {
				await sendResponse(res, await POST(bind(req)));
			}, next);
		});
		router.get("/", (req, res, next) => {
			run(async () => {
				await sendResponse(res, await GET(bind(req)));
			}, next);
		});
		return router;
	};
	const handler = (fn) => (req, res, next) => {
		run(async () => {
			await fn(req, res);
		}, next);
	};
	return {
		permdock,
		protect,
		errorHandler,
		permdockHandler,
		handler,
		openapi: kernel.openapi
	};
}
//#endregion
export { createPermDock, sendResponse, toRequest };
