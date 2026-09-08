import { t as compact } from "../compact-CxSqQNw0.js";
import { n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "../errors-DDT8tC4N.js";
import { t as applyOtel } from "../instrument-C8d4LNIv.js";
import { a as problemResponse } from "../evaluations-BMhJ7c5n.js";
import { t as createPermDock$1 } from "../create-BPNB9OJt.js";
import { i as toRequest, r as sendResponse } from "../http-kYphIx9F.js";
import express from "express";
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
		snapshots: options.snapshots,
		wrap: (dock) => applyOtel(dock, options.otel)
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
