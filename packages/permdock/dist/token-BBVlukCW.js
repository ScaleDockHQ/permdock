import { n as isConditionDate, r as isConditionRef } from "./ast-BMo2MvmN.js";
import { a as readPath, r as ownGet } from "./paths-AH4M6YYV.js";
import { t as freezeDeep } from "./freeze-BF4IK5al.js";
import { t as compact } from "./compact-CxSqQNw0.js";
import { n as findPermission } from "./permissions-WEkUHQtZ.js";
import { n as sha256, t as bytesToBase64Url } from "./sha256-CeSpVRME.js";
//#region src/conditions/evaluate.ts
function isExpired(membership, now) {
	return membership.expiresAt !== void 0 && membership.expiresAt <= now;
}
function resolveRef(ref, subject) {
	if (!ref.startsWith("subject")) return;
	const rest = ref.slice(7);
	if (rest === "") return subject;
	if (!rest.startsWith(".")) return;
	const path = rest.slice(1);
	if (path === "id") return subject.principal?.id;
	if (path.startsWith("context.")) return readPath(subject.context, path.slice(8));
	if (subject.principal === null) return;
	return readPath(subject.principal, path);
}
function unwrap(value, subject) {
	if (isConditionRef(value)) return resolveRef(value.ref, subject);
	if (isConditionDate(value)) return Date.parse(value.date);
	if (Array.isArray(value)) return value.map((item) => unwrap(item, subject));
	return value;
}
function toInstant(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (value instanceof Date) {
		const time = value.getTime();
		return Number.isNaN(time) ? void 0 : time;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? void 0 : parsed;
	}
}
function compare(op, left, right) {
	if (left === void 0 || left === null || right === void 0 || right === null) return false;
	const leftInstant = toInstant(left);
	const rightInstant = toInstant(right);
	const comparable = leftInstant !== void 0 && rightInstant !== void 0 ? [leftInstant, rightInstant] : typeof left === typeof right ? [left, right] : void 0;
	if (comparable === void 0) return false;
	const [a, b] = comparable;
	switch (op) {
		case "eq": return a === b;
		case "ne": return a !== b;
		case "gt": return a > b;
		case "gte": return a >= b;
		case "lt": return a < b;
		case "lte": return a <= b;
		default:
 /* v8 ignore next */
		return false;
	}
}
function contains(left, right) {
	if (left === void 0 || left === null || right === void 0 || right === null) return false;
	if (typeof left === "string" && typeof right === "string") return left.includes(right);
	if (Array.isArray(left)) return left.includes(right);
	return false;
}
function inList(left, right) {
	if (left === void 0 || left === null || !Array.isArray(right)) return false;
	return right.includes(left);
}
function matchesParentHop(data, parents, membershipId) {
	if (parents === void 0) return false;
	for (const parentField of parents) if (ownGet(data, parentField) === membershipId) return true;
	return false;
}
function evaluateMemberOf(condition, data, subject, now) {
	if (data === null || typeof data !== "object") return false;
	const rowValue = ownGet(data, condition.field);
	if (rowValue === void 0 || rowValue === null) return false;
	const memberships = subject.principal?.memberships ?? [];
	const wanted = new Set(condition.roles);
	for (const membership of memberships) {
		if (isExpired(membership, now)) continue;
		if (!membership.roles.some((role) => wanted.has(role))) continue;
		if (condition.scope === "tenant") {
			if (membership.tenant === rowValue) return true;
			continue;
		}
		if (condition.scope === "team") {
			if (membership.team !== rowValue) continue;
			if (membership.tenant !== void 0 && subject.principal?.tenant !== void 0) return membership.tenant === subject.principal.tenant;
			return true;
		}
		if (membership.on === void 0) continue;
		if (condition.resource !== void 0 && membership.on.resource !== condition.resource) {
			if (matchesParentHop(data, condition.parents, membership.on.id)) return true;
			continue;
		}
		if (membership.on.id === rowValue) return true;
		if (matchesParentHop(data, condition.parents, membership.on.id)) return true;
	}
	return false;
}
function evaluateCondition(condition, data, subject, now = Date.now() / 1e3) {
	switch (condition.op) {
		case "and": return condition.conditions.every((child) => evaluateCondition(child, data, subject, now));
		case "or": return condition.conditions.some((child) => evaluateCondition(child, data, subject, now));
		case "not": return !evaluateCondition(condition.condition, data, subject, now);
		case "isNull": {
			if (data === null || typeof data !== "object") return false;
			const value = ownGet(data, condition.field);
			const isNull = value === null || value === void 0;
			return condition.value ? isNull : !isNull;
		}
		case "in":
		case "notIn": {
			if (data === null || typeof data !== "object") return false;
			const left = ownGet(data, condition.field);
			const matched = inList(left, unwrap(condition.value, subject));
			return condition.op === "in" ? matched : !matched && left !== void 0 && left !== null;
		}
		case "contains":
			if (data === null || typeof data !== "object") return false;
			return contains(ownGet(data, condition.field), unwrap(condition.value, subject));
		case "eq":
		case "ne":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			if (data === null || typeof data !== "object") return false;
			return compare(condition.op, ownGet(data, condition.field), unwrap(condition.value, subject));
		case "memberOf": return evaluateMemberOf(condition, data, subject, now);
		case "opaque": return false;
		default:
 /* v8 ignore next */
		return condition;
	}
}
//#endregion
//#region src/core/arazzo.ts
const denied = (reason) => freezeDeep({
	outcome: "denied",
	denials: [{
		role: null,
		reason
	}],
	alternatives: []
});
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asString(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function parseWorkflows(arazzo) {
	if (!isRecord(arazzo) || !Array.isArray(arazzo.workflows)) return;
	const version = asString(arazzo.arazzo) ?? "1.1.0";
	if (!version.startsWith("1.0.") && version !== "1.1.0") return;
	const out = [];
	for (const item of arazzo.workflows) {
		if (!isRecord(item)) continue;
		const workflowId = asString(item.workflowId);
		if (workflowId === void 0) continue;
		const steps = [];
		if (Array.isArray(item.steps)) for (const step of item.steps) {
			if (!isRecord(step)) continue;
			const stepId = asString(step.stepId);
			if (stepId === void 0) continue;
			steps.push(compact({
				stepId,
				operationId: asString(step.operationId),
				operationPath: asString(step.operationPath),
				workflowId: asString(step.workflowId),
				parameters: Array.isArray(step.parameters) ? step.parameters : void 0
			}));
		}
		out.push({
			workflowId,
			steps
		});
	}
	return out;
}
function unescapePointer(token) {
	return token.replaceAll("~1", "/").replaceAll("~0", "~");
}
function readPointer(doc, pointer) {
	if (!pointer.startsWith("#/")) return;
	let current = doc;
	for (const raw of pointer.slice(2).split("/")) {
		if (!isRecord(current)) return;
		current = current[unescapePointer(raw)];
	}
	return current;
}
function operationsById(openapi) {
	const map = /* @__PURE__ */ new Map();
	if (!isRecord(openapi) || !isRecord(openapi.paths)) return map;
	for (const pathItem of Object.values(openapi.paths)) {
		if (!isRecord(pathItem)) continue;
		for (const [method, operation] of Object.entries(pathItem)) {
			if (method.startsWith("x-") || !isRecord(operation)) continue;
			const operationId = asString(operation.operationId);
			if (operationId !== void 0) map.set(operationId, {
				operationId,
				node: operation
			});
		}
	}
	return map;
}
function resolveOpenapi(openapi, sourceName) {
	if (sourceName !== void 0 && isRecord(openapi) && isRecord(openapi[sourceName])) return openapi[sourceName];
	return openapi;
}
function sourceNameOf(operationPath) {
	return /^\$sourceDescriptions\.([^#]+)/u.exec(operationPath)?.[1];
}
function pointerOf(operationPath) {
	const hash = operationPath.indexOf("#");
	return hash === -1 ? void 0 : operationPath.slice(hash);
}
function permissionKeysOf(node) {
	if (!isRecord(node)) return [];
	const raw = node["x-permdock-permissions"];
	if (!Array.isArray(raw)) return [];
	return raw.filter((item) => typeof item === "string");
}
function isExpression(value) {
	return typeof value === "string" && value.startsWith("$");
}
function dataFrom(step, inputs) {
	const record = inputs === void 0 ? {} : { ...inputs };
	let provisional = false;
	for (const parameter of step.parameters ?? []) {
		const name = asString(parameter.name);
		if (name === void 0) continue;
		if (isExpression(parameter.value)) {
			provisional = true;
			continue;
		}
		record[name] = parameter.value;
	}
	if (Object.keys(record).length === 0) return {
		data: void 0,
		provisional
	};
	return {
		data: record,
		provisional
	};
}
function flattenSteps(workflows, workflowId, seen) {
	if (seen.has(workflowId)) return "cycle";
	const workflow = workflows.find((item) => item.workflowId === workflowId);
	if (workflow === void 0) return "missing";
	seen.add(workflowId);
	const out = [];
	for (const step of workflow.steps) {
		if (step.workflowId !== void 0) {
			const nested = flattenSteps(workflows, step.workflowId, seen);
			if (nested === "cycle" || nested === "missing") return nested;
			out.push(...nested);
			continue;
		}
		out.push(step);
	}
	seen.delete(workflowId);
	return out;
}
function sourceType(arazzo, sourceName) {
	if (!isRecord(arazzo) || !Array.isArray(arazzo.sourceDescriptions)) return;
	for (const source of arazzo.sourceDescriptions) {
		if (!isRecord(source)) continue;
		if (sourceName === void 0 || source.name === sourceName) return asString(source.type);
	}
}
function arazzoFindings(input, tree) {
	const workflows = parseWorkflows(input.arazzo);
	if (workflows === void 0 || workflows.length === 0) return [{
		stepId: "document",
		workflowId: input.workflowId ?? "",
		reason: "validation",
		detail: "Arazzo document is missing or not 1.0.x / 1.1.0"
	}];
	const workflowId = input.workflowId ?? workflows[0]?.workflowId ?? "";
	const flat = flattenSteps(workflows, workflowId, /* @__PURE__ */ new Set());
	if (flat === "cycle") return [{
		stepId: "document",
		workflowId,
		reason: "validation",
		detail: "workflowId cycle"
	}];
	if (flat === "missing") return [{
		stepId: "document",
		workflowId,
		reason: "validation",
		detail: `unknown workflowId ${workflowId}`
	}];
	const findings = [];
	for (const step of flat) {
		const sourceName = step.operationPath === void 0 ? void 0 : sourceNameOf(step.operationPath);
		if (sourceType(input.arazzo, sourceName) === "asyncapi") {
			findings.push({
				stepId: step.stepId,
				workflowId,
				reason: "unsupported",
				detail: "AsyncAPI steps are not evaluated"
			});
			continue;
		}
		const doc = resolveOpenapi(input.openapi, sourceName);
		const byId = operationsById(doc);
		let node;
		let operationId = step.operationId;
		if (step.operationPath !== void 0) {
			node = readPointer(doc, pointerOf(step.operationPath) ?? "");
			if (isRecord(node)) operationId = asString(node.operationId) ?? operationId;
		} else if (operationId !== void 0) node = byId.get(operationId)?.node;
		if (node === void 0) {
			findings.push({
				stepId: step.stepId,
				workflowId,
				reason: "undocumented",
				detail: "operation not found"
			});
			continue;
		}
		const keys = permissionKeysOf(node);
		if (keys.length === 0) {
			findings.push({
				stepId: step.stepId,
				workflowId,
				reason: "undocumented",
				detail: "operation has no x-permdock-permissions"
			});
			continue;
		}
		if (tree === void 0) continue;
		for (const key of keys) if (findPermission(tree, key) === void 0) findings.push({
			stepId: step.stepId,
			workflowId,
			reason: "unknown-key",
			detail: key
		});
	}
	return findings;
}
function worst(outcomes) {
	if (outcomes.includes("denied")) return "denied";
	if (outcomes.includes("approval-required")) return "approval-required";
	return "granted";
}
function combine(decisions) {
	if (decisions.length === 0) return denied("undocumented");
	const outcome = worst(decisions.map((item) => item.outcome));
	return decisions.find((item) => item.outcome === outcome) ?? decisions[0];
}
function simulateArazzo(input, tree, decide) {
	const findings = arazzoFindings(input, tree);
	const workflows = parseWorkflows(input.arazzo);
	const workflowId = input.workflowId ?? workflows?.[0]?.workflowId ?? "unknown";
	if (workflows === void 0) return freezeDeep({
		workflowId,
		outcome: "denied",
		steps: [{
			stepId: "document",
			permissions: [],
			decision: denied("validation")
		}]
	});
	const flat = flattenSteps(workflows, workflowId, /* @__PURE__ */ new Set());
	if (flat === "cycle" || flat === "missing") return freezeDeep({
		workflowId,
		outcome: "denied",
		steps: [{
			stepId: "document",
			permissions: [],
			decision: denied("validation")
		}]
	});
	const findingByStep = /* @__PURE__ */ new Map();
	for (const finding of findings) if (!findingByStep.has(finding.stepId)) findingByStep.set(finding.stepId, finding);
	const steps = [];
	for (const step of flat) {
		const finding = findingByStep.get(step.stepId);
		if (finding !== void 0) {
			const reason = finding.reason === "unknown-key" ? "undocumented" : finding.reason;
			steps.push(compact({
				stepId: step.stepId,
				operationId: step.operationId,
				permissions: [],
				decision: denied(reason)
			}));
			continue;
		}
		const sourceName = step.operationPath === void 0 ? void 0 : sourceNameOf(step.operationPath);
		const doc = resolveOpenapi(input.openapi, sourceName);
		const byId = operationsById(doc);
		let node;
		let operationId = step.operationId;
		if (step.operationPath !== void 0) {
			node = readPointer(doc, pointerOf(step.operationPath) ?? "");
			if (isRecord(node)) operationId = asString(node.operationId) ?? operationId;
		} else if (operationId !== void 0) node = byId.get(operationId)?.node;
		const permissions = permissionKeysOf(node).flatMap((key) => {
			const leaf = tree === void 0 ? void 0 : findPermission(tree, key);
			return leaf === void 0 ? [] : [leaf];
		});
		const { data, provisional } = dataFrom(step, input.inputs);
		const decisions = permissions.map((permission) => decide(permission, data));
		steps.push(compact({
			stepId: step.stepId,
			operationId,
			permissions,
			decision: combine(decisions),
			provisional: provisional ? true : void 0
		}));
	}
	return freezeDeep({
		workflowId,
		outcome: worst(steps.map((step) => step.decision.outcome)),
		steps
	});
}
function isArazzoSimulateInput(value) {
	return isRecord(value) && "arazzo" in value;
}
//#endregion
//#region src/core/delegation.ts
function coveredByDelegation(permission, delegation, resourceId) {
	if (delegation === void 0) return;
	const hasScopes = delegation.scopes !== void 0;
	const hasDetails = delegation.authorizationDetails !== void 0;
	const hasAccess = delegation.access !== void 0;
	if (!hasScopes && !hasDetails && !hasAccess) return;
	const emptyScopes = hasScopes && (delegation.scopes?.length ?? 0) === 0;
	const emptyAccess = hasAccess && (delegation.access?.length ?? 0) === 0;
	if (emptyScopes && !hasDetails && !hasAccess) return "no-delegation";
	if (emptyAccess && !hasScopes && !hasDetails) return "no-delegation";
	if (emptyScopes && emptyAccess && !hasDetails) return "no-delegation";
	const scopeOk = delegation.scopes?.includes(permission.scope) ?? false;
	const detailOk = delegation.authorizationDetails?.some((detail) => {
		if (detail.type !== permission.resource) return false;
		if (detail.actions === void 0) return true;
		return detail.actions.includes(permission.action);
	}) ?? false;
	const accessOk = accessCovers(permission, delegation.access, resourceId);
	if (scopeOk || detailOk || accessOk) return;
	return "not-delegated";
}
function accessCovers(permission, access, resourceId) {
	if (access === void 0) return false;
	return access.some((entry) => {
		if (typeof entry === "string") return entry === permission.scope;
		if (entry === null || typeof entry !== "object") return false;
		const type = entry.type;
		if (typeof type !== "string" || !typeMatches(type, permission.resource)) return false;
		const actions = entry.actions;
		if (Array.isArray(actions) && !actions.includes(permission.action)) return false;
		const identifier = entry.identifier;
		if (typeof identifier === "string" && identifier !== resourceId) return false;
		return true;
	});
}
function typeMatches(type, resource) {
	if (type === resource) return true;
	return type.endsWith(`/${resource}`);
}
function resourceIdOf(data) {
	if (data === null || typeof data !== "object" || !("id" in data)) return;
	const id = data.id;
	return typeof id === "string" || typeof id === "number" ? String(id) : void 0;
}
//#endregion
//#region src/core/token.ts
function canonical(value) {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonical);
	const record = value;
	const keys = Object.keys(record).toSorted();
	const out = {};
	for (const key of keys) {
		if (key === "binding") continue;
		out[key] = canonical(record[key]);
	}
	return out;
}
function decisionToken(input) {
	const payload = JSON.stringify({
		key: input.key,
		resourceId: input.resourceId,
		principal: canonical(input.principal),
		actor: canonical(input.actor ?? null),
		fingerprint: input.fingerprint
	});
	return `pd1.${bytesToBase64Url(sha256(payload))}`;
}
//#endregion
export { isArazzoSimulateInput as a, arazzoFindings as i, coveredByDelegation as n, simulateArazzo as o, resourceIdOf as r, evaluateCondition as s, decisionToken as t };
