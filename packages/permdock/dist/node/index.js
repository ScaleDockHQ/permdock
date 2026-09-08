import { t as compact } from "../compact-CxSqQNw0.js";
import { t as applyOtel } from "../instrument-C8d4LNIv.js";
import { t as createPermDock$1 } from "../create-C4iJwn1N.js";
import { i as toRequest, n as isServerResponse, r as sendResponse, t as fromResponse } from "../http-kYphIx9F.js";
//#region src/node/create.ts
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
		const nodeReq = req;
		const request = toRequest(nodeReq);
		bound.set(req, request);
		contexts.set(request, nodeReq);
		return request;
	};
	const permdock = (req) => kernel.permdock(bind(req));
	const protect = (permission, loadData) => (req) => kernel.protect(permission, loadData === void 0 ? void 0 : () => loadData(req))(bind(req));
	const permdockHandler = () => {
		const { POST, GET } = kernel.handler();
		return async (req, res) => {
			const request = bind(req);
			if (req.method === "GET" || req.method === "HEAD") {
				await sendResponse(res, await GET(request));
				return;
			}
			await sendResponse(res, await POST(request));
		};
	};
	return {
		permdock,
		protect,
		send: sendResponse,
		permdockHandler,
		toRequest,
		fromResponse,
		openapi: kernel.openapi
	};
}
//#endregion
export { createPermDock, fromResponse, isServerResponse, sendResponse, toRequest };
