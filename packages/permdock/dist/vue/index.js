import { t as describe } from "../describe-BnKr1Gwo.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { t as approvalHeaders } from "../headers-B5RRv3Xm.js";
import { t as createClientStore } from "../store-7x8sZ9LH.js";
import { computed, defineComponent, inject, onScopeDispose, shallowRef, toValue } from "vue";
//#region src/vue/context.ts
const permDockKey = Symbol("permdock");
//#endregion
//#region src/vue/composables.ts
function useStore() {
	const store = inject(permDockKey);
	if (store === void 0) throw new Error("PermDock: composables require permdockPlugin.");
	return store;
}
function useTick(store) {
	const tick = shallowRef(0);
	onScopeDispose(store.subscribe(() => {
		tick.value += 1;
	}));
	return computed(() => {
		tick.value;
		return store.get();
	});
}
function usePermDock() {
	const dock = useTick(useStore());
	return new Proxy({}, { get(_target, prop, _receiver) {
		return Reflect.get(dock.value, prop);
	} });
}
function usePermission(permission, data) {
	const store = useStore();
	const dock = useTick(store);
	const state = computed(() => {
		dock.value;
		return store.permissionState(permission, toValue(data));
	});
	return {
		allowed: computed(() => state.value.allowed),
		status: computed(() => state.value.status),
		decision: computed(() => state.value.decision)
	};
}
function usePermissions(permissions, data) {
	const store = useStore();
	const dock = useTick(store);
	return computed(() => {
		dock.value;
		const granted = [];
		const byKey = {};
		for (const permission of toValue(permissions)) {
			const next = store.permissionState(permission, toValue(data));
			byKey[permission.key] = next;
			if (next.allowed) granted.push(permission);
		}
		return new Proxy({
			granted,
			get(permission) {
				return byKey[permission.key];
			}
		}, { get(target, prop, receiver) {
			if (typeof prop === "string" && Object.hasOwn(byKey, prop)) return byKey[prop];
			return Reflect.get(target, prop, receiver);
		} });
	});
}
function useFilter(permission, rows) {
	const dock = useTick(useStore());
	return computed(() => {
		const result = [...dock.value.filter(permission, toValue(rows))];
		result.partial = dock.value.where(permission).partial;
		return result;
	});
}
function useTenant() {
	const dock = useTick(useStore());
	return computed(() => ({
		tenant: dock.value.subject.principal?.tenant ?? null,
		tenants: dock.value.tenants(),
		switchTo: (id) => dock.value.refresh({ tenant: id }),
		status: dock.value.status()
	}));
}
function useMemberships() {
	const dock = useTick(useStore());
	return computed(() => dock.value.memberships());
}
function useRoles(options = {}) {
	const dock = useTick(useStore());
	return computed(() => {
		const next = toValue(options);
		return { roles: (next.team === void 0 ? dock.value : dock.value.team(next.team)).roles(next.tenant === void 0 ? void 0 : { tenant: next.tenant }) };
	});
}
function useAssignableRoles() {
	const dock = useTick(useStore());
	return computed(() => dock.value.assignable());
}
function useSubject() {
	const dock = useTick(useStore());
	return computed(() => {
		const snapshot = dock.value.snapshot();
		const simulated = typeof snapshot === "object" && snapshot !== null && "simulated" in snapshot && snapshot.simulated === true;
		return {
			principal: dock.value.subject.principal,
			actor: dock.value.subject.actor,
			delegation: dock.value.subject.delegation,
			expiresAt: dock.value.subject.expiresAt,
			simulated
		};
	});
}
function useApproval(decision) {
	const store = useStore();
	return computed(() => {
		const next = toValue(decision);
		let state = "not-needed";
		if (next.outcome === "approval-required") state = "required";
		return {
			state,
			token: next.outcome === "approval-required" ? next.token : void 0,
			request: (note) => store.requestApproval(next, note)
		};
	});
}
//#endregion
//#region src/vue/plugin.ts
const permdockPlugin = { install(app, options) {
	app.provide(permDockKey, createClientStore(compact({
		snapshot: options.snapshot,
		endpoint: options.endpoint,
		approvals: options.approvals,
		tenant: options.tenant,
		fetch: options.fetch,
		headers: options.headers,
		maxAge: options.maxAge,
		verifier: options.verifier
	})));
} };
//#endregion
//#region src/vue/protected.ts
const Protected = defineComponent({
	name: "Protected",
	props: {
		permission: {
			type: Object,
			required: true
		},
		data: {
			type: Object,
			required: false
		},
		tenant: {
			type: String,
			required: false
		}
	},
	setup(props, { slots }) {
		const local = usePermission(props.permission, () => props.data);
		const root = usePermDock();
		return () => {
			const scoped = props.tenant === void 0 ? {
				allowed: local.allowed.value,
				status: local.status.value,
				decision: local.decision.value
			} : tenantView(root.tenant(props.tenant), props.permission, props.data);
			if (scoped.status === "pending") return slots.pending?.() ?? null;
			if (!scoped.allowed || scoped.decision.outcome !== "granted") return slots.fallback?.({ decision: scoped.decision }) ?? null;
			return slots.default?.({ decision: scoped.decision }) ?? null;
		};
	}
});
function tenantView(dock, permission, data) {
	const decision = dock.decide(permission, data);
	return {
		allowed: decision.outcome === "granted",
		status: "ready",
		decision
	};
}
//#endregion
export { Protected, approvalHeaders, describe, permdockPlugin, useApproval, useAssignableRoles, useFilter, useMemberships, usePermDock, usePermission, usePermissions, useRoles, useSubject, useTenant };
