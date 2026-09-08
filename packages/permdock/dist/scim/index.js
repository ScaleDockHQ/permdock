import { t as freezeDeep } from "../freeze-BF4IK5al.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { n as sha256 } from "../sha256-CeSpVRME.js";
import { t as memorySink } from "../sink-CSxZb96b.js";
//#region src/scim/auth.ts
function hexToBytes(hex) {
	if (hex.length % 2 !== 0) return;
	const out = new Uint8Array(hex.length / 2);
	for (let index = 0; index < out.length; index += 1) {
		const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
		if (Number.isNaN(byte)) return;
		out[index] = byte;
	}
	return out;
}
function timingSafeEqual(left, right) {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let index = 0; index < left.length; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
	return diff === 0;
}
function bearerToken(request) {
	const header = request.headers.get("authorization");
	if (header === null) return;
	return /^Bearer\s+(\S+)$/iu.exec(header)?.[1];
}
async function matchStaticToken(tenant, token, options) {
	const expected = hexToBytes(await options.lookup(tenant) ?? "");
	const actual = sha256(token);
	if (expected === void 0) {
		timingSafeEqual(actual, actual);
		return false;
	}
	return timingSafeEqual(actual, expected);
}
function tenantClaim(claims) {
	if (typeof claims.tenant === "string" && claims.tenant !== "") return claims.tenant;
	if (typeof claims.tid === "string" && claims.tid !== "") return claims.tid;
}
async function authenticateScim(input) {
	const bearer = bearerToken(input.request);
	if (bearer === void 0) return {
		ok: false,
		status: 401
	};
	if (input.token !== void 0) {
		if (await matchStaticToken(input.tenant, bearer, input.token)) return {
			ok: true,
			credential: { kind: "token" }
		};
	}
	if (input.verifier === void 0) return {
		ok: false,
		status: 401
	};
	const verified = await input.verifier.verify(bearer, { audience: input.audience });
	if (!verified.ok) return {
		ok: false,
		status: 401
	};
	if (tenantClaim(verified.claims) !== input.tenant) return {
		ok: false,
		status: 403
	};
	return {
		ok: true,
		credential: compact({
			kind: "jwt",
			iss: typeof verified.claims.iss === "string" ? verified.claims.iss : void 0
		})
	};
}
function sha256Hex(value) {
	const bytes = sha256(value);
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}
//#endregion
//#region src/scim/types.ts
const SCIM_CONTENT_TYPE = "application/scim+json";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ROLES_EXTENSION = "urn:permdock:scim:schemas:extension:roles:1.0";
var DirectoryUniquenessError = class extends Error {
	name = "DirectoryUniquenessError";
	code = "uniqueness";
	constructor(message = "uniqueness") {
		super(message);
	}
};
var DirectoryNotFoundError = class extends Error {
	name = "DirectoryNotFoundError";
	code = "not-found";
	constructor(message = "not found") {
		super(message);
	}
};
function isDirectoryUniquenessError(error) {
	return error instanceof DirectoryUniquenessError;
}
function isDirectoryNotFoundError(error) {
	return error instanceof DirectoryNotFoundError;
}
//#endregion
//#region src/scim/discovery.ts
function serviceProviderConfig() {
	return {
		schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
		patch: { supported: true },
		bulk: {
			supported: false,
			maxOperations: 0,
			maxPayloadSize: 0
		},
		filter: {
			supported: true,
			maxResults: 200
		},
		changePassword: { supported: false },
		sort: { supported: false },
		etag: { supported: false },
		pagination: {
			cursor: true,
			index: true
		},
		authenticationSchemes: [{
			type: "oauthbearertoken",
			name: "OAuth Bearer Token",
			description: "Static bearer or RFC 7523 JWT bearer bound to the tenant.",
			specUri: "https://www.rfc-editor.org/rfc/rfc6750.html",
			primary: true
		}]
	};
}
function resourceTypes() {
	return [{
		schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
		id: "User",
		name: "User",
		endpoint: "/Users",
		schema: USER_SCHEMA,
		schemaExtensions: []
	}, {
		schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
		id: "Group",
		name: "Group",
		endpoint: "/Groups",
		schema: GROUP_SCHEMA,
		schemaExtensions: [{
			schema: ROLES_EXTENSION,
			required: false
		}]
	}];
}
function schemas() {
	return [
		{
			id: USER_SCHEMA,
			name: "User",
			attributes: [
				{
					name: "userName",
					type: "string",
					required: true,
					uniqueness: "server"
				},
				{
					name: "externalId",
					type: "string",
					uniqueness: "server"
				},
				{
					name: "active",
					type: "boolean"
				},
				{
					name: "emails",
					type: "complex",
					multiValued: true,
					subAttributes: [
						{
							name: "value",
							type: "string"
						},
						{
							name: "primary",
							type: "boolean"
						},
						{
							name: "type",
							type: "string"
						}
					]
				}
			]
		},
		{
			id: GROUP_SCHEMA,
			name: "Group",
			attributes: [
				{
					name: "displayName",
					type: "string",
					required: true
				},
				{
					name: "externalId",
					type: "string",
					uniqueness: "server"
				},
				{
					name: "members",
					type: "complex",
					multiValued: true,
					subAttributes: [{
						name: "value",
						type: "string"
					}]
				}
			]
		},
		{
			id: ROLES_EXTENSION,
			name: "PermDockRoles",
			attributes: [{
				name: "roles",
				type: "string",
				multiValued: true
			}]
		}
	];
}
//#endregion
//#region src/scim/filter.ts
const COMPARE = /* @__PURE__ */ new Set([
	"eq",
	"ne",
	"co",
	"sw"
]);
function skipSpace(input, index) {
	let cursor = index;
	while (cursor < input.length && input[cursor] === " ") cursor += 1;
	return cursor;
}
function readIdent(input, index) {
	const start = skipSpace(input, index);
	if (!/[A-Za-z]/u.test(input[start] ?? "")) return;
	let cursor = start;
	while (cursor < input.length && /[A-Za-z0-9._]/u.test(input[cursor] ?? "")) cursor += 1;
	return {
		value: input.slice(start, cursor),
		next: cursor
	};
}
function readString(input, index) {
	const start = skipSpace(input, index);
	if (input[start] !== "\"") return;
	let cursor = start + 1;
	let value = "";
	while (cursor < input.length) {
		const char = input[cursor];
		if (char === "\\") {
			value += input[cursor + 1] ?? "";
			cursor += 2;
			continue;
		}
		if (char === "\"") return {
			value,
			next: cursor + 1
		};
		value += char;
		cursor += 1;
	}
}
function readLiteral(input, index) {
	const quoted = readString(input, index);
	if (quoted !== void 0) return quoted;
	const ident = readIdent(input, index);
	if (ident === void 0) return;
	if (ident.value.toLowerCase() === "true") return {
		value: true,
		next: ident.next
	};
	if (ident.value.toLowerCase() === "false") return {
		value: false,
		next: ident.next
	};
	return {
		value: ident.value,
		next: ident.next
	};
}
function parsePrimary(input, index) {
	const start = skipSpace(input, index);
	if (input[start] === "(") {
		const inner = parseOr(input, start + 1);
		if (inner === void 0) return;
		const close = skipSpace(input, inner.next);
		if (input[close] !== ")") return;
		return {
			filter: inner.filter,
			next: close + 1
		};
	}
	const attribute = readIdent(input, start);
	if (attribute === void 0) return;
	const opToken = readIdent(input, attribute.next);
	if (opToken === void 0) return;
	const op = opToken.value.toLowerCase();
	if (op === "pr") return {
		filter: {
			op: "pr",
			attribute: attribute.value
		},
		next: opToken.next
	};
	if (!COMPARE.has(op)) return;
	const value = readLiteral(input, opToken.next);
	if (value === void 0) return;
	return {
		filter: {
			op,
			attribute: attribute.value,
			value: value.value
		},
		next: value.next
	};
}
function parseAnd(input, index) {
	const first = parsePrimary(input, index);
	if (first === void 0) return;
	const filters = [first.filter];
	let cursor = first.next;
	for (;;) {
		const nextOp = readIdent(input, cursor);
		if (nextOp === void 0 || nextOp.value.toLowerCase() !== "and") break;
		const next = parsePrimary(input, nextOp.next);
		if (next === void 0) return;
		filters.push(next.filter);
		cursor = next.next;
	}
	if (filters.length === 1) return {
		filter: first.filter,
		next: cursor
	};
	return {
		filter: {
			op: "and",
			filters
		},
		next: cursor
	};
}
function parseOr(input, index) {
	const first = parseAnd(input, index);
	if (first === void 0) return;
	const filters = [first.filter];
	let cursor = first.next;
	for (;;) {
		const nextOp = readIdent(input, cursor);
		if (nextOp === void 0 || nextOp.value.toLowerCase() !== "or") break;
		const next = parseAnd(input, nextOp.next);
		if (next === void 0) return;
		filters.push(next.filter);
		cursor = next.next;
	}
	if (filters.length === 1) return {
		filter: first.filter,
		next: cursor
	};
	return {
		filter: {
			op: "or",
			filters
		},
		next: cursor
	};
}
function parseScimFilter(input) {
	const trimmed = input.trim();
	if (trimmed === "") return;
	const parsed = parseOr(trimmed, 0);
	if (parsed === void 0) return;
	if (skipSpace(trimmed, parsed.next) !== trimmed.length) return;
	return parsed.filter;
}
function readAttribute(target, attribute) {
	if (attribute === "members.value") {
		const members = target.members;
		if (!Array.isArray(members)) return;
		return members.map((member) => {
			if (member !== null && typeof member === "object" && "value" in member) return member.value;
		});
	}
	const parts = attribute.split(".");
	let current = target;
	for (const part of parts) {
		if (current === null || typeof current !== "object") return;
		current = current[part];
	}
	return current;
}
function asString(value) {
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}
function matchCompare(actual, op, expected) {
	if (Array.isArray(actual)) return actual.some((item) => matchCompare(item, op, expected));
	if (actual === void 0 || actual === null) return op === "ne";
	if (typeof expected === "boolean" || typeof actual === "boolean") {
		const left = asString(actual).toLowerCase();
		const right = asString(expected).toLowerCase();
		return op === "eq" ? left === right : op === "ne" ? left !== right : false;
	}
	const left = asString(actual);
	const right = asString(expected);
	switch (op) {
		case "eq": return left === right;
		case "ne": return left !== right;
		case "co": return left.includes(right);
		case "sw": return left.startsWith(right);
		default: return op;
	}
}
function matchFilter(target, filter) {
	if (filter === void 0) return true;
	const record = target;
	switch (filter.op) {
		case "and": return filter.filters.every((item) => matchFilter(target, item));
		case "or": return filter.filters.some((item) => matchFilter(target, item));
		case "pr": return readAttribute(record, filter.attribute) !== void 0;
		case "eq":
		case "ne":
		case "co":
		case "sw": return matchCompare(readAttribute(record, filter.attribute), filter.op, filter.value);
		default: return filter;
	}
}
const SUPPORTED_FILTER_ATTRIBUTES = /* @__PURE__ */ new Set([
	"id",
	"userName",
	"externalId",
	"active",
	"displayName",
	"members.value"
]);
function filterSupported(filter) {
	switch (filter.op) {
		case "and":
		case "or": return filter.filters.every(filterSupported);
		case "pr":
		case "eq":
		case "ne":
		case "co":
		case "sw": return SUPPORTED_FILTER_ATTRIBUTES.has(filter.attribute);
		default: return filter;
	}
}
//#endregion
//#region src/scim/patch.ts
const FILTER_PATH = /^(?<attribute>[A-Za-z0-9._]+)\[(?<field>[A-Za-z0-9._]+)\s+eq\s+"(?<value>[^"]+)"\](?<rest>\.[A-Za-z0-9._]+)?$/u;
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function coerceActive(value) {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const lower = value.toLowerCase();
		if (lower === "true") return true;
		if (lower === "false") return false;
	}
}
function rolesPath(path) {
	return path === "roles" || path === `urn:permdock:scim:schemas:extension:roles:1.0:roles` || path === `urn:permdock:scim:schemas:extension:roles:1.0.roles`;
}
function opName(value) {
	if (typeof value !== "string") return;
	const lower = value.toLowerCase();
	if (lower === "add" || lower === "replace" || lower === "remove") return lower;
}
function normalizePatchOps(ops) {
	const next = [];
	for (const raw of ops) {
		if (!isRecord$1(raw)) return;
		const op = opName(raw.op);
		if (op === void 0) return;
		const path = typeof raw.path === "string" ? raw.path : void 0;
		if (path === void 0) {
			if (!isRecord$1(raw.value)) {
				next.push({
					op,
					value: raw.value
				});
				continue;
			}
			for (const [key, value] of Object.entries(raw.value)) {
				if (key === "urn:permdock:scim:schemas:extension:roles:1.0" && isRecord$1(value)) {
					next.push({
						op,
						path: "roles",
						value: value.roles
					});
					continue;
				}
				if (key === "active") {
					next.push({
						op,
						path: "active",
						value: coerceActive(value) ?? value
					});
					continue;
				}
				next.push({
					op,
					path: key,
					value
				});
			}
			continue;
		}
		if (rolesPath(path)) {
			const roles = isRecord$1(raw.value) ? raw.value.roles : raw.value;
			next.push({
				op,
				path: "roles",
				value: roles
			});
			continue;
		}
		const filtered = FILTER_PATH.exec(path);
		if (filtered?.groups !== void 0) {
			const attribute = filtered.groups.attribute;
			const field = filtered.groups.field;
			const value = filtered.groups.value;
			if (attribute === void 0 || field === void 0 || value === void 0) return;
			if (op === "remove") {
				next.push({
					op,
					path: attribute,
					value: [{ [field]: value }]
				});
				continue;
			}
			next.push({
				op,
				path: attribute,
				value: raw.value ?? [{ [field]: value }]
			});
			continue;
		}
		if (path === "active") {
			next.push({
				op,
				path,
				value: coerceActive(raw.value) ?? raw.value
			});
			continue;
		}
		next.push({
			op,
			path,
			value: raw.value
		});
	}
	return next;
}
function readPatchOperations(body) {
	if (!isRecord$1(body)) return;
	const operations = body.Operations ?? body.operations;
	if (!Array.isArray(operations)) return;
	return operations;
}
//#endregion
//#region src/scim/handler.ts
const RESOURCES = /* @__PURE__ */ new Set([
	"Users",
	"Groups",
	"ServiceProviderConfig",
	"ResourceTypes",
	"Schemas"
]);
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function tenantFromPath(request) {
	const parts = new URL(request.url).pathname.split("/").filter(Boolean);
	const index = parts.findIndex((part) => RESOURCES.has(part ?? ""));
	if (index <= 0) return "";
	const prev = parts[index - 1] ?? "";
	if (prev === "v2" || prev === "scim") return "";
	return prev;
}
function parseRoute(url) {
	const parts = url.pathname.split("/").filter(Boolean);
	const index = parts.findIndex((part) => RESOURCES.has(part ?? ""));
	if (index === -1) return;
	const kind = parts[index];
	const id = parts[index + 1];
	if (kind === void 0) return;
	switch (kind) {
		case "Users": return compact({
			kind: "Users",
			id
		});
		case "Groups": return compact({
			kind: "Groups",
			id
		});
		case "ServiceProviderConfig": return { kind: "ServiceProviderConfig" };
		case "ResourceTypes": return { kind: "ResourceTypes" };
		case "Schemas": return compact({
			kind: "Schemas",
			id
		});
		default: return;
	}
}
function scimResponse(status, body, extra) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": SCIM_CONTENT_TYPE,
			...extra
		}
	});
}
function scimError(status, scimType, detail) {
	return scimResponse(status, {
		schemas: [ERROR_SCHEMA],
		status: String(status),
		scimType,
		detail
	});
}
function unauthorized() {
	return new Response(null, {
		status: 401,
		headers: { "www-authenticate": "Bearer" }
	});
}
function forbidden() {
	return new Response(null, {
		status: 403,
		headers: { "www-authenticate": "Bearer" }
	});
}
function audienceOf(request, configured) {
	if (configured !== void 0) return configured;
	const url = new URL(request.url);
	const parts = url.pathname.split("/").filter(Boolean);
	const index = parts.findIndex((part) => RESOURCES.has(part ?? ""));
	const prefix = index === -1 ? parts : parts.slice(0, index);
	return `${url.origin}/${prefix.join("/")}`;
}
function locationOf(request, kind, id) {
	const url = new URL(request.url);
	const parts = url.pathname.split("/").filter(Boolean);
	const index = parts.findIndex((part) => RESOURCES.has(part ?? ""));
	const prefix = index === -1 ? parts : parts.slice(0, index);
	return `${url.origin}/${[
		...prefix,
		kind,
		id
	].join("/")}`;
}
function pageFrom(url) {
	const startIndex = url.searchParams.get("startIndex");
	const count = url.searchParams.get("count");
	const cursor = url.searchParams.get("cursor");
	return compact({
		startIndex: startIndex === null ? void 0 : Math.trunc(Number(startIndex)),
		count: count === null ? void 0 : Math.trunc(Number(count)),
		cursor: cursor ?? void 0
	});
}
function listBody(result, render) {
	return compact({
		schemas: [LIST_SCHEMA],
		totalResults: result.totalResults,
		startIndex: result.startIndex,
		itemsPerPage: result.itemsPerPage,
		nextCursor: result.nextCursor,
		Resources: result.Resources.map(render)
	});
}
function renderUser(user, location) {
	return compact({
		schemas: [USER_SCHEMA],
		id: user.id,
		externalId: user.externalId,
		userName: user.userName,
		active: user.active,
		emails: user.emails,
		meta: {
			resourceType: "User",
			created: user.meta.created,
			lastModified: user.meta.lastModified,
			location
		}
	});
}
function renderGroup(group, location) {
	const extension = group.roles === void 0 ? void 0 : { [ROLES_EXTENSION]: { roles: group.roles } };
	return compact({
		schemas: group.roles === void 0 ? [GROUP_SCHEMA] : [GROUP_SCHEMA, ROLES_EXTENSION],
		id: group.id,
		externalId: group.externalId,
		displayName: group.displayName,
		members: group.members,
		...extension,
		meta: {
			resourceType: "Group",
			created: group.meta.created,
			lastModified: group.meta.lastModified,
			location
		}
	});
}
function readRoles(body) {
	const extension = body[ROLES_EXTENSION];
	if (!isRecord(extension) || !Array.isArray(extension.roles)) return;
	return extension.roles.filter((item) => typeof item === "string");
}
function userFromBody(body, id) {
	if (typeof body.userName !== "string" || body.userName === "") return;
	const emails = Array.isArray(body.emails) ? body.emails.flatMap((item) => {
		if (!isRecord(item) || typeof item.value !== "string") return [];
		return [compact({
			value: item.value,
			primary: typeof item.primary === "boolean" ? item.primary : void 0,
			type: typeof item.type === "string" ? item.type : void 0
		})];
	}) : void 0;
	const active = typeof body.active === "boolean" ? body.active : typeof body.active === "string" ? body.active.toLowerCase() !== "false" : true;
	return compact({
		id,
		userName: body.userName,
		externalId: typeof body.externalId === "string" ? body.externalId : void 0,
		active,
		emails,
		meta: {
			created: "",
			lastModified: ""
		}
	});
}
function groupFromBody(body, id, fallbackRoles) {
	if (typeof body.displayName !== "string" || body.displayName === "") return;
	const members = Array.isArray(body.members) ? body.members.flatMap((item) => {
		if (!isRecord(item) || typeof item.value !== "string") return [];
		return [{ value: item.value }];
	}) : [];
	return compact({
		id,
		displayName: body.displayName,
		externalId: typeof body.externalId === "string" ? body.externalId : void 0,
		members,
		roles: readRoles(body) ?? fallbackRoles,
		meta: {
			created: "",
			lastModified: ""
		}
	});
}
async function readJson(request) {
	const text = await request.text();
	if (text === "") return;
	return JSON.parse(text);
}
function schemasOk(body, required) {
	const listed = body.schemas;
	if (!Array.isArray(listed)) return false;
	return listed.includes(required) || listed.includes("urn:ietf:params:scim:api:messages:2.0:PatchOp");
}
function mapStoreError(error) {
	if (isDirectoryUniquenessError(error)) return scimError(409, "uniqueness", error.message);
	if (isDirectoryNotFoundError(error)) return scimError(404, "invalidValue", "resource not found");
	return scimError(500, "invalidValue", "store failed");
}
function reportUnknownRoles(roles, options) {
	if (roles === void 0 || options.assignable === void 0) return;
	const allowed = new Set(options.assignable);
	for (const name of roles) if (!allowed.has(name)) options.onUnknownRole?.(name);
}
async function emitDirectory(options, event, userIds) {
	const sink = options.sink ?? memorySink();
	try {
		await sink.write([event]);
	} catch {}
	try {
		await options.onChange?.({
			tenant: event.tenant,
			userIds
		});
	} catch {}
}
function directoryEvent(input) {
	return compact({
		type: "directory",
		at: (/* @__PURE__ */ new Date()).toISOString(),
		source: "scim",
		operation: input.operation,
		tenant: input.tenant,
		resource: {
			type: input.type,
			id: input.id
		},
		credential: input.credential,
		active: input.active
	});
}
function scimHandler(options) {
	if (options.token === void 0 && options.verifier === void 0) throw new Error("scimHandler requires token or verifier");
	return async (request) => {
		const url = new URL(request.url);
		const route = parseRoute(url);
		if (route === void 0) return scimError(404, "invalidValue", "unknown route");
		let tenant;
		try {
			tenant = typeof options.tenant === "string" ? options.tenant : await options.tenant(request);
		} catch {
			return forbidden();
		}
		if (tenant === "") return forbidden();
		const auth = await authenticateScim(compact({
			request,
			tenant,
			audience: audienceOf(request, options.audience),
			token: options.token,
			verifier: options.verifier
		}));
		if (!auth.ok) return auth.status === 403 ? forbidden() : unauthorized();
		try {
			if (route.kind === "ServiceProviderConfig") return scimResponse(200, serviceProviderConfig());
			if (route.kind === "ResourceTypes") return scimResponse(200, resourceTypes());
			if (route.kind === "Schemas") {
				const all = schemas();
				if (route.id !== void 0) {
					const schema = all.find((item) => item.id === route.id);
					if (schema === void 0) return scimError(404, "invalidValue", "schema not found");
					return scimResponse(200, schema);
				}
				return scimResponse(200, all);
			}
			if (request.method === "GET" && route.id === void 0) {
				const rawFilter = url.searchParams.get("filter");
				const filter = rawFilter === null || rawFilter === "" ? void 0 : parseScimFilter(rawFilter);
				if (rawFilter !== null && rawFilter !== "" && filter === void 0) return scimError(400, "invalidFilter", "unsupported filter");
				if (filter !== void 0 && !filterSupported(filter)) return scimError(400, "invalidFilter", "unsupported filter");
				const page = pageFrom(url);
				if (route.kind === "Users") return scimResponse(200, listBody(await options.store.findUsers(tenant, filter, page), (user) => renderUser(user, locationOf(request, "Users", user.id))));
				return scimResponse(200, listBody(await options.store.findGroups(tenant, filter, page), (group) => renderGroup(group, locationOf(request, "Groups", group.id))));
			}
			if (request.method === "GET" && route.id !== void 0) {
				if (route.kind === "Users") {
					const user = await options.store.getUser(tenant, route.id);
					if (user === null) return scimError(404, "invalidValue", "resource not found");
					return scimResponse(200, renderUser(user, locationOf(request, "Users", user.id)));
				}
				const group = await options.store.getGroup(tenant, route.id);
				if (group === null) return scimError(404, "invalidValue", "resource not found");
				return scimResponse(200, renderGroup(group, locationOf(request, "Groups", group.id)));
			}
			if (request.method === "DELETE" && route.id !== void 0) {
				if (route.kind === "Users") {
					const existing = await options.store.getUser(tenant, route.id);
					await options.store.deleteUser(tenant, route.id);
					await emitDirectory(options, directoryEvent({
						operation: "delete",
						tenant,
						type: "User",
						id: route.id,
						credential: auth.credential,
						active: false
					}), existing === null ? [] : [existing.id]);
					return new Response(null, { status: 204 });
				}
				const existing = await options.store.getGroup(tenant, route.id);
				await options.store.deleteGroup(tenant, route.id);
				await emitDirectory(options, directoryEvent({
					operation: "delete",
					tenant,
					type: "Group",
					id: route.id,
					credential: auth.credential
				}), existing?.members.map((member) => member.value) ?? []);
				return new Response(null, { status: 204 });
			}
			const body = await readJson(request);
			if (!isRecord(body)) return scimError(400, "invalidSyntax", "malformed body");
			if (request.method === "POST" && route.id === void 0) {
				if (route.kind === "Users") {
					if (!schemasOk(body, "urn:ietf:params:scim:schemas:core:2.0:User")) return scimError(400, "invalidSyntax", "unsupported schema");
					const parsed = userFromBody(body, "");
					if (parsed === void 0) return scimError(400, "invalidValue", "userName is required");
					const stored = await options.store.putUser(tenant, parsed);
					const location = locationOf(request, "Users", stored.id);
					await emitDirectory(options, directoryEvent({
						operation: "create",
						tenant,
						type: "User",
						id: stored.id,
						credential: auth.credential,
						active: stored.active
					}), [stored.id]);
					return scimResponse(201, renderUser(stored, location), { location });
				}
				if (!schemasOk(body, "urn:ietf:params:scim:schemas:core:2.0:Group")) return scimError(400, "invalidSyntax", "unsupported schema");
				const parsed = groupFromBody(body, "", options.groupRoles?.[body.id]);
				if (parsed === void 0) return scimError(400, "invalidValue", "displayName is required");
				reportUnknownRoles(parsed.roles, options);
				const stored = await options.store.putGroup(tenant, parsed);
				const location = locationOf(request, "Groups", stored.id);
				await emitDirectory(options, directoryEvent({
					operation: "create",
					tenant,
					type: "Group",
					id: stored.id,
					credential: auth.credential
				}), stored.members.map((member) => member.value));
				return scimResponse(201, renderGroup(stored, location), { location });
			}
			if (request.method === "PUT" && route.id !== void 0) {
				if (route.kind === "Users") {
					if (!schemasOk(body, "urn:ietf:params:scim:schemas:core:2.0:User")) return scimError(400, "invalidSyntax", "unsupported schema");
					if (await options.store.getUser(tenant, route.id) === null) return scimError(404, "invalidValue", "resource not found");
					const parsed = userFromBody(body, route.id);
					if (parsed === void 0) return scimError(400, "invalidValue", "userName is required");
					const stored = await options.store.putUser(tenant, parsed);
					const location = locationOf(request, "Users", stored.id);
					await emitDirectory(options, directoryEvent({
						operation: "replace",
						tenant,
						type: "User",
						id: stored.id,
						credential: auth.credential,
						active: stored.active
					}), [stored.id]);
					return scimResponse(200, renderUser(stored, location), { location });
				}
				if (!schemasOk(body, "urn:ietf:params:scim:schemas:core:2.0:Group")) return scimError(400, "invalidSyntax", "unsupported schema");
				if (await options.store.getGroup(tenant, route.id) === null) return scimError(404, "invalidValue", "resource not found");
				const parsed = groupFromBody(body, route.id, options.groupRoles?.[route.id]);
				if (parsed === void 0) return scimError(400, "invalidValue", "displayName is required");
				reportUnknownRoles(parsed.roles, options);
				const stored = await options.store.putGroup(tenant, parsed);
				const location = locationOf(request, "Groups", stored.id);
				await emitDirectory(options, directoryEvent({
					operation: "replace",
					tenant,
					type: "Group",
					id: stored.id,
					credential: auth.credential
				}), stored.members.map((member) => member.value));
				return scimResponse(200, renderGroup(stored, location), { location });
			}
			if (request.method === "PATCH" && route.id !== void 0) {
				const operations = readPatchOperations(body);
				if (operations === void 0) return scimError(400, "invalidSyntax", "Operations required");
				const normalized = normalizePatchOps(operations);
				if (normalized === void 0) return scimError(400, "invalidSyntax", "invalid patch");
				if (route.kind === "Users") {
					const stored = await options.store.patchUser(tenant, route.id, normalized);
					const location = locationOf(request, "Users", stored.id);
					await emitDirectory(options, directoryEvent({
						operation: "patch",
						tenant,
						type: "User",
						id: stored.id,
						credential: auth.credential,
						active: stored.active
					}), [stored.id]);
					return scimResponse(200, renderUser(stored, location), { location });
				}
				const stored = await options.store.patchGroup(tenant, route.id, normalized);
				const location = locationOf(request, "Groups", stored.id);
				await emitDirectory(options, directoryEvent({
					operation: "patch",
					tenant,
					type: "Group",
					id: stored.id,
					credential: auth.credential
				}), stored.members.map((member) => member.value));
				return scimResponse(200, renderGroup(stored, location), { location });
			}
			return scimError(405, "invalidValue", "method not allowed");
		} catch (error) {
			if (error instanceof SyntaxError) return scimError(400, "invalidSyntax", "malformed body");
			return mapStoreError(error);
		}
	};
}
//#endregion
//#region src/scim/source.ts
function allowedRoles(roles, assignable, onUnknownRole) {
	if (roles === void 0) return [];
	if (assignable === void 0) return roles;
	const allowed = new Set(assignable);
	const kept = [];
	for (const name of roles) {
		if (allowed.has(name)) {
			kept.push(name);
			continue;
		}
		onUnknownRole?.(name);
	}
	return kept;
}
async function lookupUser(store, tenant, attribute, principalId) {
	const filter = parseScimFilter(`${attribute} eq "${principalId}"`);
	return (await store.findUsers(tenant, filter, {
		startIndex: 1,
		count: 1
	})).Resources[0] ?? null;
}
async function findUser(store, tenant, principalId, match) {
	const mode = match ?? "either";
	if (mode === "externalId" || mode === "either") {
		const user = await lookupUser(store, tenant, "externalId", principalId);
		if (user !== null) return user;
	}
	if (mode === "userName" || mode === "either") return lookupUser(store, tenant, "userName", principalId);
	return null;
}
function directoryMembershipSource(store, options = {}) {
	return { async membershipsFor(principal, query) {
		const tenant = query.tenant;
		if (tenant === void 0 || tenant === "") return [];
		let user;
		try {
			user = await findUser(store, tenant, principal.id, options.match);
		} catch {
			return [];
		}
		if (user === null || !user.active) return [];
		let groups;
		try {
			groups = [...await store.groupsFor(tenant, user.id)];
		} catch {
			return [];
		}
		const memberships = [];
		for (const group of groups) {
			const mapped = group.roles ?? options.groupRoles?.[group.id];
			memberships.push(compact({
				tenant,
				team: group.id,
				roles: allowedRoles(mapped, options.assignable, options.onUnknownRole),
				via: `group:${group.id}`
			}));
		}
		return memberships;
	} };
}
//#endregion
//#region src/scim/store.ts
const DEFAULT_COUNT = 100;
function now() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function randomId(prefix) {
	const bytes = /* @__PURE__ */ new Uint8Array(8);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return `${prefix}${hex}`;
}
function directoryKey(tenant, id) {
	return `${tenant}\0${id}`;
}
function asError(error) {
	return error instanceof Error ? error : new Error(String(error));
}
function pageOf(items, page) {
	const count = page.count ?? DEFAULT_COUNT;
	let start = 0;
	if (page.cursor !== void 0 && page.cursor !== "") {
		const decoded = Math.trunc(Number(page.cursor));
		start = Number.isFinite(decoded) ? decoded : 0;
	} else if (page.startIndex !== void 0 && page.startIndex > 0) start = page.startIndex - 1;
	const slice = items.slice(start, start + count);
	const nextIndex = start + slice.length;
	return compact({
		Resources: slice,
		totalResults: items.length,
		startIndex: start + 1,
		itemsPerPage: slice.length,
		nextCursor: nextIndex < items.length ? String(nextIndex) : void 0
	});
}
function emailsOf(value) {
	if (!Array.isArray(value)) return;
	return value.flatMap((item) => {
		if (item === null || typeof item !== "object") return [];
		const record = item;
		if (typeof record.value !== "string") return [];
		return [compact({
			value: record.value,
			primary: typeof record.primary === "boolean" ? record.primary : void 0,
			type: typeof record.type === "string" ? record.type : void 0
		})];
	});
}
function membersOf(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (item === null || typeof item !== "object") return [];
		const record = item;
		return typeof record.value === "string" ? [{ value: record.value }] : [];
	});
}
function rolesOf(value) {
	if (!Array.isArray(value)) return;
	return value.filter((item) => typeof item === "string");
}
function memberValues(value) {
	return membersOf(value).map((member) => member.value);
}
function applyUserOp(user, op) {
	const path = op.path ?? "";
	if (path === "active" && typeof op.value === "boolean") return {
		...user,
		active: op.value
	};
	if (path === "userName" && typeof op.value === "string") return {
		...user,
		userName: op.value
	};
	if (path === "externalId") return compact({
		...user,
		externalId: typeof op.value === "string" ? op.value : void 0
	});
	if (path === "emails") return compact({
		...user,
		emails: emailsOf(op.value)
	});
	return user;
}
function applyGroupOp(group, op) {
	const path = op.path ?? "";
	if (path === "displayName" && typeof op.value === "string") return {
		...group,
		displayName: op.value
	};
	if (path === "externalId") return compact({
		...group,
		externalId: typeof op.value === "string" ? op.value : void 0
	});
	if (path === "roles") return compact({
		...group,
		roles: rolesOf(op.value)
	});
	if (path !== "members") return group;
	const incoming = memberValues(op.value);
	const current = group.members.map((member) => member.value);
	if (op.op === "replace") return {
		...group,
		members: incoming.map((value) => ({ value }))
	};
	if (op.op === "add") {
		const next = [...current];
		for (const value of incoming) if (!next.includes(value)) next.push(value);
		return {
			...group,
			members: next.map((value) => ({ value }))
		};
	}
	return {
		...group,
		members: current.filter((value) => !incoming.includes(value)).map((value) => ({ value }))
	};
}
function memoryDirectoryStore() {
	const users = /* @__PURE__ */ new Map();
	const groups = /* @__PURE__ */ new Map();
	function usersIn(tenant) {
		const found = [];
		for (const [key, user] of users) if (key.startsWith(`${tenant}\0`)) found.push(user);
		return found;
	}
	function groupsIn(tenant) {
		const found = [];
		for (const [key, group] of groups) if (key.startsWith(`${tenant}\0`)) found.push(group);
		return found;
	}
	function assertUserUnique(tenant, user, ignoreId) {
		for (const existing of usersIn(tenant)) {
			if (existing.id === ignoreId) continue;
			if (existing.userName === user.userName) throw new DirectoryUniquenessError("userName");
			if (user.externalId !== void 0 && existing.externalId === user.externalId) throw new DirectoryUniquenessError("externalId");
		}
	}
	function assertGroupUnique(tenant, group, ignoreId) {
		for (const existing of groupsIn(tenant)) {
			if (existing.id === ignoreId) continue;
			if (group.externalId !== void 0 && existing.externalId === group.externalId) throw new DirectoryUniquenessError("externalId");
		}
	}
	function stampUser(user, created) {
		const at = now();
		return freezeDeep({
			...user,
			meta: compact({
				created: created ?? user.meta.created ?? at,
				lastModified: at,
				resourceType: "User",
				location: user.meta.location
			})
		});
	}
	function stampGroup(group, created) {
		const at = now();
		return freezeDeep({
			...group,
			meta: compact({
				created: created ?? group.meta.created ?? at,
				lastModified: at,
				resourceType: "Group",
				location: group.meta.location
			})
		});
	}
	return {
		getUser(tenant, id) {
			return Promise.resolve(users.get(directoryKey(tenant, id)) ?? null);
		},
		findUsers(tenant, filter, page) {
			const matched = usersIn(tenant).filter((user) => matchFilter(user, filter));
			return Promise.resolve(pageOf(matched, page));
		},
		putUser(tenant, user) {
			try {
				const id = user.id === "" ? randomId("u_") : user.id;
				const existing = users.get(directoryKey(tenant, id));
				const next = stampUser({
					...user,
					id
				}, existing?.meta.created);
				assertUserUnique(tenant, next, id);
				users.set(directoryKey(tenant, id), next);
				return Promise.resolve(next);
			} catch (error) {
				return Promise.reject(asError(error));
			}
		},
		patchUser(tenant, id, ops) {
			try {
				const existing = users.get(directoryKey(tenant, id));
				if (existing === void 0) throw new DirectoryNotFoundError();
				let next = existing;
				for (const op of ops) next = applyUserOp(next, op);
				next = stampUser(next, existing.meta.created);
				assertUserUnique(tenant, next, id);
				users.set(directoryKey(tenant, id), next);
				return Promise.resolve(next);
			} catch (error) {
				return Promise.reject(asError(error));
			}
		},
		deleteUser(tenant, id) {
			if (!users.delete(directoryKey(tenant, id))) return Promise.reject(new DirectoryNotFoundError());
			for (const group of groupsIn(tenant)) {
				if (!group.members.some((member) => member.value === id)) continue;
				groups.set(directoryKey(tenant, group.id), stampGroup({
					...group,
					members: group.members.filter((member) => member.value !== id)
				}, group.meta.created));
			}
			return Promise.resolve();
		},
		getGroup(tenant, id) {
			return Promise.resolve(groups.get(directoryKey(tenant, id)) ?? null);
		},
		findGroups(tenant, filter, page) {
			const matched = groupsIn(tenant).filter((group) => matchFilter(group, filter));
			return Promise.resolve(pageOf(matched, page));
		},
		putGroup(tenant, group) {
			try {
				const id = group.id === "" ? randomId("g_") : group.id;
				const existing = groups.get(directoryKey(tenant, id));
				const next = stampGroup({
					...group,
					id,
					members: group.members
				}, existing?.meta.created);
				assertGroupUnique(tenant, next, id);
				groups.set(directoryKey(tenant, id), next);
				return Promise.resolve(next);
			} catch (error) {
				return Promise.reject(asError(error));
			}
		},
		patchGroup(tenant, id, ops) {
			try {
				const existing = groups.get(directoryKey(tenant, id));
				if (existing === void 0) throw new DirectoryNotFoundError();
				let next = existing;
				for (const op of ops) next = applyGroupOp(next, op);
				next = stampGroup(next, existing.meta.created);
				assertGroupUnique(tenant, next, id);
				groups.set(directoryKey(tenant, id), next);
				return Promise.resolve(next);
			} catch (error) {
				return Promise.reject(asError(error));
			}
		},
		deleteGroup(tenant, id) {
			if (!groups.delete(directoryKey(tenant, id))) return Promise.reject(new DirectoryNotFoundError());
			return Promise.resolve();
		},
		groupsFor(tenant, userId) {
			return Promise.resolve(groupsIn(tenant).filter((group) => group.members.some((member) => member.value === userId)));
		}
	};
}
//#endregion
export { DirectoryNotFoundError, DirectoryUniquenessError, ERROR_SCHEMA, GROUP_SCHEMA, LIST_SCHEMA, PATCH_SCHEMA, ROLES_EXTENSION, SCIM_CONTENT_TYPE, USER_SCHEMA, authenticateScim, directoryMembershipSource, filterSupported, matchFilter, memoryDirectoryStore, normalizePatchOps, parseScimFilter, resourceTypes, schemas, scimHandler, serviceProviderConfig, sha256Hex, tenantFromPath };
