import { t as compact } from "../compact-CxCColYy.js";
import { n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "../errors-Q-hDyBns.js";
import { a as problemResponse } from "../evaluations-DSadx8RS.js";
import { t as createPermDock$1 } from "../create-W1iLgnQz.js";
//#region src/fastify/http.ts
function toRequest(request) {
	const host = headerValue(request.headers.host) ?? "localhost";
	const url = `${request.protocol}://${host}${request.url}`;
	const headers = new Headers();
	for (const [key, value] of Object.entries(request.headers)) {
		if (typeof value === "string") {
			headers.set(key, value);
			continue;
		}
		if (Array.isArray(value)) for (const item of value) headers.append(key, item);
	}
	const method = request.method;
	if (method === "GET" || method === "HEAD") return new Request(url, {
		method,
		headers
	});
	const body = bodyOf(request, headers);
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
function bodyOf(request, headers) {
	if (request.body === void 0) return;
	if (typeof request.body === "string") return request.body;
	if (!headers.has("content-type")) headers.set("content-type", "application/json");
	return JSON.stringify(request.body);
}
async function sendReply(reply, response) {
	reply.code(response.status);
	for (const [key, value] of response.headers.entries()) reply.header(key, value);
	await reply.send(await response.text());
}
//#endregion
//#region src/fastify/create.ts
const SKIP_OVERRIDE = Symbol.for("skip-override");
function breakEncapsulation(plugin) {
	Object.defineProperty(plugin, SKIP_OVERRIDE, { value: true });
	return plugin;
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
	const bind = (request) => {
		const hit = bound.get(request);
		if (hit !== void 0) return hit;
		const next = toRequest(request);
		bound.set(request, next);
		contexts.set(next, request);
		return next;
	};
	const decorate = (request, instance, data) => {
		const scoped = request;
		scoped.permdock = instance;
		if (data !== void 0) scoped.permdockData = data;
	};
	const permdock = breakEncapsulation((app) => {
		app.decorateRequest("permdock", null);
		app.decorateRequest("permdockData", null);
		app.addHook("onRequest", async (request) => {
			decorate(request, await kernel.permdock(bind(request)));
		});
		app.setErrorHandler(async (err, _request, reply) => {
			if (err instanceof PermDockDeniedError) {
				await sendReply(reply, problemResponse(err.toProblemDetails(), void 0, err.decision));
				return;
			}
			if (err instanceof PermDockApprovalRequiredError) {
				await sendReply(reply, problemResponse(err.toProblemDetails(), void 0, err.decision));
				return;
			}
			if (err instanceof PermDockValidationError) {
				await sendReply(reply, problemResponse(err.toProblemDetails()));
				return;
			}
			await reply.send(err);
		});
		return Promise.resolve();
	});
	const protect = (permission, loadData) => async (request, reply) => {
		const guard = await kernel.protect(permission, loadData === void 0 ? void 0 : () => loadData(request))(bind(request));
		if (!guard.ok) {
			await sendReply(reply, guard.response);
			return;
		}
		decorate(request, guard.permdock, guard.data);
	};
	const permdockHandler = (app) => {
		const { POST, GET } = kernel.handler();
		app.post("/", async (request, reply) => {
			await sendReply(reply, await POST(bind(request)));
		});
		app.get("/", async (request, reply) => {
			await sendReply(reply, await GET(bind(request)));
		});
		return Promise.resolve();
	};
	return {
		permdock,
		protect,
		permdockHandler,
		openapi: kernel.openapi
	};
}
//#endregion
export { createPermDock, sendReply, toRequest };
