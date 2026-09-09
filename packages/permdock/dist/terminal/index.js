import { t as compact } from "../compact-CxSqQNw0.js";
import { a as deniedMessage, i as approvalMessage, n as PermDockDeniedError, t as PermDockApprovalRequiredError } from "../errors-DDT8tC4N.js";
import { r as isSubject } from "../subject-Dz8DcVLC.js";
import { t as createPermDock$1 } from "../permdock-DsLtum_2.js";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
//#region src/terminal/device.ts
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function readJson(response) {
	try {
		const body = await response.json();
		return isRecord$1(body) ? body : null;
	} catch {
		return null;
	}
}
async function discoverDeviceEndpoints(issuer, runtime) {
	const fetchImpl = runtime.fetch ?? fetch;
	const url = issuer.endsWith("/") ? `${issuer}.well-known/oauth-authorization-server` : `${issuer}/.well-known/oauth-authorization-server`;
	try {
		const body = await readJson(await fetchImpl(url));
		if (body === null) return {};
		return compact({
			authorizationEndpoint: typeof body.device_authorization_endpoint === "string" ? body.device_authorization_endpoint : void 0,
			tokenEndpoint: typeof body.token_endpoint === "string" ? body.token_endpoint : void 0,
			revocationEndpoint: typeof body.revocation_endpoint === "string" ? body.revocation_endpoint : void 0
		});
	} catch {
		return {};
	}
}
function parseAuthorization(body) {
	if (typeof body.device_code !== "string" || typeof body.user_code !== "string" || typeof body.verification_uri !== "string" || typeof body.expires_in !== "number") return null;
	return compact({
		device_code: body.device_code,
		user_code: body.user_code,
		verification_uri: body.verification_uri,
		verification_uri_complete: typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : void 0,
		expires_in: body.expires_in,
		interval: typeof body.interval === "number" ? body.interval : void 0
	});
}
function parseToken(body, now) {
	if (typeof body.error === "string") return {
		ok: false,
		error: body.error
	};
	if (typeof body.access_token !== "string") return {
		ok: false,
		error: "invalid-token"
	};
	return {
		ok: true,
		credential: compact({
			access_token: body.access_token,
			refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : void 0,
			expires_at: typeof body.expires_in === "number" ? now + body.expires_in : void 0,
			token_type: typeof body.token_type === "string" ? body.token_type : void 0
		})
	};
}
async function runDeviceFlow(device, runtime, write) {
	const fetchImpl = runtime.fetch ?? fetch;
	const sleep = runtime.sleep ?? defaultSleep;
	const now = runtime.now ?? (() => Math.floor(Date.now() / 1e3));
	let authorizationEndpoint = device.authorizationEndpoint;
	let tokenEndpoint = device.tokenEndpoint;
	if ((authorizationEndpoint === void 0 || tokenEndpoint === void 0) && device.issuer !== void 0) {
		const discovered = await discoverDeviceEndpoints(device.issuer, runtime);
		authorizationEndpoint = authorizationEndpoint ?? discovered.authorizationEndpoint;
		tokenEndpoint = tokenEndpoint ?? discovered.tokenEndpoint;
	}
	if (authorizationEndpoint === void 0 || tokenEndpoint === void 0) return null;
	const startedBody = await readJson(await fetchImpl(authorizationEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: device.clientId,
			scope: device.scope ?? ""
		})
	}));
	const authorization = startedBody === null ? null : parseAuthorization(startedBody);
	if (authorization === null) return null;
	device.onPrompt?.(compact({
		user_code: authorization.user_code,
		verification_uri: authorization.verification_uri,
		verification_uri_complete: authorization.verification_uri_complete
	}));
	write(`Visit ${authorization.verification_uri} and enter ${authorization.user_code}\n`);
	if (authorization.verification_uri_complete !== void 0) device.open?.(authorization.verification_uri_complete);
	let interval = authorization.interval ?? 5;
	const deadline = now() + authorization.expires_in;
	while (now() < deadline) {
		await sleep(interval * 1e3);
		const polledBody = await readJson(await fetchImpl(tokenEndpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: authorization.device_code,
				client_id: device.clientId
			})
		}));
		if (polledBody === null) return null;
		const token = parseToken(polledBody, now());
		if (token.ok) return token.credential;
		if (token.error === "slow_down") {
			interval += 5;
			continue;
		}
		if (token.error === "authorization_pending") continue;
		return null;
	}
	return null;
}
async function refreshCredential(device, credential, runtime) {
	if (credential.refresh_token === void 0) return null;
	const fetchImpl = runtime.fetch ?? fetch;
	const now = runtime.now ?? (() => Math.floor(Date.now() / 1e3));
	let tokenEndpoint = device.tokenEndpoint;
	if (tokenEndpoint === void 0 && device.issuer !== void 0) tokenEndpoint = (await discoverDeviceEndpoints(device.issuer, runtime)).tokenEndpoint;
	if (tokenEndpoint === void 0) return null;
	try {
		const body = await readJson(await fetchImpl(tokenEndpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: credential.refresh_token,
				client_id: device.clientId
			})
		}));
		if (body === null) return null;
		const token = parseToken(body, now());
		return token.ok ? token.credential : null;
	} catch {
		return null;
	}
}
async function revokeCredential(device, credential, runtime) {
	if (device === void 0 || credential.refresh_token === void 0) return;
	const fetchImpl = runtime.fetch ?? fetch;
	let revocationEndpoint = device.revocationEndpoint;
	if (revocationEndpoint === void 0 && device.issuer !== void 0) revocationEndpoint = (await discoverDeviceEndpoints(device.issuer, runtime)).revocationEndpoint;
	if (revocationEndpoint === void 0) return;
	try {
		await fetchImpl(revocationEndpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				token: credential.refresh_token,
				token_type_hint: "refresh_token",
				client_id: device.clientId
			})
		});
	} catch {}
}
function defaultSleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
//#endregion
//#region src/terminal/exit.ts
const EX_OK = 0;
const EX_TEMPFAIL = 75;
const EX_NOPERM = 77;
const EX_CONFIG = 78;
var TerminalExit = class extends Error {
	name = "TerminalExit";
	code;
	constructor(code) {
		super(`exit ${String(code)}`);
		this.code = code;
	}
};
function defaultExit(code) {
	process.exit(code);
	throw new TerminalExit(code);
}
//#endregion
//#region src/terminal/filter.ts
function snapshotAllows(dock, permission) {
	const snapshot = dock.snapshot();
	if (typeof snapshot === "string" || snapshot instanceof Promise) return false;
	return snapshot.grants.some((grant) => grant.permission === permission.key && grant.effect === "allow");
}
function commandAllowed(dock, permission) {
	if (permission.kind === "collection") return dock.can(permission);
	return snapshotAllows(dock, permission);
}
function filterCommandEntries(dock, entries, options) {
	const mode = options.mode;
	if (dock === void 0) {
		if (mode === "hide") return [];
		return entries.map((entry) => ({
			...entry,
			description: `${entry.description} (requires ${entry.permission.scope})`
		}));
	}
	const visible = [];
	for (const entry of entries) {
		if (commandAllowed(dock, entry.permission)) {
			visible.push(entry);
			continue;
		}
		if (mode === "annotate") visible.push({
			...entry,
			description: `${entry.description} (requires ${entry.permission.scope})`
		});
	}
	return visible;
}
//#endregion
//#region src/terminal/format.ts
function exitCode(decision) {
	switch (decision.outcome) {
		case "granted": return 0;
		case "approval-required": return 75;
		case "denied": return 77;
		default: return decision;
	}
}
function permissionKey(decision, permission) {
	if (permission !== void 0) return permission.key;
	if (decision.outcome === "granted") return decision.matched.permission;
	if (decision.outcome === "approval-required") return decision.grant.permission;
	return "unknown";
}
function permissionScope(permission) {
	return permission?.scope ?? "";
}
function resourceOf(permission) {
	return { type: permission?.resource ?? "unknown" };
}
function formatDecision(decision, options = {}) {
	const json = options.json === true;
	const key = permissionKey(decision, options.permission);
	const scope = permissionScope(options.permission);
	const resource = resourceOf(options.permission);
	const subject = options.subject;
	if (decision.outcome === "granted") return json ? `${JSON.stringify({
		outcome: "granted",
		permission: key
	})}\n` : "";
	if (decision.outcome === "approval-required") {
		const error = new PermDockApprovalRequiredError({
			decision,
			permission: key,
			scope,
			resource,
			message: approvalMessage(key, decision.reason, decision.token)
		});
		const details = compact({
			...error.toProblemDetails(compact({ instance: options.instance })),
			approval: options.approval
		});
		if (json) return `${JSON.stringify(details)}\n`;
		return `${details.detail}\n`;
	}
	const details = new PermDockDeniedError({
		decision,
		permission: key,
		scope,
		resource,
		subject: subject ?? {
			principal: null,
			context: {}
		},
		message: deniedMessage(key, subject?.principal?.id, decision.denials, decision.alternatives.map((leaf) => leaf.key))
	}).toProblemDetails(compact({ instance: options.instance }));
	if (json) return `${JSON.stringify(details)}\n`;
	return `${details.detail}\n`;
}
//#endregion
//#region src/terminal/storage.ts
const FILE_MODE = 384;
const DIR_MODE = 448;
const GROUP_OR_WORLD = 63;
function credentialsPath(service, runtime) {
	if (runtime.configDir !== void 0) return path.join(runtime.configDir, "credentials.json");
	const home = runtime.homedir ?? homedir;
	const env = runtime.env ?? process.env;
	if ((runtime.platform ?? process.platform) === "win32") {
		const appData = env.APPDATA ?? path.join(home(), "AppData", "Roaming");
		return path.join(appData, service, "credentials.json");
	}
	const xdg = env.XDG_CONFIG_HOME ?? path.join(home(), ".config");
	return path.join(xdg, service, "credentials.json");
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseCredential(value) {
	if (!isRecord(value) || typeof value.access_token !== "string") return null;
	return compact({
		access_token: value.access_token,
		refresh_token: typeof value.refresh_token === "string" ? value.refresh_token : void 0,
		expires_at: typeof value.expires_at === "number" ? value.expires_at : void 0,
		token_type: typeof value.token_type === "string" ? value.token_type : void 0
	});
}
function readCredentials(service, profile, runtime) {
	const file = credentialsPath(service, runtime);
	let raw;
	try {
		const stat = statSync(file);
		if ((runtime.platform ?? process.platform) !== "win32" && (stat.mode & GROUP_OR_WORLD) !== 0) return null;
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed) || !isRecord(parsed.profiles)) return null;
		return parseCredential(parsed.profiles[profile]);
	} catch {
		return null;
	}
}
function writeCredentials(service, profile, credential, runtime) {
	const file = credentialsPath(service, runtime);
	mkdirSync(path.dirname(file), {
		recursive: true,
		mode: DIR_MODE
	});
	let profiles = {};
	try {
		const existing = JSON.parse(readFileSync(file, "utf8"));
		if (isRecord(existing) && isRecord(existing.profiles)) profiles = existing.profiles;
	} catch {
		profiles = {};
	}
	profiles[profile] = credential;
	writeFileSync(file, `${JSON.stringify({ profiles }, null, 2)}\n`, {
		encoding: "utf8",
		mode: FILE_MODE
	});
}
function deleteCredentials(service, profile, runtime) {
	const file = credentialsPath(service, runtime);
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return;
	}
	if (!isRecord(parsed) || !isRecord(parsed.profiles)) return;
	const profiles = {};
	for (const key of Object.keys(parsed.profiles)) if (key !== profile) profiles[key] = parsed.profiles[key];
	if (Object.keys(profiles).length === 0) {
		try {
			unlinkSync(file);
		} catch {}
		return;
	}
	writeFileSync(file, `${JSON.stringify({ profiles }, null, 2)}\n`, {
		encoding: "utf8",
		mode: FILE_MODE
	});
}
//#endregion
//#region src/terminal/token.ts
const JWT_PART = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
function looksLikeJwt(value) {
	return JWT_PART.test(value);
}
function warnJwtInArgv(argv, write) {
	for (const arg of argv) if (looksLikeJwt(arg)) {
		write("warning: a JWT-shaped value was found in argv; tokens must not be passed as flags\n");
		return;
	}
}
function profileFromArgv(argv) {
	const index = argv.indexOf("--as");
	if (index === -1) return;
	const next = argv[index + 1];
	return next === void 0 || next.startsWith("-") ? void 0 : next;
}
function sourceName(source) {
	if (typeof source === "string") return source;
	if ("source" in source) return source.source;
	return "env";
}
function envName(source, fallback) {
	if (typeof source === "string") return fallback;
	return source.env ?? fallback;
}
async function fromCiOidc(runtime) {
	const env = runtime.env ?? process.env;
	const fetchImpl = runtime.fetch ?? fetch;
	if (typeof env.CI_JOB_JWT_V2 === "string" && env.CI_JOB_JWT_V2 !== "") return env.CI_JOB_JWT_V2;
	if (typeof env.ACTIONS_ID_TOKEN_REQUEST_URL === "string" && typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === "string") try {
		const body = await (await fetchImpl(env.ACTIONS_ID_TOKEN_REQUEST_URL, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } })).json();
		if (body !== null && typeof body === "object" && "value" in body && typeof body.value === "string") return body.value;
	} catch {
		return null;
	}
	return null;
}
async function resolveToken(sources, options) {
	const walk = options.force === void 0 ? sources : [options.force];
	const now = options.runtime.now ?? (() => Math.floor(Date.now() / 1e3));
	for (const source of walk) {
		const name = sourceName(source);
		switch (name) {
			case "env": {
				const key = envName(source, "PERMDOCK_TOKEN");
				const value = (options.runtime.env ?? process.env)[key];
				if (typeof value === "string" && value !== "") return value;
				break;
			}
			case "keychain": {
				if (options.storage === void 0) break;
				const stored = readCredentials(options.storage.service, options.profile, options.runtime);
				if (stored === null) break;
				if (stored.expires_at !== void 0 && stored.expires_at <= now()) {
					if (options.device !== void 0) {
						const refreshed = await refreshCredential(options.device, stored, options.runtime);
						if (refreshed !== null) {
							writeCredentials(options.storage.service, options.profile, refreshed, options.runtime);
							return refreshed.access_token;
						}
					}
					break;
				}
				return stored.access_token;
			}
			case "ci-oidc": {
				const oidc = await fromCiOidc(options.runtime);
				if (oidc !== null) return oidc;
				break;
			}
			case "device": {
				if (options.device === void 0) break;
				const credential = await runDeviceFlow(options.device, options.runtime, options.write);
				if (credential === null) break;
				if (options.storage !== void 0) writeCredentials(options.storage.service, options.profile, credential, options.runtime);
				return credential.access_token;
			}
			default: return name;
		}
	}
	return null;
}
//#endregion
//#region src/terminal/create.ts
function writeOf(options) {
	return options.runtime?.write ?? ((text) => {
		process.stderr.write(text);
	});
}
function argvOf(options) {
	return options.runtime?.argv ?? process.argv;
}
function envOf(options) {
	return options.runtime?.env ?? process.env;
}
function isInteractive(options) {
	if (typeof options.interactive === "boolean") return options.interactive;
	if (options.interactive !== void 0) return true;
	return (options.runtime?.stdoutIsTTY ?? process.stdout.isTTY) === true && envOf(options).CI === void 0;
}
function jsonOutput(options) {
	if (options.output?.json !== void 0) return options.output.json;
	return argvOf(options).includes("--json");
}
function actorFromResolved(value) {
	if (value === null || value === void 0) return {};
	if (isSubject(value)) {
		const principal = value.principal;
		const actor = value.actor ?? (principal === null ? void 0 : {
			id: principal.id,
			kind: principal.kind ?? "oauth-client"
		});
		return compact({
			actor,
			delegation: value.delegation
		});
	}
	if (typeof value === "object" && value !== null && "id" in value && "kind" in value && typeof value.id === "string" && typeof value.kind === "string") return { actor: value };
	return {};
}
function resourceRef(permission, data) {
	if (data !== null && typeof data === "object" && "id" in data) {
		const id = data.id;
		if (typeof id === "string" || typeof id === "number") return {
			type: permission.resource,
			id: String(id)
		};
	}
	return { type: permission.resource };
}
function defaultConfirm(input) {
	const rl = createInterface({
		input: process.stdin,
		output: process.stderr
	});
	const id = input.resource.id === void 0 ? input.resource.type : `${input.resource.type} ${input.resource.id}`;
	return new Promise((resolve) => {
		rl.question(`${input.permission} on ${id} (${input.reason}). Continue? [y/N] `, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase() === "y");
		});
	});
}
function createPermDock(policy, options) {
	const write = writeOf(options);
	const exit = options.runtime?.exit ?? defaultExit;
	const runtime = compact({
		...options.runtime,
		configDir: options.runtime?.configDir ?? options.storage?.dir
	});
	warnJwtInArgv(argvOf(options), write);
	let cached;
	let last;
	let lastProfile = "default";
	const tokenFor = (profile, force) => (sources) => resolveToken(sources, compact({
		profile,
		storage: options.storage,
		device: options.device,
		runtime,
		write,
		force
	}));
	const resolve = async (resolveOptions = {}) => {
		const profile = resolveOptions.as ?? profileFromArgv(argvOf(options)) ?? "default";
		lastProfile = profile;
		const context = {
			token: tokenFor(profile, resolveOptions.source),
			profile
		};
		let user = null;
		try {
			user = await options.subject(context);
		} catch {
			user = null;
		}
		let actor;
		let delegation;
		if (options.actor !== void 0) try {
			const resolved = actorFromResolved(await options.actor(context));
			actor = resolved.actor;
			delegation = resolved.delegation;
		} catch {
			actor = void 0;
			delegation = void 0;
		}
		const built = await createPermDock$1(policy, user, compact({
			tenant: options.tenant,
			actor,
			delegation,
			memberships: options.memberships,
			customRoles: options.customRoles,
			sink: options.sink
		}));
		last = built;
		return built;
	};
	const permdock = (resolveOptions = {}) => {
		if (resolveOptions.refresh === true || cached === void 0) cached = resolve(resolveOptions);
		return cached;
	};
	const format = (decision, formatOptions = {}) => formatDecision(decision, compact({
		json: formatOptions.json ?? jsonOutput(options),
		permission: formatOptions.permission,
		instance: formatOptions.instance,
		subject: formatOptions.subject ?? last?.subject,
		approval: formatOptions.approval ?? options.approval
	}));
	const filterCommands = (entries, filterOptions) => {
		const next = filterOptions ?? { mode: "hide" };
		return filterCommandEntries(next.permdock ?? last, entries, next);
	};
	const protect = (permission, load) => (action) => async (...args) => {
		const instance = await permdock();
		let data;
		if (load !== void 0) data = await load(...args);
		const decide = instance.decide;
		const first = decide(permission, data, compact({
			source: "adapter",
			adapter: "terminal"
		}));
		if (first.outcome === "denied") {
			write(format(first, {
				permission,
				subject: instance.subject
			}));
			return exit(exitCode(first));
		}
		let granted;
		if (first.outcome === "granted") granted = first;
		else {
			if (!isInteractive(options)) {
				write(format(first, {
					permission,
					subject: instance.subject
				}));
				return exit(exitCode(first));
			}
			const confirm = typeof options.interactive === "object" ? options.interactive.confirm : defaultConfirm;
			const promptToken = first.token;
			if (!await confirm({
				permission: permission.key,
				resource: resourceRef(permission, data),
				reason: first.reason,
				token: promptToken
			})) {
				write(format({
					outcome: "denied",
					denials: [{
						role: null,
						reason: "approval"
					}],
					alternatives: []
				}, {
					permission,
					subject: instance.subject
				}));
				return exit(77);
			}
			const again = decide(permission, data, compact({
				source: "adapter",
				adapter: "terminal"
			}));
			if (again.outcome === "denied") {
				write(format(again, {
					permission,
					subject: instance.subject
				}));
				return exit(exitCode(again));
			}
			if (again.outcome === "granted") granted = again;
			else if (again.token === promptToken) {
				const principal = instance.subject.principal;
				if (principal === null) {
					write(format(again, {
						permission,
						subject: instance.subject
					}));
					return exit(77);
				}
				granted = {
					outcome: "granted",
					subject: {
						...instance.subject,
						principal
					},
					matched: again.grant,
					token: again.token
				};
			} else {
				write(format(again, {
					permission,
					subject: instance.subject
				}));
				return exit(77);
			}
		}
		return action({
			permdock: instance,
			data,
			decision: granted
		}, ...args);
	};
	const logout = async () => {
		if (options.storage === void 0) return;
		const stored = readCredentials(options.storage.service, lastProfile, runtime);
		if (stored !== null) await revokeCredential(options.device, stored, runtime);
		deleteCredentials(options.storage.service, lastProfile, runtime);
		cached = void 0;
		last = void 0;
	};
	return {
		permdock,
		protect,
		filterCommands,
		format,
		exitCode,
		logout
	};
}
//#endregion
export { EX_CONFIG, EX_NOPERM, EX_OK, EX_TEMPFAIL, TerminalExit, createPermDock, exitCode, formatDecision, looksLikeJwt };
