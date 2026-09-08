import { t as compact } from "../compact-CxSqQNw0.js";
import { t as applyOtel } from "../instrument-C8d4LNIv.js";
import { t as createPermDock$1 } from "../create-C4iJwn1N.js";
import { Hono } from "hono";
//#region src/hono/create.ts
function createPermDock(policy, options) {
	const contexts = /* @__PURE__ */ new WeakMap();
	const tenantOption = options.tenant;
	const kernel = createPermDock$1(policy, compact({
		subject: (request) => {
			const c = contexts.get(request);
			return c === void 0 ? null : options.subject(c);
		},
		tenant: typeof tenantOption === "function" ? (request) => {
			const c = contexts.get(request);
			return c === void 0 ? void 0 : tenantOption(c);
		} : tenantOption,
		memberships: options.memberships,
		customRoles: options.customRoles,
		store: options.store,
		sink: options.sink,
		snapshots: options.snapshots,
		wrap: (dock) => applyOtel(dock, options.otel)
	}));
	const bind = (c) => {
		const raw = c.req.raw;
		contexts.set(raw, c);
		return raw;
	};
	const permdock = () => async (c, next) => {
		c.set("permdock", await kernel.permdock(bind(c)));
		await next();
	};
	const protect = (permission, loadData) => async (c, next) => {
		const guard = await kernel.protect(permission, loadData === void 0 ? void 0 : () => loadData(c))(bind(c));
		if (!guard.ok) return guard.response;
		c.set("permdock", guard.permdock);
		c.set("permdockData", guard.data);
		await next();
	};
	const permdockHandler = () => {
		const { POST, GET } = kernel.handler();
		const app = new Hono();
		app.post("/", (c) => POST(bind(c)));
		app.get("/", (c) => GET(bind(c)));
		return app;
	};
	return {
		permdock,
		protect,
		permdockHandler,
		openapi: kernel.openapi
	};
}
//#endregion
export { createPermDock };
