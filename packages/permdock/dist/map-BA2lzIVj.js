import { t as compact } from "./compact-CxSqQNw0.js";
import { n as findPermission, o as listPermissions } from "./permissions-WEkUHQtZ.js";
//#region src/authzen/map.ts
const UNKNOWN = {
	outcome: "denied",
	denials: [{
		role: null,
		reason: "no-grant",
		detail: "unknown-permission"
	}],
	alternatives: []
};
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function actionNameOf(item) {
	if (typeof item.action?.name === "string") return item.action.name;
	if (!isRecord(item.action?.properties)) return;
	const scope = item.action.properties.scope;
	return typeof scope === "string" ? scope : void 0;
}
function permissionOf(tree, item) {
	const actionName = actionNameOf(item);
	if (actionName === void 0) return;
	const byKey = findPermission(tree, actionName);
	if (byKey !== void 0) return byKey;
	const resource = typeof item.resource?.type === "string" ? item.resource.type : void 0;
	if (resource === void 0) return;
	const dotted = findPermission(tree, `${resource}.${actionName}`);
	if (dotted !== void 0) return dotted;
	return listPermissions(tree).find((leaf) => leaf.resource === resource && leaf.action === actionName);
}
function resourceData(item) {
	const properties = item.resource?.properties;
	if (properties !== null && typeof properties === "object") return properties;
	const id = item.resource?.id;
	if (typeof id === "string" || typeof id === "number") return { id: String(id) };
}
function resourceIdOf(item) {
	const id = item.resource?.id;
	if (typeof id === "string" || typeof id === "number") return String(id);
}
function userFromEntity(entity) {
	if (entity === void 0) return null;
	const result = {};
	if (typeof entity.id === "string" || typeof entity.id === "number") result.id = String(entity.id);
	if (isRecord(entity.properties)) for (const [key, value] of Object.entries(entity.properties)) {
		if (key === "actor" || key === "delegation") continue;
		result[key] = value;
	}
	return Object.keys(result).length === 0 ? null : result;
}
function actorOf(item) {
	const context = isRecord(item.context) ? item.context : {};
	const fromSubject = isRecord(item.subject?.properties) ? item.subject.properties.actor : void 0;
	const raw = context.actor ?? fromSubject;
	if (!isRecord(raw) || typeof raw.id !== "string") return;
	const kind = typeof raw.kind === "string" ? raw.kind : "oauth-client";
	return {
		id: raw.id,
		kind
	};
}
function delegationOf(item) {
	const context = isRecord(item.context) ? item.context : {};
	const fromSubject = isRecord(item.subject?.properties) ? item.subject.properties.delegation : void 0;
	const raw = context.delegation ?? fromSubject;
	if (!isRecord(raw)) return;
	const scopes = raw.scopes;
	const authorizationDetails = raw.authorizationDetails;
	return compact({
		scopes: Array.isArray(scopes) ? scopes.filter((scope) => typeof scope === "string") : void 0,
		authorizationDetails: Array.isArray(authorizationDetails) ? authorizationDetails : void 0
	});
}
function tenantOf(item) {
	if (!isRecord(item.context) || typeof item.context.tenant !== "string") return;
	return item.context.tenant;
}
function evaluationContext(decision) {
	switch (decision.outcome) {
		case "granted": return {
			outcome: "granted",
			matched: decision.matched,
			token: decision.token,
			permdock: decision
		};
		case "denied": {
			const unknown = decision.denials.some((denial) => denial.detail === "unknown-permission");
			return compact({
				outcome: "denied",
				denials: decision.denials,
				alternatives: decision.alternatives.map((leaf) => leaf.key),
				reason: unknown ? "unknown-permission" : void 0,
				permdock: decision
			});
		}
		case "approval-required": return {
			outcome: "approval-required",
			token: decision.token,
			permdock: decision
		};
		default: return decision;
	}
}
function evaluationRow(decision) {
	return {
		decision: decision.outcome === "granted",
		context: evaluationContext(decision)
	};
}
function pathnameOf(request) {
	return new URL(request.url).pathname;
}
function endsWithPath(pathname, suffix) {
	return pathname === suffix || pathname.endsWith(suffix);
}
function mergeItem(shared, item) {
	if (!isRecord(item)) return shared;
	return compact({
		subject: isRecord(item.subject) ? item.subject : shared.subject,
		action: isRecord(item.action) ? item.action : shared.action,
		resource: isRecord(item.resource) ? item.resource : shared.resource,
		context: item.context ?? shared.context
	});
}
function pageOf(body) {
	const page = isRecord(body.page) ? body.page : {};
	const raw = typeof page.token === "string" ? page.token : typeof page.next_token === "string" ? page.next_token : "0";
	const parsed = Math.trunc(Number(raw));
	const sizeRaw = page.size;
	const size = typeof sizeRaw === "number" && sizeRaw > 0 ? Math.min(sizeRaw, 200) : 50;
	return {
		offset: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
		size
	};
}
function paged(items, offset, size) {
	const slice = items.slice(offset, offset + size);
	const next = offset + slice.length;
	return {
		results: slice,
		page: { next_token: next < items.length ? String(next) : "" }
	};
}
//#endregion
export { evaluationRow as a, pageOf as c, permissionOf as d, resourceData as f, userFromEntity as h, endsWithPath as i, paged as l, tenantOf as m, actorOf as n, isRecord as o, resourceIdOf as p, delegationOf as r, mergeItem as s, UNKNOWN as t, pathnameOf as u };
