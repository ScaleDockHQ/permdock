import { t as compact } from "./compact-CxCColYy.js";
import { o as listPermissions } from "./permissions-HC1OYNNj.js";
import { t as createPermDock$1 } from "./permdock-DkpVpMh3.js";
import { a as problemResponse, i as problemFromDecision, n as createEvaluationsHandler, t as applyApprovalResume } from "./evaluations-DSadx8RS.js";
//#region src/server/create.ts
async function resolveTenant(tenant, request) {
	if (tenant === void 0 || typeof tenant === "string") return tenant;
	try {
		return await tenant(request);
	} catch {
		return;
	}
}
function createPermDock(policy, options) {
	const cache = /* @__PURE__ */ new WeakMap();
	const permdock = (request) => {
		const hit = cache.get(request);
		if (hit !== void 0) return hit;
		const built = (async () => {
			let user = null;
			try {
				user = await options.subject(request);
			} catch {
				user = null;
			}
			const tenant = await resolveTenant(options.tenant, request);
			return createPermDock$1(policy, user, compact({
				tenant,
				memberships: options.memberships,
				customRoles: options.customRoles,
				sink: options.sink
			}));
		})();
		cache.set(request, built);
		return built;
	};
	const protect = (permission, loadData) => async (request) => {
		const instance = await permdock(request);
		let data;
		if (loadData !== void 0) {
			const loaded = await loadData(request);
			if (loaded === null || loaded === void 0) return {
				ok: false,
				response: new Response(null, { status: 404 })
			};
			data = loaded;
		}
		const raw = instance.decide(permission, data, compact({
			source: "adapter",
			adapter: "server"
		}));
		const decision = await applyApprovalResume(raw, permission, instance, options.store, request, compact({
			type: permission.resource,
			id: data !== null && typeof data === "object" && "id" in data && (typeof data.id === "string" || typeof data.id === "number") ? String(data.id) : void 0
		}), "server");
		if (decision.outcome === "granted") return {
			ok: true,
			permdock: instance,
			decision,
			data
		};
		return {
			ok: false,
			response: problemFromDecision(decision, permission, instance.subject, compact({ base: options.problem?.base }))
		};
	};
	const problem = (decision, init) => {
		if (init?.permission !== void 0) return problemFromDecision(decision, init.permission, {
			principal: null,
			context: {}
		}, compact({
			instance: init.instance,
			base: options.problem?.base
		}));
		return problemResponse({
			type: `${options.problem?.base ?? "https://permdock.dev/problems"}/denied`,
			title: "Permission denied",
			status: 403,
			detail: decision.outcome
		});
	};
	const openapi = {
		security: (permission) => ({
			security: [{ oauth2: [permission.scope] }],
			"x-permdock-permissions": [permission.key]
		}),
		securitySchemes: () => {
			const scopes = {};
			for (const leaf of listPermissions(policy.permissions)) scopes[leaf.scope] = leaf.meta.title ?? leaf.key;
			return { oauth2: {
				type: "oauth2",
				flows: {},
				scopes
			} };
		}
	};
	const handler = () => createEvaluationsHandler(compact({
		policy,
		resolve: permdock,
		store: options.store,
		adapter: "server"
	}));
	return {
		permdock,
		protect,
		problem,
		openapi,
		handler
	};
}
//#endregion
export { createPermDock as t };
