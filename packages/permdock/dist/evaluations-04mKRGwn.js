import { t as compact } from "./compact-CxSqQNw0.js";
import { a as deniedMessage, i as approvalMessage, n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "./errors-DDT8tC4N.js";
import { n as findPermission, o as listPermissions } from "./permissions-WEkUHQtZ.js";
import { a as resumeFromHeader, n as readApprovalHeader, r as requestApproval } from "./helpers-Ce24VOuf.js";
//#region src/server/problem.ts
const PROBLEM_BASE = "https://permdock.dev/problems";
function quoted(value) {
	return `"${value.replaceAll(/["\\]/gu, "")}"`;
}
function wwwAuthenticate(decision, permission) {
	if (decision.outcome !== "denied") return;
	const reasons = new Set(decision.denials.map((denial) => denial.reason));
	if (reasons.has("insufficient-user-authentication")) return "Bearer error=\"insufficient_user_authentication\"";
	if (reasons.has("anonymous")) return "Bearer error=\"invalid_token\"";
	if (reasons.has("not-delegated") || reasons.has("no-delegation")) {
		const scope = permission?.scope;
		if (scope === void 0) return "Bearer error=\"insufficient_scope\"";
		return `Bearer error="insufficient_scope", scope=${quoted(scope)}`;
	}
}
function problemResponse(details, permission, decision) {
	const headers = new Headers({ "content-type": "application/problem+json" });
	if (decision !== void 0) {
		const challenge = wwwAuthenticate(decision, permission);
		if (challenge !== void 0) headers.set("WWW-Authenticate", challenge);
	}
	return new Response(JSON.stringify(details), {
		status: details.status,
		headers
	});
}
function validationProblem(detail) {
	return problemResponse(compact({
		type: `${PROBLEM_BASE}/validation`,
		title: "Invalid request",
		status: 400,
		detail
	}));
}
function resourceRef$1(permission, data) {
	const id = data !== null && typeof data === "object" && "id" in data ? data.id : void 0;
	return compact({
		type: permission.resource,
		id: typeof id === "string" || typeof id === "number" ? String(id) : void 0
	});
}
function problemFromDecision(decision, permission, subject, options = {}) {
	const base = options.base ?? "https://permdock.dev/problems";
	if (decision.outcome === "granted") return new Response(null, { status: 204 });
	if (decision.outcome === "approval-required") return problemResponse({
		...new PermDockApprovalRequiredError({
			decision,
			permission: permission.key,
			scope: permission.scope,
			resource: resourceRef$1(permission, void 0),
			message: approvalMessage(permission.key, decision.reason, decision.token)
		}).toProblemDetails(compact({ instance: options.instance })),
		type: `${base}/approval-required`
	}, permission, decision);
	const reasons = new Set(decision.denials.map((denial) => denial.reason));
	if (decision.denials.some((denial) => denial.detail instanceof PermDockValidationError)) {
		const validation = decision.denials[0]?.detail;
		if (validation instanceof PermDockValidationError) return problemResponse(validation.toProblemDetails(), permission, decision);
	}
	const details = new PermDockDeniedError({
		decision,
		permission: permission.key,
		scope: permission.scope,
		resource: resourceRef$1(permission, void 0),
		subject,
		message: deniedMessage(permission.key, subject.principal?.id, decision.denials, decision.alternatives.map((leaf) => leaf.key))
	}).toProblemDetails(compact({ instance: options.instance }));
	let status = details.status;
	let type = `${base}/denied`;
	if (reasons.has("anonymous")) {
		status = 401;
		type = `${base}/unauthenticated`;
	} else if (reasons.has("insufficient-user-authentication")) {
		status = 401;
		type = `${base}/step-up-required`;
	}
	return problemResponse({
		...details,
		status,
		type
	}, permission, decision);
}
//#endregion
//#region src/server/web-bot-auth.ts
const DEFAULT_MAX_AGE = 300;
const FUTURE_SKEW = 60;
const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
var InvalidSignatureError = class extends Error {
	name = "InvalidSignatureError";
	response;
	constructor(response) {
		super("Web Bot Auth signature was rejected");
		this.response = response;
	}
};
function invalidSignatureResponse(error) {
	return error instanceof InvalidSignatureError ? error.response : void 0;
}
function invalidSignatureProblem(detail, base) {
	return problemResponse(compact({
		type: `${base ?? "https://permdock.dev/problems"}/invalid-signature`,
		title: "Invalid signature",
		status: 403,
		detail
	}));
}
function discoverViaSignatureAgent(options) {
	const fetchFn = options.fetch ?? fetch;
	const allow = new Set(options.allow);
	const cache = /* @__PURE__ */ new Map();
	const lookup = async ({ keyid, agent }) => {
		if (agent === void 0) return;
		let url;
		try {
			url = new URL(agent);
		} catch {
			return;
		}
		if (url.protocol !== "https:" || !allow.has(url.hostname)) return;
		const directoryUrl = url.pathname === "/" || url.pathname === "" ? `${url.origin}${DIRECTORY_PATH}` : agent;
		let pending = cache.get(directoryUrl);
		if (pending === void 0) {
			pending = loadDirectory(fetchFn, directoryUrl);
			cache.set(directoryUrl, pending);
		}
		let keys;
		try {
			keys = await pending;
		} catch {
			cache.delete(directoryUrl);
			return;
		}
		return keys.find((key) => key.kid === keyid);
	};
	return { lookup };
}
async function verifyWebBotAuth(request, options, problemBase) {
	if (options === void 0 || options.verify === false) return;
	const signatureInput = request.headers.get("Signature-Input");
	if (signatureInput === null) {
		if (options.required === true) throw new InvalidSignatureError(invalidSignatureProblem("Signature-Input is required", problemBase));
		return;
	}
	const parsed = parseSignatureInput(signatureInput);
	const signatureHeader = request.headers.get("Signature");
	if (parsed === void 0 || signatureHeader === null) throw reject(problemBase, "Signature-Input could not be parsed");
	const signature = parseSignature(signatureHeader, parsed.label);
	if (signature === void 0) throw reject(problemBase, "Signature could not be parsed");
	const now = Math.floor(Date.now() / 1e3);
	const maxAge = options.maxAge ?? DEFAULT_MAX_AGE;
	if (typeof parsed.created !== "number") throw reject(problemBase, "Signature-Input created is required");
	if (parsed.created > now + FUTURE_SKEW) throw reject(problemBase, "Signature-Input created is in the future");
	if (now - parsed.created > maxAge) throw reject(problemBase, "Signature-Input created is too old");
	if (typeof parsed.expires === "number" && parsed.expires < now) throw reject(problemBase, "Signature-Input expires is in the past");
	if (parsed.keyid === void 0) throw reject(problemBase, "Signature-Input keyid is required");
	const agent = parseSignatureAgent(request.headers.get("Signature-Agent"), parsed.label);
	const lookup = typeof options.keys === "function" ? options.keys : options.keys.lookup;
	let key;
	try {
		key = await lookup({
			request,
			keyid: parsed.keyid,
			agent
		});
	} catch {
		throw reject(problemBase, "Web Bot Auth key lookup failed");
	}
	if (key === void 0) throw reject(problemBase, "Web Bot Auth key was not found");
	const base = signatureBase(request, parsed);
	if (base === void 0) throw reject(problemBase, "signed components could not be covered");
	const alg = parsed.alg ?? algorithmFromJwk(key);
	if (alg === void 0) throw reject(problemBase, "signature algorithm is not supported");
	if (!await verifyBytes(key, alg, signature, base)) throw reject(problemBase, "HTTP Message Signature did not verify");
	return Object.freeze({
		id: parsed.keyid,
		kind: "web-bot-auth"
	});
}
function reject(base, detail) {
	return new InvalidSignatureError(invalidSignatureProblem(detail, base));
}
function parseSignatureInput(header) {
	const member = firstDictionaryMember(header);
	if (member === void 0) return;
	const inner = parseInnerListAndParams(member.value);
	if (inner === void 0) return;
	return compact({
		label: member.key,
		components: inner.components,
		created: inner.created,
		expires: inner.expires,
		keyid: inner.keyid,
		alg: inner.alg,
		innerListAndParams: member.value.trim()
	});
}
function parseSignature(header, label) {
	const member = dictionaryMember(header, label);
	if (member === void 0) return;
	return decodeSfBytes(member);
}
function parseSignatureAgent(header, label) {
	if (header === null) return;
	const trimmed = header.trim();
	if (trimmed.startsWith("\"")) return unquote(trimmed);
	const member = dictionaryMember(trimmed, label) ?? firstDictionaryMember(trimmed)?.value;
	if (member === void 0) return;
	return unquote(member.trim());
}
function firstDictionaryMember(header) {
	const first = splitTopLevel(header, ",")[0];
	if (first === void 0) return;
	const eq = first.indexOf("=");
	if (eq <= 0) return;
	return {
		key: first.slice(0, eq).trim(),
		value: first.slice(eq + 1)
	};
}
function dictionaryMember(header, label) {
	for (const part of splitTopLevel(header, ",")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		if (part.slice(0, eq).trim() === label) return part.slice(eq + 1);
	}
}
function parseInnerListAndParams(value) {
	const trimmed = value.trim();
	if (!trimmed.startsWith("(")) return;
	const close = trimmed.indexOf(")");
	if (close < 0) return;
	const components = parseQuotedList(trimmed.slice(1, close));
	if (components === void 0) return;
	const params = parseParams(trimmed.slice(close + 1));
	return compact({
		components,
		created: asUnix(params.created),
		expires: asUnix(params.expires),
		keyid: typeof params.keyid === "string" ? params.keyid : void 0,
		alg: typeof params.alg === "string" ? params.alg : void 0
	});
}
function parseQuotedList(inner) {
	const items = [];
	const parts = splitTopLevel(inner, " ");
	for (const part of parts) {
		const next = part.trim();
		if (next === "") continue;
		if (!next.startsWith("\"") || !next.endsWith("\"")) return;
		const item = unquote(next);
		if (item === void 0) return;
		items.push(item);
	}
	return items;
}
function parseParams(suffix) {
	const params = {};
	for (const part of suffix.split(";")) {
		const next = part.trim();
		if (next === "") continue;
		const eq = next.indexOf("=");
		if (eq <= 0) continue;
		const name = next.slice(0, eq);
		const raw = next.slice(eq + 1);
		if (raw.startsWith("\"")) {
			const quoted = unquote(raw);
			if (quoted !== void 0) params[name] = quoted;
			continue;
		}
		const numeric = Number(raw);
		params[name] = Number.isFinite(numeric) ? numeric : raw;
	}
	return params;
}
function asUnix(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function signatureBase(request, parsed) {
	const lines = [];
	for (const component of parsed.components) {
		const value = componentValue(request, component);
		if (value === void 0) return;
		lines.push(`"${component}": ${value}`);
	}
	lines.push(`"@signature-params": ${parsed.innerListAndParams}`);
	return new TextEncoder().encode(lines.join("\n"));
}
function componentValue(request, component) {
	if (component.startsWith("@")) {
		const url = new URL(request.url);
		switch (component) {
			case "@method": return request.method;
			case "@authority": return url.host;
			case "@path": return url.pathname;
			case "@query": return url.search;
			case "@target-uri": return url.href;
			case "@scheme": return url.protocol.replace(":", "");
			case "@request-target": return `${url.pathname}${url.search}`;
			default: return;
		}
	}
	return request.headers.get(component) ?? void 0;
}
function algorithmFromJwk(key) {
	if (key.kty === "OKP" && key.crv === "Ed25519") return "ed25519";
	if (key.kty === "EC" && key.crv === "P-256") return "ecdsa-p256-sha256";
}
async function verifyBytes(key, alg, signature, data) {
	try {
		if (alg === "ed25519") {
			const cryptoKey = await crypto.subtle.importKey("jwk", key, "Ed25519", false, ["verify"]);
			return await crypto.subtle.verify("Ed25519", cryptoKey, signature, data);
		}
		if (alg === "ecdsa-p256-sha256") {
			const cryptoKey = await crypto.subtle.importKey("jwk", key, {
				name: "ECDSA",
				namedCurve: "P-256"
			}, false, ["verify"]);
			return await crypto.subtle.verify({
				name: "ECDSA",
				hash: "SHA-256"
			}, cryptoKey, signature, data);
		}
		return false;
	} catch {
		return false;
	}
}
async function loadDirectory(fetchFn, directoryUrl) {
	const response = await fetchFn(directoryUrl, { headers: { accept: "application/http-message-signatures-directory+json, application/json" } });
	if (!response.ok) throw new TypeError("directory fetch failed");
	const body = await response.json();
	if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
	const keys = body.keys;
	if (!Array.isArray(keys)) return [];
	return keys.filter(isWebBotAuthJwk);
}
function isWebBotAuthJwk(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function splitTopLevel(input, separator) {
	const parts = [];
	let current = "";
	let quotes = false;
	let depth = 0;
	for (const char of input) {
		if (char === "\"" && depth === 0) {
			quotes = !quotes;
			current += char;
			continue;
		}
		if (!quotes && char === "(") {
			depth += 1;
			current += char;
			continue;
		}
		if (!quotes && char === ")" && depth > 0) {
			depth -= 1;
			current += char;
			continue;
		}
		if (!quotes && depth === 0 && char === separator) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current !== "") parts.push(current);
	return parts;
}
function unquote(value) {
	if (!value.startsWith("\"")) return value;
	if (!value.endsWith("\"") || value.length < 2) return;
	return value.slice(1, -1).replaceAll("\\\"", "\"");
}
function decodeSfBytes(value) {
	const trimmed = value.trim();
	if (!trimmed.startsWith(":") || !trimmed.endsWith(":") || trimmed.length < 2) return;
	try {
		const binary = atob(trimmed.slice(1, -1));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.codePointAt(index) ?? 0;
		return bytes;
	} catch {
		return;
	}
}
//#endregion
//#region src/server/evaluations.ts
const DENIED = {
	outcome: "denied",
	denials: [{
		role: null,
		reason: "no-grant"
	}],
	alternatives: []
};
function permissionOf(tree, item) {
	const action = typeof item.action?.name === "string" ? item.action.name : void 0;
	if (action === void 0) return;
	const byKey = findPermission(tree, action);
	if (byKey !== void 0) return byKey;
	const resource = typeof item.resource?.type === "string" ? item.resource.type : void 0;
	if (resource === void 0) return;
	const dotted = findPermission(tree, `${resource}.${action}`);
	if (dotted !== void 0) return dotted;
	return listPermissions(tree).find((leaf) => leaf.resource === resource && leaf.action === action);
}
function resourceData(item) {
	const properties = item.resource?.properties;
	if (properties !== null && typeof properties === "object") return properties;
	const id = item.resource?.id;
	if (typeof id === "string" || typeof id === "number") return { id: String(id) };
}
function resourceRef(permission, item, data) {
	const fromRow = data !== null && typeof data === "object" && "id" in data ? data.id : void 0;
	const fromWire = item.resource?.id;
	const id = typeof fromRow === "string" || typeof fromRow === "number" ? String(fromRow) : typeof fromWire === "string" || typeof fromWire === "number" ? String(fromWire) : void 0;
	return compact({
		type: permission.resource,
		id
	});
}
function evaluationRow(decision) {
	switch (decision.outcome) {
		case "granted": return {
			decision: true,
			context: {
				outcome: "granted",
				permdock: decision
			}
		};
		case "denied": return {
			decision: false,
			context: {
				outcome: "denied",
				permdock: decision
			}
		};
		case "approval-required": return {
			decision: false,
			context: {
				outcome: "approval-required",
				permdock: decision
			}
		};
		default: return decision;
	}
}
function approvalDenied(detail) {
	return {
		outcome: "denied",
		denials: [{
			role: null,
			reason: "approval",
			detail
		}],
		alternatives: []
	};
}
function resumeMatches(inspected, permission, ref, decision) {
	if (inspected.request.token !== decision.token) return false;
	if (inspected.request.permission !== permission.key) return false;
	if (inspected.request.resource.id !== void 0 && inspected.request.resource.id !== ref.id) return false;
	return true;
}
async function applyApprovalResume(decision, permission, dock, store, request, resource, adapter) {
	if (readApprovalHeader(request.headers) === void 0) {
		if (decision.outcome === "approval-required" && store !== void 0) await requestApproval(store, decision, compact({
			permission,
			resource,
			subject: dock.subject,
			adapter
		}));
		return decision;
	}
	const inspected = store === void 0 ? void 0 : await resumeFromHeader(store, request.headers);
	if (store === void 0 || inspected === void 0 || !inspected.ok) return approvalDenied(inspected !== void 0 && !inspected.ok ? inspected.detail : "approval-not-found");
	if (decision.outcome === "granted" || decision.outcome === "denied") return decision;
	if (!resumeMatches(inspected, permission, resource, decision)) return approvalDenied("approval-mismatch");
	const principal = dock.subject.principal;
	if (principal === null) return approvalDenied("approval-mismatch");
	return {
		outcome: "granted",
		subject: {
			...dock.subject,
			principal
		},
		matched: decision.grant,
		token: decision.token
	};
}
async function applyResume(decision, permission, item, data, dock, store, inspected, header, adapter) {
	if (header === void 0) {
		if (decision.outcome === "approval-required" && store !== void 0) await requestApproval(store, decision, compact({
			permission,
			resource: resourceRef(permission, item, data),
			subject: dock.subject,
			adapter
		}));
		return decision;
	}
	if (store === void 0 || inspected === void 0 || !inspected.ok) return approvalDenied(inspected !== void 0 && !inspected.ok ? inspected.detail : "approval-not-found");
	if (decision.outcome === "granted" || decision.outcome === "denied") return decision;
	if (!resumeMatches(inspected, permission, resourceRef(permission, item, data), decision)) return approvalDenied("approval-mismatch");
	const principal = dock.subject.principal;
	if (principal === null) return approvalDenied("approval-mismatch");
	return {
		outcome: "granted",
		subject: {
			...dock.subject,
			principal
		},
		matched: decision.grant,
		token: decision.token
	};
}
function evaluateOne(policy, dock, item, store, inspected, header, adapter) {
	const permission = permissionOf(policy.permissions, item);
	if (permission === void 0) return Promise.resolve(DENIED);
	const data = resourceData(item);
	const decide = dock.decide;
	return applyResume(decide(permission, data, compact({
		source: "endpoint",
		adapter
	})), permission, item, data, dock, store, inspected, header, adapter);
}
async function resolveDock(options, request, tenant) {
	if (options.resolve !== void 0) {
		const dock = await options.resolve(request);
		return tenant === void 0 ? dock : dock.tenant(tenant);
	}
	if (options.getPermDock !== void 0) return options.getPermDock(tenant === void 0 ? void 0 : { tenant });
	throw new TypeError("evaluations handler needs resolve or getPermDock");
}
function createEvaluationsHandler(options) {
	const adapter = options.adapter ?? "server";
	const POST = async (request) => {
		let body;
		try {
			body = await request.json();
		} catch {
			return validationProblem("evaluations body was not valid JSON");
		}
		if (body === null || typeof body !== "object" || Array.isArray(body)) return validationProblem("evaluations body must be an object");
		const evaluations = body.evaluations;
		if (evaluations === void 0) return validationProblem("evaluations array is required");
		if (!Array.isArray(evaluations)) return validationProblem("evaluations must be an array");
		const header = readApprovalHeader(request.headers);
		const inspected = header === void 0 || options.store === void 0 ? void 0 : await resumeFromHeader(options.store, request.headers);
		let dock;
		try {
			dock = await resolveDock(options, request);
		} catch (error) {
			if (error instanceof InvalidSignatureError) return error.response;
			throw error;
		}
		const rows = await Promise.all(evaluations.map(async (item) => {
			const entry = item !== null && typeof item === "object" ? item : {};
			return evaluationRow(await evaluateOne(options.policy, dock, entry, options.store, inspected, header, adapter));
		}));
		return Response.json({ evaluations: rows });
	};
	const GET = async (request) => {
		const url = new URL(request.url);
		if (url.pathname.includes("authzen-configuration")) {
			const origin = url.origin;
			return Response.json({
				policy_decision_point: origin,
				access_evaluation_endpoint: `${origin}/access/v1/evaluation`,
				access_evaluations_endpoint: `${origin}/access/v1/evaluations`
			});
		}
		const tenant = url.searchParams.get("tenant") ?? void 0;
		let dock;
		try {
			dock = await resolveDock(options, request, tenant);
		} catch (error) {
			if (error instanceof InvalidSignatureError) return error.response;
			throw error;
		}
		const snapshot = dock.snapshot();
		return Response.json(await Promise.resolve(snapshot));
	};
	return {
		POST,
		GET
	};
}
//#endregion
export { invalidSignatureProblem as a, PROBLEM_BASE as c, validationProblem as d, wwwAuthenticate as f, discoverViaSignatureAgent as i, problemFromDecision as l, createEvaluationsHandler as n, invalidSignatureResponse as o, InvalidSignatureError as r, verifyWebBotAuth as s, applyApprovalResume as t, problemResponse as u };
