import { n as evaluateCondition, t as decisionToken } from "./token-DOBVfZ_i.js";
import { t as freezeDeep } from "./freeze-BF4IK5al.js";
import { t as compact } from "./compact-CxSqQNw0.js";
import { a as deniedMessage, i as approvalMessage, n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "./errors-DDT8tC4N.js";
import { n as pickVisible, r as sanitizeContext, t as grantCoversField } from "./fields-BXlUUepW.js";
import { a as matchScopedMembership, c as tenantsOf, o as nowSeconds, r as signSnapshot, s as resolveActiveTenant, t as buildSnapshot } from "./snapshot-BiwEN_W3.js";
import { i as getResource, o as listPermissions } from "./permissions-WEkUHQtZ.js";
import { i as isSubject, r as isPrincipal, t as anonymousSubject } from "./subject-DgYVJ_Q0.js";
//#region src/core/limits.ts
const UNIT_SECONDS = {
	s: 1,
	sec: 1,
	secs: 1,
	second: 1,
	seconds: 1,
	m: 60,
	min: 60,
	mins: 60,
	minute: 60,
	minutes: 60,
	h: 3600,
	hr: 3600,
	hrs: 3600,
	hour: 3600,
	hours: 3600,
	d: 86400,
	day: 86400,
	days: 86400
};
function isThenable$2(value) {
	return value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
}
function limitWindowId(per, now) {
	const trimmed = per.trim().toLowerCase();
	const named = UNIT_SECONDS[trimmed];
	if (named !== void 0) return String(Math.floor(now / named));
	const match = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/u.exec(trimmed);
	if (match !== null) {
		const amount = Number(match[1]);
		const unit = UNIT_SECONDS[match[2] ?? ""];
		if (unit !== void 0 && Number.isFinite(amount) && amount > 0) return String(Math.floor(now / (amount * unit)));
	}
	return "0";
}
function limitCacheKey(subjectId, key, per, now) {
	return `${subjectId}:${key}:${per}:${limitWindowId(per, now)}`;
}
function memoryLimitStore() {
	const used = /* @__PURE__ */ new Map();
	const bucket = (input) => limitCacheKey(input.subjectId, input.key, input.per, input.now ?? Date.now() / 1e3);
	return {
		remaining(input) {
			const cap = input.count;
			if (!Number.isFinite(cap) || cap <= 0) return { remaining: -1 };
			return { remaining: cap - (used.get(bucket(input)) ?? 0) };
		},
		consume(input) {
			const cap = input.count;
			if (!Number.isFinite(cap) || cap <= 0) return { remaining: -1 };
			const id = bucket(input);
			const seen = used.get(id) ?? 0;
			if (seen >= cap) return { remaining: -1 };
			used.set(id, seen + 1);
			return { remaining: cap - seen - 1 };
		}
	};
}
function applyQuota(input) {
	const limit = input.grant.limit;
	if (limit === void 0) return { ok: true };
	if (input.store === void 0) return {
		ok: false,
		reason: "limit-unavailable"
	};
	const payload = {
		key: input.permissionKey,
		subjectId: input.subjectId,
		count: limit.count,
		per: limit.per,
		now: input.now
	};
	const cacheKey = limitCacheKey(input.subjectId, input.permissionKey, limit.per, input.now);
	if (!input.consume) {
		try {
			const peeked = input.store.remaining(payload);
			if (isThenable$2(peeked)) return {
				ok: false,
				reason: "limit-unavailable"
			};
			if (peeked !== void 0) return peeked.remaining > 0 ? { ok: true } : {
				ok: false,
				reason: "limit"
			};
		} catch {
			return {
				ok: false,
				reason: "limit-unavailable"
			};
		}
		const cached = input.cache.get(cacheKey);
		if (cached === void 0) return {
			ok: false,
			reason: "limit-unavailable"
		};
		return cached > 0 ? { ok: true } : {
			ok: false,
			reason: "limit"
		};
	}
	try {
		const consumed = input.store.consume(payload);
		if (isThenable$2(consumed)) return {
			ok: false,
			reason: "limit-unavailable"
		};
		input.cache.set(cacheKey, consumed.remaining);
		if (consumed.remaining < 0) return {
			ok: false,
			reason: "limit"
		};
		return { ok: true };
	} catch {
		return {
			ok: false,
			reason: "limit-unavailable"
		};
	}
}
//#endregion
//#region src/core/validation.ts
function isThenable$1(value) {
	return value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
}
function validateBoundary(permission, resource, data, mode, trusted, boundary = "manual") {
	if (!(mode === "always" || mode === "boundary" && !trusted)) return data;
	if (resource?.schema === void 0) {
		if (mode === "always") throw new PermDockValidationError({
			code: "no-schema",
			permission: permission.key,
			resource: permission.resource,
			boundary,
			message: `${permission.key}: no schema for resource ${permission.resource}.`
		});
		return data;
	}
	const result = resource.schema["~standard"].validate(data);
	if (isThenable$1(result)) throw new PermDockValidationError({
		code: "async-schema",
		permission: permission.key,
		resource: permission.resource,
		boundary,
		message: `${permission.key}: schema for ${permission.resource} is async.`
	});
	if ("issues" in result && result.issues !== void 0) throw new PermDockValidationError({
		code: "invalid-data",
		permission: permission.key,
		resource: permission.resource,
		issues: result.issues,
		boundary,
		message: validationMessage(permission, resource, result.issues)
	});
	return result.value;
}
function validationMessage(permission, resource, issues) {
	const parts = issues.map((issue) => {
		const path = issue.path?.map((item) => typeof item === "object" && "key" in item ? String(item.key) : String(item)).join(".") ?? "/";
		return `invalid ${resource.name} data at ${path}: ${issue.message}`;
	});
	return `${permission.key}: ${parts.join("; ")}.`;
}
//#endregion
//#region src/core/permdock.ts
function isRowPair(value) {
	return value !== null && typeof value === "object" && "current" in value && "next" in value;
}
function isThenable(value) {
	return value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
}
function emitSafe(listeners, payload, errors) {
	for (const listener of listeners) try {
		listener(payload);
	} catch (error) {
		for (const handler of errors.error) try {
			handler(error);
		} catch {}
	}
}
function customRolesFor(source, tenants, auth) {
	if (source === void 0) return [];
	const loaded = [];
	for (const tenant of tenants) try {
		loaded.push(source.rolesFor(tenant));
	} catch {
		auth.push({
			reason: "source-threw",
			source: "customRoles"
		});
		loaded.push([]);
	}
	if (loaded.some((item) => isThenable(item))) return Promise.all(loaded.map((item) => Promise.resolve(item).catch(() => {
		auth.push({
			reason: "source-threw",
			source: "customRoles"
		});
		return [];
	}))).then((lists) => lists.flat());
	return loaded.flat();
}
function expandRoleNames(names, declared, custom) {
	const resolved = /* @__PURE__ */ new Set();
	const unknown = [];
	for (const name of names) {
		if (declared.has(name)) {
			resolved.add(name);
			continue;
		}
		const customRole = custom.find((item) => item.name === name);
		if (customRole === void 0) {
			unknown.push(name);
			continue;
		}
		for (const included of customRole.includes) if (declared.has(included)) resolved.add(included);
	}
	return {
		roles: [...resolved],
		unknown
	};
}
function alternativesFor(policy, permission, subject, env) {
	return listPermissions(policy.permissions).filter((leaf) => leaf.resource === permission.resource && leaf.key !== permission.key).filter((leaf) => {
		return evaluate(policy, subject, leaf, void 0, {
			trusted: true,
			source: "decide"
		}, {
			...env,
			emit: false,
			skipAlternatives: true
		}).outcome === "granted";
	});
}
function emptyListeners() {
	return {
		decision: /* @__PURE__ */ new Set(),
		denied: /* @__PURE__ */ new Set(),
		approval: /* @__PURE__ */ new Set(),
		auth: /* @__PURE__ */ new Set(),
		error: /* @__PURE__ */ new Set()
	};
}
function coveredByDelegation(permission, delegation) {
	if (delegation === void 0) return;
	const hasScopes = delegation.scopes !== void 0;
	const hasDetails = delegation.authorizationDetails !== void 0;
	if (!hasScopes && !hasDetails) return;
	if (hasScopes && (delegation.scopes?.length ?? 0) === 0 && !hasDetails) return "no-delegation";
	const scopeOk = delegation.scopes?.includes(permission.scope) ?? false;
	const detailOk = delegation.authorizationDetails?.some((detail) => {
		if (detail.type !== permission.resource) return false;
		if (detail.actions === void 0) return true;
		return detail.actions.includes(permission.action);
	}) ?? false;
	if (scopeOk || detailOk) return;
	return "not-delegated";
}
function evaluateGrantCondition(grant, permission, current, next, subject, now) {
	if (!grant.portable && grant.closure !== void 0) try {
		const result = grant.closure(next ?? current, {
			subject,
			actor: subject.actor,
			delegation: subject.delegation,
			context: subject.context
		});
		if (isThenable(result)) return {
			matched: false,
			reason: "closure-error",
			cause: result
		};
		return { matched: result === true };
	} catch (error) {
		return {
			matched: false,
			reason: "closure-error",
			cause: error
		};
	}
	if (grant.where !== void 0) {
		if (permission.kind === "collection") return {
			matched: false,
			reason: "condition"
		};
		if (current === void 0) return {
			matched: false,
			reason: "condition"
		};
		if (grant.where.op === "opaque" || grant.check?.op === "opaque") return {
			matched: false,
			reason: "opaque-condition"
		};
		if (!evaluateCondition(grant.where, current, subject, now)) return {
			matched: false,
			reason: "condition"
		};
	}
	const checkCondition = grant.check ?? (permission.action === "update" ? grant.where : void 0);
	if (checkCondition !== void 0) {
		if (checkCondition.op === "opaque") return {
			matched: false,
			reason: "opaque-condition"
		};
		if (next === void 0) return {
			matched: false,
			reason: "condition"
		};
		if (!evaluateCondition(checkCondition, next, subject, now)) return {
			matched: false,
			reason: "condition"
		};
	}
	return { matched: true };
}
function shouldConsumeQuota(source, simulated) {
	if (simulated) return false;
	switch (source) {
		case "can":
		case "filter":
		case "simulate": return false;
		case "decide":
		case "assert":
		case "endpoint":
		case "adapter":
		case "approval":
		case void 0: return true;
		default: return source;
	}
}
function isDelegatedPermission(policy, permission) {
	const providers = policy.providers;
	if (providers === void 0 || providers.length === 0) return false;
	for (const provider of providers) if (provider.handles(permission)) return true;
	return false;
}
function evaluate(policy, subject, permission, data, options, env) {
	const now = options.now ?? nowSeconds();
	const trusted = options.trusted ?? true;
	const resource = getResource(policy.permissions, permission.resource);
	let current = data;
	let next = data;
	if (permission.kind === "instance" && isRowPair(data)) {
		current = data.current;
		next = data.next;
	}
	if (permission.kind === "collection") {
		current = void 0;
		next = data;
	}
	try {
		if (permission.kind === "instance" || data !== void 0) {
			const validated = validateBoundary(permission, resource, permission.kind === "instance" && isRowPair(data) ? data.current : data, policy.validate, trusted, options.boundary ?? "manual");
			if (permission.kind === "instance" && isRowPair(data)) {
				current = validated;
				next = validateBoundary(permission, resource, data.next, policy.validate, trusted, options.boundary ?? "manual");
			} else if (permission.kind === "instance") {
				current = validated;
				next = validated;
			} else next = validated;
		}
	} catch (error) {
		if (error instanceof PermDockValidationError && error.code === "invalid-data") {
			const decision = freezeDeep({
				outcome: "denied",
				denials: [{
					role: null,
					reason: "validation",
					detail: error
				}],
				alternatives: []
			});
			finish(policy, subject, permission, current, decision, options, env, trusted);
			return decision;
		}
		throw error;
	}
	if (isDelegatedPermission(policy, permission)) {
		const decision = freezeDeep({
			outcome: "denied",
			denials: [{
				role: null,
				reason: "pdp-unavailable",
				detail: "use permdock/pdp createPermDock"
			}],
			alternatives: []
		});
		finish(policy, subject, permission, current, decision, options, env, trusted);
		return decision;
	}
	if (subject.principal === null) {
		const decision = freezeDeep({
			outcome: "denied",
			denials: [{
				role: null,
				reason: "anonymous"
			}],
			alternatives: []
		});
		finish(policy, subject, permission, current, decision, options, env, trusted);
		return decision;
	}
	const declared = new Set(policy.roles.map((role) => role.name));
	const globalNames = expandRoleNames(subject.principal.roles ?? [], declared, env.customRoles);
	if (globalNames.unknown.length > 0) emitSafe(env.listeners.auth, {
		reason: "unknown-role",
		source: "roles"
	}, env.listeners);
	const denials = [];
	const allows = [];
	const matchingRoles = new Set(globalNames.roles);
	for (const membership of subject.principal.memberships ?? []) {
		if (env.team !== void 0 && membership.team !== env.team) continue;
		const expanded = expandRoleNames(membership.roles, declared, env.customRoles);
		for (const name of expanded.roles) matchingRoles.add(name);
		for (const name of expanded.unknown) denials.push({
			role: name,
			reason: "unknown-role"
		});
	}
	for (const role of policy.roles) {
		if (!matchingRoles.has(role.name) && role.grants[0]?.scope === "global") continue;
		for (const grant of role.grants) {
			if (grant.permission.key !== permission.key) continue;
			const scope = grant.scope;
			if (scope !== "global" && !matchingRoles.has(role.name)) continue;
			if (scope === "global" && !globalNames.roles.includes(role.name)) continue;
			const rowForScope = permission.kind === "instance" ? current : void 0;
			const scopeMatch = matchScopedMembership(subject, scope, role.name, rowForScope, policy.scopes, resource, now);
			if (!scopeMatch.ok) {
				denials.push({
					role: role.name,
					reason: scopeMatch.reason
				});
				continue;
			}
			const condition = evaluateGrantCondition(grant, permission, current, next, subject, now);
			if (!condition.matched) {
				if (condition.reason === "closure-error") emitSafe(env.listeners.error, condition.cause ?? /* @__PURE__ */ new Error("closure-error"), env.listeners);
				denials.push({
					role: role.name,
					reason: condition.reason ?? "condition",
					detail: condition.cause
				});
				continue;
			}
			if (!grantCoversField(grant.fields, options.field, grant.effect)) continue;
			if (grant.effect === "deny") {
				const decision = freezeDeep({
					outcome: "denied",
					denials: [{
						role: role.name,
						reason: "deny"
					}],
					alternatives: env.skipAlternatives ? [] : alternativesFor(policy, permission, subject, env)
				});
				finish(policy, subject, permission, current, decision, options, env, trusted);
				return decision;
			}
			allows.push(scopeMatch.membership === void 0 ? { grant } : {
				grant,
				membership: scopeMatch.membership
			});
		}
	}
	if (allows.length === 0) {
		const reason = denials[0]?.reason ?? (globalNames.unknown.length > 0 && globalNames.roles.length === 0 ? "unknown-role" : "no-grant");
		const decision = freezeDeep({
			outcome: "denied",
			denials: denials.length > 0 ? denials : [{
				role: null,
				reason
			}],
			alternatives: env.skipAlternatives ? [] : alternativesFor(policy, permission, subject, env)
		});
		finish(policy, subject, permission, current, decision, options, env, trusted);
		return decision;
	}
	const delegationMiss = coveredByDelegation(permission, subject.delegation);
	if (delegationMiss !== void 0) {
		const decision = freezeDeep({
			outcome: "denied",
			denials: [{
				role: null,
				reason: delegationMiss
			}],
			alternatives: env.skipAlternatives ? [] : alternativesFor(policy, permission, subject, env)
		});
		finish(policy, subject, permission, current, decision, options, env, trusted);
		return decision;
	}
	const quotaDenials = [];
	let matchedAllow;
	for (const candidate of allows) {
		const consume = candidate.grant.approval !== "human" && shouldConsumeQuota(options.source, env.simulated);
		const quota = applyQuota({
			store: env.limits,
			cache: env.limitCache,
			grant: candidate.grant,
			permissionKey: permission.key,
			subjectId: subject.principal.id,
			now,
			consume
		});
		if (quota.ok) {
			matchedAllow = candidate;
			break;
		}
		quotaDenials.push({
			role: candidate.grant.role,
			reason: quota.reason
		});
	}
	if (matchedAllow === void 0) {
		const decision = freezeDeep({
			outcome: "denied",
			denials: quotaDenials.length > 0 ? quotaDenials : denials,
			alternatives: env.skipAlternatives ? [] : alternativesFor(policy, permission, subject, env)
		});
		finish(policy, subject, permission, current, decision, options, env, trusted);
		return decision;
	}
	const resourceId = permission.kind === "collection" ? "*" : current !== null && typeof current === "object" ? String(current[resource?.id ?? "id"] ?? "*") : "*";
	const token = env.simulated ? "pd1.simulated" : decisionToken({
		key: permission.key,
		resourceId,
		principal: subject.principal,
		actor: subject.actor,
		fingerprint: policy.fingerprint
	});
	const matched = compact({
		role: matchedAllow.grant.role,
		permission: permission.key,
		where: matchedAllow.grant.where,
		check: matchedAllow.grant.check,
		approval: matchedAllow.grant.approval
	});
	const decision = matchedAllow.grant.approval === "human" ? freezeDeep({
		outcome: "approval-required",
		grant: matched,
		reason: "human",
		token
	}) : freezeDeep({
		outcome: "granted",
		subject,
		matched,
		token
	});
	finish(policy, subject, permission, current, decision, options, env, trusted, matchedAllow.membership);
	return decision;
}
function finish(policy, subject, permission, data, decision, options, env, trusted, membership, counts) {
	if (!env.emit) return;
	const resource = getResource(policy.permissions, permission.resource);
	const resourceId = data !== null && typeof data === "object" ? data[resource?.id ?? "id"] : void 0;
	const event = freezeDeep(compact({
		type: "decision",
		at: (/* @__PURE__ */ new Date()).toISOString(),
		outcome: decision.outcome,
		permission: permission.key,
		scope: permission.scope,
		resource: compact({
			type: permission.resource,
			id: resourceId === void 0 ? void 0 : String(resourceId)
		}),
		subject: compact({
			principal: subject.principal === null ? null : compact({
				id: subject.principal.id,
				roles: subject.principal.roles ?? [],
				tenant: subject.principal.tenant
			}),
			actor: subject.actor === void 0 ? void 0 : {
				id: subject.actor.id,
				kind: subject.actor.kind
			},
			delegation: subject.delegation === void 0 ? void 0 : compact({
				scopes: subject.delegation.scopes,
				authorizationDetails: subject.delegation.authorizationDetails
			})
		}),
		tenant: subject.principal?.tenant,
		membership,
		via: membership?.via ?? null,
		matched: decision.outcome === "granted" ? {
			role: decision.matched.role,
			permission: decision.matched.permission
		} : void 0,
		denials: decision.outcome === "denied" ? decision.denials : void 0,
		alternatives: decision.outcome === "denied" ? decision.alternatives.map((leaf) => leaf.key) : void 0,
		token: decision.outcome === "granted" || decision.outcome === "approval-required" ? decision.token : void 0,
		trusted,
		source: options.source ?? "decide",
		adapter: options.adapter,
		counts
	}));
	emitSafe(env.listeners.decision, event, env.listeners);
	if (decision.outcome === "denied") emitSafe(env.listeners.denied, event, env.listeners);
	if (decision.outcome === "approval-required") emitSafe(env.listeners.approval, event, env.listeners);
	if (env.sink !== void 0) try {
		const written = env.sink.write([event]);
		if (isThenable(written)) written.catch((error) => {
			emitSafe(env.listeners.error, error, env.listeners);
		});
	} catch (error) {
		emitSafe(env.listeners.error, error, env.listeners);
	}
}
function includePrefixes(include) {
	if (include === void 0) return;
	return include.map((item) => {
		if ("key" in item && typeof item.key === "string") return item.key;
		const first = listPermissions(item)[0];
		if (first === void 0) return "";
		const parts = first.key.split(".");
		parts.pop();
		return parts.join(".");
	});
}
function heldRoles(subject, tenant) {
	if (subject.principal === null) return [];
	const names = new Set(subject.principal.roles ?? []);
	for (const membership of subject.principal.memberships ?? []) {
		if (tenant !== void 0 && membership.tenant !== tenant) continue;
		for (const role of membership.roles) names.add(role);
	}
	return [...names];
}
function collectSnapshotGrants(policy, subject, customRoles) {
	const declared = new Set(policy.roles.map((role) => role.name));
	const global = expandRoleNames(subject.principal?.roles ?? [], declared, customRoles);
	const out = [];
	for (const role of policy.roles) if (role.grants[0]?.scope === "global" && global.roles.includes(role.name)) for (const grant of role.grants) out.push({ grant });
	for (const membership of subject.principal?.memberships ?? []) {
		const expanded = expandRoleNames(membership.roles, declared, customRoles);
		for (const roleName of expanded.roles) {
			const role = policy.rolesByName.get(roleName);
			if (role === void 0) continue;
			for (const grant of role.grants) {
				if (grant.scope === "global") continue;
				out.push({
					grant,
					membership
				});
			}
		}
	}
	return out;
}
function buildInstance(policy, subject, envBase, team) {
	const listeners = emptyListeners();
	const queuedAuth = [...envBase.queuedAuth];
	const envFor = (emit) => ({
		emit,
		simulated: envBase.simulated,
		skipAlternatives: false,
		customRoles: envBase.customRoles,
		listeners,
		sink: envBase.sink,
		limits: envBase.limits,
		limitCache: envBase.limitCache,
		team
	});
	const decideImpl = (permission, data, options) => evaluate(policy, subject, permission, data, options ?? {}, envFor(options?.source !== "simulate"));
	const canImpl = (permission, data, options) => {
		try {
			return decideImpl(permission, data, {
				...options,
				source: options?.source ?? "can"
			}).outcome === "granted";
		} catch {
			return false;
		}
	};
	const assertImpl = (permission, data, options) => {
		const decision = decideImpl(permission, data, {
			...options,
			source: options?.source ?? "assert"
		});
		if (decision.outcome === "granted") return decision;
		const onDenied = options?.onDenied ?? policy.onDenied;
		if (onDenied !== void 0) onDenied(decision);
		const resource = getResource(policy.permissions, permission.resource);
		const resourceId = data !== null && typeof data === "object" ? data[resource?.id ?? "id"] : void 0;
		const resourceRef = compact({
			type: permission.resource,
			id: resourceId === void 0 ? void 0 : String(resourceId)
		});
		if (decision.outcome === "approval-required") throw new PermDockApprovalRequiredError({
			decision,
			permission: permission.key,
			scope: permission.scope,
			resource: resourceRef,
			message: approvalMessage(permission.key, decision.reason, decision.token)
		});
		if (decision.denials.some((denial) => denial.reason === "validation")) {
			const detail = decision.denials[0]?.detail;
			if (detail instanceof PermDockValidationError) throw detail;
		}
		throw new PermDockDeniedError({
			decision,
			permission: permission.key,
			scope: permission.scope,
			resource: resourceRef,
			subject,
			message: deniedMessage(permission.key, subject.principal?.id, decision.denials, decision.alternatives.map((leaf) => leaf.key))
		});
	};
	return Object.freeze({
		can: canImpl,
		decide: decideImpl,
		assert: assertImpl,
		filter(permission, rows, options) {
			const allowed = [];
			let granted = 0;
			let denied = 0;
			let approvalRequired = 0;
			const quiet = envFor(false);
			const trusted = options?.trusted ?? true;
			const decideOptions = {
				...options,
				source: "filter",
				trusted
			};
			for (const row of rows) {
				const decision = evaluate(policy, subject, permission, row, decideOptions, quiet);
				if (decision.outcome === "granted") {
					allowed.push(row);
					granted += 1;
				} else if (decision.outcome === "approval-required") approvalRequired += 1;
				else denied += 1;
			}
			const summary = granted > 0 ? freezeDeep({
				outcome: "granted",
				subject,
				matched: {
					role: "*",
					permission: permission.key
				},
				token: "pd1.filter"
			}) : freezeDeep({
				outcome: "denied",
				denials: [{
					role: null,
					reason: "no-grant"
				}],
				alternatives: []
			});
			finish(policy, subject, permission, rows[0], summary, decideOptions, {
				...quiet,
				emit: true
			}, trusted, void 0, {
				granted,
				denied,
				approvalRequired
			});
			return allowed;
		},
		pick(permission, row, options) {
			if (row === null || typeof row !== "object") return {};
			if (canImpl(permission, row, options) !== true) return {};
			return pickVisible(row, (field) => {
				const next = compact({
					...options,
					field
				});
				return canImpl(permission, row, next) === true;
			});
		},
		where(permission) {
			const grants = collectSnapshotGrants(policy, subject, envBase.customRoles).filter((item) => item.grant.permission.key === permission.key);
			const allows = grants.filter((item) => item.grant.effect === "allow" && item.grant.portable);
			const denies = grants.filter((item) => item.grant.effect === "deny" && item.grant.portable);
			const partial = grants.some((item) => !item.grant.portable);
			if (allows.length === 0) return {
				condition: {
					op: "or",
					conditions: []
				},
				partial
			};
			const parts = allows.map((item) => {
				let condition = item.grant.where ?? {
					op: "eq",
					field: "_",
					value: true
				};
				for (const denyGrant of denies) if (denyGrant.grant.where !== void 0) condition = {
					op: "and",
					conditions: [condition, {
						op: "not",
						condition: denyGrant.grant.where
					}]
				};
				return condition;
			});
			return {
				condition: parts.length === 1 ? parts[0] : {
					op: "or",
					conditions: parts
				},
				partial
			};
		},
		simulate: ((input) => {
			if (Array.isArray(input)) return input.map(([permission, data]) => evaluate(policy, subject, permission, data, {
				source: "simulate",
				trusted: true
			}, envFor(false)));
			const preview = input;
			const previewPrincipal = subject.principal === null ? null : freezeDeep(compact({
				...subject.principal,
				roles: preview.roles ?? subject.principal.roles,
				memberships: preview.memberships ?? subject.principal.memberships,
				tenant: preview.tenant ?? subject.principal.tenant
			}));
			return buildInstance(policy, freezeDeep({
				...subject,
				principal: previewPrincipal
			}), {
				...envBase,
				simulated: true
			}, team);
		}),
		snapshot(options) {
			const snapshot = buildSnapshot(compact({
				subject,
				roles: heldRoles(subject, subject.principal?.tenant),
				grants: collectSnapshotGrants(policy, subject, envBase.customRoles),
				include: includePrefixes(options?.include),
				tenants: options?.tenants,
				simulated: envBase.simulated
			}));
			if (options?.signer !== void 0) return signSnapshot(snapshot, options.signer, options.audience);
			return snapshot;
		},
		on(event, handler) {
			const set = listeners[event];
			set.add(handler);
			if (event === "auth") for (const queued of queuedAuth) try {
				handler(queued);
			} catch (error) {
				emitSafe(listeners.error, error, listeners);
			}
			return () => {
				set.delete(handler);
			};
		},
		tenant(id) {
			if (subject.principal === null) return buildInstance(policy, subject, envBase, team);
			return buildInstance(policy, freezeDeep(compact({
				...subject,
				principal: compact({
					...subject.principal,
					tenant: resolveActiveTenant(subject.principal, id)
				})
			})), envBase, team);
		},
		team(id) {
			return buildInstance(policy, subject, envBase, id);
		},
		memberships() {
			return subject.principal?.memberships ?? [];
		},
		tenants() {
			return tenantsOf(subject.principal);
		},
		roles(options) {
			return heldRoles(subject, options?.tenant ?? subject.principal?.tenant);
		},
		assignable() {
			const tenant = subject.principal?.tenant;
			const held = new Set(heldRoles(subject, tenant));
			return policy.roles.filter((role) => role.assignable).map((role) => role.name).filter((name) => held.has(name));
		},
		subject
	});
}
function assemblePrincipal(policy, user, options, auth) {
	let principal;
	let context = {};
	let actor = options.actor;
	let delegation = options.delegation;
	let session = options.session;
	let expiresAt = options.expiresAt;
	try {
		if (user === null || user === void 0) principal = policy.subject(user);
		else if (isSubject(user)) {
			principal = user.principal;
			context = user.context;
			actor = user.actor ?? actor;
			delegation = user.delegation ?? delegation;
			session = user.session ?? session;
			expiresAt = user.expiresAt ?? expiresAt;
		} else if (isPrincipal(user)) principal = user;
		else principal = policy.subject(user);
	} catch {
		principal = null;
	}
	const contextResult = resolveContext(policy, user, context, auth);
	let memberships = principal?.memberships ?? [];
	if (principal !== null && options.memberships !== void 0) try {
		memberships = options.memberships.membershipsFor(compact({
			id: principal.id,
			kind: principal.kind
		}), compact({ tenant: options.tenant }));
	} catch {
		auth.push({
			reason: "source-threw",
			source: "memberships"
		});
		memberships = [];
	}
	return {
		principal,
		context: contextResult,
		actor,
		delegation,
		session,
		expiresAt,
		memberships
	};
}
function finishSubject(assembled, context, memberships, options) {
	if (assembled.principal === null) return freezeDeep(compact({
		...anonymousSubject(context),
		actor: assembled.actor,
		delegation: assembled.delegation,
		session: assembled.session,
		expiresAt: assembled.expiresAt
	}));
	const withMemberships = freezeDeep(compact({
		...assembled.principal,
		memberships,
		tenant: resolveActiveTenant({
			...assembled.principal,
			memberships
		}, options.tenant ?? assembled.principal.tenant)
	}));
	return freezeDeep(compact({
		principal: withMemberships,
		actor: assembled.actor,
		delegation: assembled.delegation,
		context: freezeDeep({ ...context }),
		session: assembled.session,
		expiresAt: assembled.expiresAt
	}));
}
function resolveContext(policy, user, fallback, auth) {
	if (policy.context === void 0) return sanitizeContext(fallback);
	try {
		const loaded = policy.context(user);
		if (isThenable(loaded)) return loaded.then((value) => sanitizeContext(value), () => {
			auth.push({
				reason: "source-threw",
				source: "context"
			});
			return {};
		});
		return sanitizeContext(loaded);
	} catch {
		auth.push({
			reason: "source-threw",
			source: "context"
		});
		return {};
	}
}
function resolveSubject(policy, user, options, auth) {
	const assembled = assemblePrincipal(policy, user, options, auth);
	if (isThenable(assembled.context) || isThenable(assembled.memberships)) return Promise.all([Promise.resolve(assembled.context), Promise.resolve(assembled.memberships).catch(() => {
		auth.push({
			reason: "source-threw",
			source: "memberships"
		});
		return [];
	})]).then(([context, memberships]) => finishSubject(assembled, context, memberships, options));
	return finishSubject(assembled, assembled.context, assembled.memberships, options);
}
function instantiate(policy, subject, options, auth) {
	const tenants = tenantsOf(subject.principal);
	const customRoles = customRolesFor(options.customRoles, tenants, auth);
	const build = (roles) => buildInstance(policy, subject, {
		customRoles: roles,
		sink: options.sink,
		limits: options.limits,
		limitCache: /* @__PURE__ */ new Map(),
		simulated: false,
		roleSource: options.customRoles,
		queuedAuth: auth
	});
	if (isThenable(customRoles)) return customRoles.then(build);
	return build(customRoles);
}
function createPermDock(policy, user, options = {}) {
	const auth = [];
	const subject = resolveSubject(policy, user, options, auth);
	if (isThenable(subject)) return subject.then((resolved) => instantiate(policy, resolved, options, auth));
	return instantiate(policy, subject, options, auth);
}
//#endregion
export { memoryLimitStore as n, createPermDock as t };
