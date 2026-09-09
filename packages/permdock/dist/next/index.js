import { t as compact } from "../compact-CxSqQNw0.js";
import { t as createPermDock$1 } from "../permdock-DR74dJsu.js";
import { t as PermDockProvider } from "../provider-CykRM-0W.js";
import { t as applyOtel } from "../instrument-C8d4LNIv.js";
import { n as createEvaluationsHandler } from "../evaluations-cJeur3Fn.js";
import { cache } from "react";
import { jsx } from "react/jsx-runtime";
//#region src/next/provider.tsx
function renderClientProvider(options) {
	return /* @__PURE__ */ jsx(PermDockProvider, {
		...compact({
			snapshot: options.snapshot,
			endpoint: options.endpoint,
			tenant: options.tenant
		}),
		children: options.children
	});
}
//#endregion
//#region src/next/create.ts
const DENIED = {
	outcome: "denied",
	denials: [{
		role: null,
		reason: "no-grant"
	}],
	alternatives: []
};
function assertServerOnly() {
	if (globalThis.document !== void 0) throw new TypeError("permdock/next is server-only. Import hooks and Protected from permdock/react.");
}
async function readTenant(tenant) {
	if (tenant === void 0 || typeof tenant === "string") return tenant;
	try {
		return await tenant();
	} catch {
		return;
	}
}
function wrapInstance(dock, onDenied) {
	if (onDenied === void 0) return dock;
	const assert = ((permission, data, options) => dock.assert(permission, data, compact({
		...options,
		onDenied: options?.onDenied ?? onDenied
	})));
	return {
		...dock,
		assert
	};
}
function createPermDock(policy, options) {
	assertServerOnly();
	const resolveSubject = cache(async () => {
		try {
			return await options.subject();
		} catch {
			return null;
		}
	});
	const resolveFallbackTenant = cache(() => readTenant(options.tenant));
	const instantiate = cache(async (tenantKey) => {
		const tenant = tenantKey === "" ? void 0 : tenantKey;
		const user = await resolveSubject();
		return wrapInstance(applyOtel(await createPermDock$1(policy, user, compact({
			tenant,
			memberships: options.memberships,
			customRoles: options.customRoles,
			sink: options.sink
		})), options.otel), options.onDenied);
	});
	const getPermDock = async (query) => {
		const tenant = query?.tenant ?? await resolveFallbackTenant();
		return instantiate(tenant ?? "");
	};
	const getPermission = async (permission, data) => {
		try {
			const decision = (await getPermDock()).decide(permission, data);
			return {
				allowed: decision.outcome === "granted",
				status: "ready",
				decision
			};
		} catch {
			return {
				allowed: false,
				status: "ready",
				decision: DENIED
			};
		}
	};
	const PermDockProvider = async (props) => {
		const dock = await getPermDock(props.tenant === void 0 ? void 0 : { tenant: props.tenant });
		const snapshot = await Promise.resolve(dock.snapshot(compact({
			include: props.include,
			tenants: props.tenants
		})));
		return renderClientProvider(compact({
			snapshot,
			endpoint: props.endpoint ?? options.endpoint ?? "/api/permdock",
			tenant: props.tenant,
			children: props.children
		}));
	};
	const permdockHandler = () => createEvaluationsHandler(compact({
		policy,
		getPermDock,
		store: options.store
	}));
	return {
		getPermDock,
		getPermission,
		PermDockProvider,
		permdockHandler
	};
}
//#endregion
export { createPermDock };
