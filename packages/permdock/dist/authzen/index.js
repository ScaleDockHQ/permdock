import { t as compact } from "../compact-CxSqQNw0.js";
import { t as createPermDock$1 } from "../permdock-C-YFXzhV.js";
import { o as listPermissions } from "../permissions-WEkUHQtZ.js";
import { a as problemResponse, o as validationProblem, r as PROBLEM_BASE, t as applyApprovalResume } from "../evaluations-cJeur3Fn.js";
import { a as evaluationRow, c as pageOf, d as permissionOf, f as resourceData, h as userFromEntity, i as endsWithPath, l as paged, m as tenantOf, n as actorOf, o as isRecord, p as resourceIdOf, r as delegationOf, s as mergeItem, t as UNKNOWN, u as pathnameOf } from "../map-BA2lzIVj.js";
//#region src/authzen/create.ts
const DEFAULT_MAX = 256;
function unauthorized() {
	return problemResponse({
		type: `${PROBLEM_BASE}/unauthenticated`,
		title: "Unauthenticated",
		status: 401,
		detail: "AuthZEN decision endpoint requires authentication"
	}, void 0, {
		outcome: "denied",
		denials: [{
			role: null,
			reason: "anonymous"
		}],
		alternatives: []
	});
}
function methodNotAllowed(allow) {
	const response = problemResponse({
		type: `${PROBLEM_BASE}/method-not-allowed`,
		title: "Method not allowed",
		status: 405,
		detail: `use ${allow}`
	});
	response.headers.set("Allow", allow);
	return response;
}
function notFound(detail) {
	return problemResponse({
		type: `${PROBLEM_BASE}/not-found`,
		title: "Not found",
		status: 404,
		detail
	});
}
function tooLarge(max) {
	return problemResponse({
		type: `${PROBLEM_BASE}/payload-too-large`,
		title: "Payload too large",
		status: 413,
		detail: `evaluations batch exceeds ${String(max)}`
	});
}
async function readJson(request) {
	try {
		return await request.json();
	} catch {
		return validationProblem("AuthZEN body was not valid JSON");
	}
}
function resourceRef(permission, data, item) {
	const fromRow = data !== null && typeof data === "object" && "id" in data ? data.id : void 0;
	const fromWire = item.resource?.id;
	const id = typeof fromRow === "string" || typeof fromRow === "number" ? String(fromRow) : typeof fromWire === "string" || typeof fromWire === "number" ? String(fromWire) : void 0;
	return compact({
		type: permission.resource,
		id
	});
}
const createPermDock = (policy, options) => {
	const maxEvaluations = options.maxEvaluations ?? DEFAULT_MAX;
	const trustedPep = options.trustedPep !== false;
	const allowAnonymous = options.anonymous === true;
	async function authenticate(request) {
		let pep;
		try {
			pep = await options.subject(request);
		} catch {
			pep = null;
		}
		if ((pep === null || pep === void 0) && !allowAnonymous) return unauthorized();
		return { pep: pep ?? null };
	}
	function instantiate(pep, item) {
		const bodyUser = userFromEntity(item.subject);
		return createPermDock$1(policy, trustedPep && bodyUser !== null ? bodyUser : pep, compact({
			actor: actorOf(item),
			delegation: delegationOf(item),
			tenant: tenantOf(item),
			memberships: options.memberships,
			customRoles: options.customRoles,
			sink: options.sink
		}));
	}
	async function resourceOf(item) {
		const properties = item.resource?.properties;
		if (properties !== null && typeof properties === "object") return {
			data: properties,
			trusted: false
		};
		const type = typeof item.resource?.type === "string" ? item.resource.type : void 0;
		const id = resourceIdOf(item);
		const load = type !== void 0 && options.resources !== void 0 ? options.resources[type]?.load : void 0;
		if (id !== void 0 && load !== void 0) try {
			return {
				data: await load(id),
				trusted: true
			};
		} catch {
			return {
				data: resourceData(item),
				trusted: false
			};
		}
		return {
			data: resourceData(item),
			trusted: false
		};
	}
	async function decideItem(request, pep, item) {
		const permission = permissionOf(policy.permissions, item);
		if (permission === void 0) return UNKNOWN;
		const { data, trusted } = await resourceOf(item);
		const dock = await instantiate(pep, item);
		const decide = dock.decide;
		const decision = decide(permission, data, compact({
			source: "endpoint",
			adapter: "authzen",
			trusted: trusted ? true : void 0
		}));
		return applyApprovalResume(decision, permission, dock, options.store, request, resourceRef(permission, data, item), "authzen");
	}
	async function evaluation(request, pep) {
		const body = await readJson(request);
		if (body instanceof Response) return body;
		if (!isRecord(body)) return validationProblem("evaluation body must be an object");
		return Response.json(evaluationRow(await decideItem(request, pep, body)));
	}
	async function evaluations(request, pep) {
		const body = await readJson(request);
		if (body instanceof Response) return body;
		if (!isRecord(body)) return validationProblem("evaluations body must be an object");
		const items = body.evaluations;
		if (items === void 0) return validationProblem("evaluations array is required");
		if (!Array.isArray(items)) return validationProblem("evaluations must be an array");
		if (items.length > maxEvaluations) return tooLarge(maxEvaluations);
		const shared = compact({
			subject: isRecord(body.subject) ? body.subject : void 0,
			context: body.context
		});
		const rows = await Promise.all(items.map((item) => decideItem(request, pep, mergeItem(shared, item)).then(evaluationRow)));
		return Response.json({ evaluations: rows });
	}
	async function searchAction(request, pep) {
		const body = await readJson(request);
		if (body instanceof Response) return body;
		if (!isRecord(body)) return validationProblem("search/action body must be an object");
		const item = body;
		const type = typeof item.resource?.type === "string" ? item.resource.type : void 0;
		const leaves = listPermissions(policy.permissions).filter((leaf) => type === void 0 || leaf.resource === type);
		const decisions = await Promise.all(leaves.map(async (leaf) => ({
			leaf,
			decision: await decideItem(request, pep, compact({
				subject: item.subject,
				context: item.context,
				resource: item.resource,
				action: { name: leaf.key }
			}))
		})));
		const names = [];
		for (const { leaf, decision } of decisions) if (decision.outcome === "granted" && !names.includes(leaf.action)) names.push(leaf.action);
		const { offset, size } = pageOf(body);
		return Response.json(paged(names.map((name) => ({ name })), offset, size));
	}
	async function listRows(type, where) {
		const list = options.resources?.[type]?.list;
		if (list === void 0) return [];
		try {
			return await list({ where });
		} catch {
			return [];
		}
	}
	async function searchResource(request, pep) {
		const body = await readJson(request);
		if (body instanceof Response) return body;
		if (!isRecord(body)) return validationProblem("search/resource body must be an object");
		const item = body;
		const type = typeof item.resource?.type === "string" ? item.resource.type : void 0;
		const permission = permissionOf(policy.permissions, item);
		if (type === void 0 || permission === void 0) return Response.json({
			results: [],
			page: { next_token: "" }
		});
		const rows = await listRows(type, isRecord(item.resource?.properties) ? item.resource.properties : void 0);
		const dock = await instantiate(pep, item);
		let permitted = [];
		if (permission.kind === "instance") permitted = dock.filter(permission, rows);
		else if (permission.kind === "collection" && dock.can(permission)) permitted = rows;
		const { offset, size } = pageOf(body);
		return Response.json(paged(permitted, offset, size));
	}
	async function searchSubject(request, pep) {
		if (options.subjects?.list === void 0) return notFound("search/subject is not configured");
		const body = await readJson(request);
		if (body instanceof Response) return body;
		if (!isRecord(body)) return validationProblem("search/subject body must be an object");
		let records;
		try {
			records = await options.subjects.list();
		} catch {
			return Response.json({
				results: [],
				page: { next_token: "" }
			});
		}
		const item = body;
		const matches = (await Promise.all(records.map(async (record) => {
			const properties = {};
			for (const [key, value] of Object.entries(record)) if (key !== "id") properties[key] = value;
			return {
				id: record.id,
				decision: await decideItem(request, pep, compact({
					action: item.action,
					resource: item.resource,
					context: item.context,
					subject: {
						type: "user",
						id: record.id,
						properties
					}
				}))
			};
		}))).flatMap(({ id, decision }) => decision.outcome === "granted" ? [{
			type: "user",
			id
		}] : []);
		const { offset, size } = pageOf(body);
		return Response.json(paged(matches, offset, size));
	}
	function discovery(request) {
		const origin = new URL(request.url).origin;
		const document = {
			policy_decision_point: origin,
			access_evaluation_endpoint: `${origin}/access/v1/evaluation`,
			access_evaluations_endpoint: `${origin}/access/v1/evaluations`,
			search_action_endpoint: `${origin}/access/v1/search/action`,
			search_resource_endpoint: `${origin}/access/v1/search/resource`
		};
		if (options.subjects?.list !== void 0) document.search_subject_endpoint = `${origin}/access/v1/search/subject`;
		return Response.json(document);
	}
	return { async handler(request) {
		const pathname = pathnameOf(request);
		if (endsWithPath(pathname, "/.well-known/authzen-configuration") || pathname.includes("/.well-known/authzen-configuration/")) {
			if (request.method !== "GET") return methodNotAllowed("GET");
			return discovery(request);
		}
		const identity = await authenticate(request);
		if (identity instanceof Response) return identity;
		const routes = [
			[
				"POST",
				"/access/v1/evaluation",
				evaluation
			],
			[
				"POST",
				"/access/v1/evaluations",
				evaluations
			],
			[
				"POST",
				"/access/v1/search/action",
				searchAction
			],
			[
				"POST",
				"/access/v1/search/resource",
				searchResource
			],
			[
				"POST",
				"/access/v1/search/subject",
				searchSubject
			]
		];
		for (const [method, suffix, route] of routes) if (endsWithPath(pathname, suffix)) {
			if (request.method !== method) return methodNotAllowed(method);
			return route(request, identity.pep);
		}
		return notFound("unknown AuthZEN path");
	} };
};
//#endregion
export { createPermDock };
