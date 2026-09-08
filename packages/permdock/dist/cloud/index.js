import { t as freezeDeep } from "../freeze-BF4IK5al.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { n as parseSnapshot } from "../snapshot-BD9YMLyb.js";
import { t as ApprovalError } from "../errors-BQyxzFvZ.js";
//#region src/cloud/create.ts
function readEnv(name) {
	const value = globalThis.process?.env?.[name];
	return typeof value === "string" ? value : "";
}
function firstNonEmpty(...values) {
	for (const value of values) if (value !== void 0 && value !== "") return value;
	return "";
}
function trimSlash(value) {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asApproval(value) {
	if (!isRecord(value) || value.v !== 1 || typeof value.token !== "string") return null;
	return value;
}
function isCompactJws(value) {
	return !value.startsWith("{") && value.split(".").length === 3;
}
function approvalErrorFromStatus(status) {
	if (status === 409) return new ApprovalError("approval-not-pending", "approval is not pending");
	if (status === 410) return new ApprovalError("approval-expired", "approval has expired");
	return new ApprovalError("approval-not-found", "approval was not found");
}
function cloud(options = {}) {
	const url = trimSlash(firstNonEmpty(options.url, readEnv("PERMDOCK_CLOUD_URL")));
	const key = firstNonEmpty(options.key, readEnv("PERMDOCK_CLOUD_KEY"));
	const environment = firstNonEmpty(options.environment, readEnv("PERMDOCK_CLOUD_ENV"), readEnv("VERCEL_ENV"), "production");
	if (url === "" || key === "") throw new Error("PermDock: cloud() requires url and key.");
	const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
	const flushAt = options.flushAt ?? 32;
	const waitUntil = options.waitUntil;
	const root = `${url}/v1/environments/${encodeURIComponent(environment)}`;
	const headers = () => {
		const next = new Headers();
		next.set("authorization", `Bearer ${key}`);
		next.set("content-type", "application/json");
		return next;
	};
	const request = (path, init = {}) => {
		return fetchFn(`${root}${path}`, {
			...init,
			headers: headers()
		});
	};
	const approvals = {
		async create(record) {
			if (!(await request("/approvals", {
				method: "POST",
				body: JSON.stringify(record)
			})).ok) throw new Error("PermDock Cloud rejected the approval create");
		},
		async get(token) {
			try {
				const response = await request(`/approvals/${encodeURIComponent(token)}`);
				if (!response.ok) return null;
				return asApproval(await response.json());
			} catch {
				return null;
			}
		},
		async resolve(token, verdict) {
			const response = await request(`/approvals/${encodeURIComponent(token)}/resolve`, {
				method: "POST",
				body: JSON.stringify(verdict)
			});
			if (!response.ok) throw approvalErrorFromStatus(response.status);
			const parsed = asApproval(await response.json());
			if (parsed === null) throw new ApprovalError("approval-not-found", "PermDock Cloud returned an unknown approval shape");
			return parsed;
		},
		async list(filter) {
			const query = new URLSearchParams(compact({
				status: filter.status,
				principalId: filter.principalId,
				actorId: filter.actorId,
				tenant: filter.tenant
			}));
			const suffix = query.size === 0 ? "" : `?${query.toString()}`;
			try {
				const response = await request(`/approvals${suffix}`);
				if (!response.ok) return [];
				const body = await response.json();
				if (!Array.isArray(body)) return [];
				return body.flatMap((item) => {
					const parsed = asApproval(item);
					return parsed === null ? [] : [parsed];
				});
			} catch {
				return [];
			}
		},
		async expire(now) {
			try {
				const response = await request("/approvals/expire", {
					method: "POST",
					body: JSON.stringify(compact({ now: now === void 0 ? void 0 : now.toISOString() }))
				});
				if (!response.ok) return 0;
				const body = await response.json();
				if (!isRecord(body) || typeof body.expired !== "number") return 0;
				return body.expired;
			} catch {
				return 0;
			}
		}
	};
	const pending = [];
	const flush = async () => {
		if (pending.length === 0) return;
		const events = pending.splice(0);
		try {
			if (!(await request("/decisions", {
				method: "POST",
				body: JSON.stringify({ events })
			})).ok) pending.unshift(...events);
		} catch {
			pending.unshift(...events);
		}
	};
	return freezeDeep({
		approvals,
		sink: {
			write(events) {
				pending.push(...events);
				if (pending.length >= flushAt) return flush();
				if (waitUntil !== void 0 && pending.length > 0) waitUntil(flush());
			},
			flush
		},
		snapshots: { async get() {
			const response = await request("/snapshot");
			if (!response.ok) throw new Error("PermDock Cloud snapshot request failed");
			const text = await response.text();
			if (isCompactJws(text)) return text;
			return parseSnapshot(text);
		} }
	});
}
//#endregion
export { cloud };
