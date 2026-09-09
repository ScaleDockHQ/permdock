import { t as compact } from "./compact-CxSqQNw0.js";
import { t as createPermDock$1 } from "./permdock-BPNx0tvD.js";
import { o as listPermissions } from "./permissions-WEkUHQtZ.js";
import { n as isActor } from "./subject-DgYVJ_Q0.js";
import { l as problemFromDecision, n as createEvaluationsHandler, r as InvalidSignatureError, s as verifyWebBotAuth, t as applyApprovalResume, u as problemResponse } from "./evaluations-04mKRGwn.js";
//#region src/server/create.ts
async function resolveActor(request, options) {
	const verified = await verifyWebBotAuth(request, options.webBotAuth, options.problem?.base);
	if (verified !== void 0) return verified;
	if (options.actor === void 0) return;
	try {
		const resolved = await options.actor(request);
		return isActor(resolved) ? resolved : void 0;
	} catch {
		return;
	}
}
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
			const actor = await resolveActor(request, options);
			let user = null;
			try {
				user = await options.subject(request);
			} catch {
				user = null;
			}
			const tenant = await resolveTenant(options.tenant, request);
			const dock = await createPermDock$1(policy, user, compact({
				tenant,
				memberships: options.memberships,
				customRoles: options.customRoles,
				sink: options.sink,
				actor
			}));
			return options.wrap === void 0 ? dock : options.wrap(dock);
		})();
		cache.set(request, built);
		return built;
	};
	const protect = (permission, loadData) => async (request) => {
		let instance;
		try {
			instance = await permdock(request);
		} catch (error) {
			if (error instanceof InvalidSignatureError) return {
				ok: false,
				response: error.response
			};
			throw error;
		}
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
