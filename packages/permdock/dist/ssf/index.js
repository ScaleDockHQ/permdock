import { t as compact } from "../compact-CxSqQNw0.js";
import { t as joseTokenVerifier } from "../verifier-B6XyETqk.js";
//#region src/ssf/events.ts
const BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
const CAEP_PREFIX = "https://schemas.openid.net/secevent/caep/event-type/";
const CAEP_NAMES = /* @__PURE__ */ new Set([
	"session-revoked",
	"credential-change",
	"assurance-level-change",
	"token-claims-change",
	"device-compliance-change"
]);
function caepName(uri) {
	if (!uri.startsWith(CAEP_PREFIX)) return;
	const name = uri.slice(52);
	if (CAEP_NAMES.has(name)) return name;
}
//#endregion
//#region src/ssf/receiver.ts
const SET_TYP = "secevent+jwt";
const LOGOUT_TYP = "logout+jwt";
const SET_CONTENT = "application/secevent+jwt";
const LOGOUT_CONTENT = "application/x-www-form-urlencoded";
function jsonResponse(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" }
	});
}
function rfc8935(status, err, description) {
	return jsonResponse(status, {
		err,
		description
	});
}
function errForCause(cause) {
	switch (cause) {
		case "invalid-signature":
		case "unknown-kid":
		case "alg-not-allowed":
		case "alg-none": return "invalid_key";
		case "wrong-issuer": return "invalid_issuer";
		case "wrong-audience": return "invalid_audience";
		case "expired":
		case "not-yet-valid":
		case "wrong-token-type":
		case "malformed":
		case "encrypted-token":
		case "dpop-proof-invalid":
		case "mtls-binding-mismatch":
		case "sender-constraint-required":
		case "token-in-query":
		case "invalid-claims":
		case "invalid-chain":
		case "jwks-unavailable":
		case "discovery-unavailable":
		case "discovery-mismatch": return "invalid_request";
		default: return cause;
	}
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function contentType(request) {
	return (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}
function parseEvery(every) {
	if (typeof every === "number") {
		if (!Number.isFinite(every) || every <= 0) throw new TypeError("PermDock: poll every must be a positive interval.");
		return every;
	}
	const match = /^(\d+)(ms|s|m)$/u.exec(every);
	if (match === null || match[2] === void 0) throw new TypeError(`PermDock: invalid poll interval '${every}'.`);
	const n = Number(match[1]);
	const unit = match[2];
	if (unit !== "ms" && unit !== "s" && unit !== "m") throw new TypeError(`PermDock: invalid poll interval '${every}'.`);
	switch (unit) {
		case "ms": return n;
		case "s": return n * 1e3;
		case "m": return n * 6e4;
		default: return unit;
	}
}
function asSubject(mapped, session, issuer) {
	if (typeof mapped === "string") return compact({
		id: mapped,
		session,
		issuer
	});
	return compact({
		id: mapped.id,
		session: mapped.session ?? session,
		issuer: mapped.issuer ?? issuer
	});
}
function setSubjectFromClaims(claims) {
	const subId = claims.sub_id;
	if (isRecord(subId) && typeof subId.format === "string") return subId;
	if (typeof claims.sub === "string" && claims.sub.length > 0) return compact({
		format: "iss_sub",
		iss: typeof claims.iss === "string" ? claims.iss : void 0,
		sub: claims.sub
	});
}
function eventTimestamp(payload) {
	const value = payload.event_timestamp;
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function eventSession(payload) {
	if (typeof payload.session === "string" && payload.session.length > 0) return payload.session;
	if (typeof payload.sid === "string" && payload.sid.length > 0) return payload.sid;
}
function createReceiver(config) {
	const listeners = /* @__PURE__ */ new Set();
	function emit(event) {
		const next = compact(event);
		for (const listener of listeners) listener(next);
	}
	async function verify(token, typ) {
		const result = await config.verifier.verify(token, compact({
			typ,
			issuer: config.issuer,
			audience: config.audience,
			clockTolerance: config.clockTolerance
		}));
		if (!result.ok) return {
			ok: false,
			err: errForCause(result.cause),
			description: result.cause,
			cause: result.cause
		};
		if (typeof result.claims.jti !== "string" || result.claims.jti.length === 0) return {
			ok: false,
			err: "invalid_request",
			description: "missing jti",
			cause: "invalid-claims"
		};
		if (typeof result.claims.iat !== "number") return {
			ok: false,
			err: "invalid_request",
			description: "missing iat",
			cause: "invalid-claims"
		};
		return result;
	}
	async function resolveSubject(setSubject, session, issuer) {
		const mapped = await config.subject(setSubject, compact({
			session,
			issuer
		}));
		if (mapped === null || mapped === void 0) return;
		if (typeof mapped === "string" && mapped.length === 0) return;
		if (typeof mapped !== "string" && mapped.id.length === 0) return;
		return asSubject(mapped, session, issuer);
	}
	async function dispatch(type, input) {
		const named = config.onEvent[type];
		const wildcard = config.onEvent["*"];
		const handler = named ?? wildcard;
		if (handler === void 0) {
			emit({
				type,
				subject: input.subject,
				transmitter: input.subject.issuer,
				jti: input.jti,
				unknown: "event"
			});
			return { ok: true };
		}
		try {
			await handler(input);
		} catch {
			return {
				ok: false,
				err: "invalid_request",
				description: "handler failed"
			};
		}
		emit({
			type,
			subject: input.subject,
			transmitter: input.subject.issuer,
			jti: input.jti
		});
		return { ok: true };
	}
	async function dispatchEvents(entries, issuer, jti, baseSubject) {
		const [head, ...tail] = entries;
		if (head === void 0) return { ok: true };
		const [uri, raw] = head;
		const payload = isRecord(raw) ? raw : {};
		const type = caepName(uri) ?? uri;
		const session = eventSession(payload);
		if (caepName(uri) === void 0 && config.onEvent["*"] === void 0) {
			emit({
				type,
				transmitter: issuer,
				jti,
				unknown: "event"
			});
			return dispatchEvents(tail, issuer, jti, baseSubject);
		}
		const subject = await resolveSubject(baseSubject ?? {
			format: "opaque",
			id: session ?? jti
		}, session, issuer);
		if (subject === void 0) {
			emit({
				type,
				transmitter: issuer,
				jti,
				unknown: "subject"
			});
			return dispatchEvents(tail, issuer, jti, baseSubject);
		}
		const result = await dispatch(type, compact({
			subject,
			event: payload,
			event_timestamp: eventTimestamp(payload),
			jti,
			type
		}));
		if (!result.ok) return result;
		return dispatchEvents(tail, issuer, jti, baseSubject);
	}
	async function ingestSet(token) {
		const verified = await verify(token, SET_TYP);
		if (!verified.ok) {
			emit({
				type: "verification-failed",
				err: verified.err,
				cause: verified.cause
			});
			return verified;
		}
		const jti = verified.claims.jti;
		if (await config.replay.seen(jti)) {
			emit({
				type: "replay",
				transmitter: typeof verified.claims.iss === "string" ? verified.claims.iss : void 0,
				jti,
				replayed: true
			});
			return { ok: true };
		}
		const events = verified.claims.events;
		if (!isRecord(events)) return {
			ok: false,
			err: "invalid_request",
			description: "missing events",
			cause: "invalid-claims"
		};
		const issuer = typeof verified.claims.iss === "string" ? verified.claims.iss : void 0;
		const baseSubject = setSubjectFromClaims(verified.claims);
		const dispatched = await dispatchEvents(Object.entries(events), issuer, jti, baseSubject);
		if (!dispatched.ok) return dispatched;
		await config.replay.remember(jti);
		return { ok: true };
	}
	async function ingestLogout(token) {
		const verified = await verify(token, LOGOUT_TYP);
		if (!verified.ok) {
			emit({
				type: "verification-failed",
				err: verified.err,
				cause: verified.cause
			});
			return {
				ok: false,
				err: "invalid_request",
				description: verified.description
			};
		}
		if (verified.claims.nonce !== void 0) return {
			ok: false,
			err: "invalid_request",
			description: "nonce must be absent",
			cause: "invalid-claims"
		};
		const events = verified.claims.events;
		if (!isRecord(events) || !("http://schemas.openid.net/event/backchannel-logout" in events)) return {
			ok: false,
			err: "invalid_request",
			description: "missing backchannel-logout event",
			cause: "invalid-claims"
		};
		const sub = typeof verified.claims.sub === "string" ? verified.claims.sub : void 0;
		const sid = typeof verified.claims.sid === "string" ? verified.claims.sid : void 0;
		if ((sub === void 0 || sub.length === 0) && (sid === void 0 || sid.length === 0)) return {
			ok: false,
			err: "invalid_request",
			description: "sub or sid required",
			cause: "invalid-claims"
		};
		const jti = verified.claims.jti;
		if (await config.replay.seen(jti)) {
			emit({
				type: "replay",
				jti,
				replayed: true
			});
			return { ok: true };
		}
		const issuer = typeof verified.claims.iss === "string" ? verified.claims.iss : void 0;
		const subject = await resolveSubject(sub === void 0 ? compact({
			format: "opaque",
			id: sid
		}) : compact({
			format: "iss_sub",
			iss: issuer,
			sub
		}), sid, issuer);
		if (subject === void 0) {
			emit({
				type: "session-revoked",
				transmitter: issuer,
				jti,
				unknown: "subject"
			});
			await config.replay.remember(jti);
			return { ok: true };
		}
		const payload = isRecord(events["http://schemas.openid.net/event/backchannel-logout"]) ? events[BACKCHANNEL_LOGOUT_EVENT] : {};
		const dispatched = await dispatch("session-revoked", compact({
			subject,
			event: payload,
			event_timestamp: eventTimestamp(payload),
			jti,
			type: "session-revoked"
		}));
		if (!dispatched.ok) return dispatched;
		await config.replay.remember(jti);
		return { ok: true };
	}
	async function pollOnce(options, acks) {
		const fetchFn = options.fetch ?? globalThis.fetch;
		const headers = { "content-type": "application/json" };
		if (options.token !== void 0) headers.authorization = `Bearer ${options.token}`;
		const body = {
			maxEvents: 100,
			returnImmediately: true
		};
		if (acks.length > 0) body.acks = acks;
		const requestInit = compact({
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: options.signal
		});
		const response = await fetchFn(options.endpoint, requestInit);
		if (!response.ok) {
			emit({
				type: "poll-failed",
				err: "connection_failed"
			});
			return [];
		}
		const parsed = await response.json();
		if (!isRecord(parsed) || !isRecord(parsed.sets)) return [];
		const tokens = Object.entries(parsed.sets).flatMap(([jti, jwt]) => typeof jwt === "string" ? [{
			jti,
			jwt
		}] : []);
		const processed = (await Promise.all(tokens.map(async ({ jti, jwt }) => ({
			jti,
			ok: (await ingestSet(jwt)).ok
		})))).flatMap((row) => row.ok ? [row.jti] : []);
		if (processed.length > 0) await fetchFn(options.endpoint, compact({
			method: "POST",
			headers,
			body: JSON.stringify({
				acks: processed,
				maxEvents: 0,
				returnImmediately: true
			}),
			signal: options.signal
		}));
		return processed;
	}
	return {
		async push(request) {
			if (request.method !== "POST") return rfc8935(400, "invalid_request", "POST required");
			if (contentType(request) !== SET_CONTENT) return rfc8935(400, "invalid_request", "application/secevent+jwt required");
			const token = (await request.text()).trim();
			if (token.length === 0) return rfc8935(400, "invalid_request", "empty body");
			const result = await ingestSet(token);
			if (!result.ok) return rfc8935(400, result.err, result.description);
			return new Response(null, { status: 202 });
		},
		async logout(request) {
			if (request.method !== "POST") return jsonResponse(400, { error: "invalid_request" });
			if (contentType(request) !== LOGOUT_CONTENT) return jsonResponse(400, { error: "invalid_request" });
			const token = new URLSearchParams(await request.text()).get("logout_token");
			if (token === null || token.length === 0) return jsonResponse(400, { error: "invalid_request" });
			if (!(await ingestLogout(token)).ok) return jsonResponse(400, { error: "invalid_request" });
			return new Response(null, { status: 200 });
		},
		poll(options) {
			if (options.every === void 0) return pollOnce(options, []).then((acked) => ({ acked }));
			const ms = parseEvery(options.every);
			let timer;
			const tick = () => {
				pollOnce(options, []).catch(() => {
					emit({
						type: "poll-failed",
						err: "connection_failed"
					});
				});
			};
			tick();
			timer = setInterval(tick, ms);
			return { stop() {
				if (timer !== void 0) {
					clearInterval(timer);
					timer = void 0;
				}
			} };
		},
		on(event, handler) {
			if (event !== "event") return event;
			listeners.add(handler);
			return () => {
				listeners.delete(handler);
			};
		}
	};
}
//#endregion
//#region src/ssf/replay.ts
function memoryReplayStore() {
	const seen = /* @__PURE__ */ new Set();
	return {
		seen(jti) {
			return seen.has(jti);
		},
		remember(jti) {
			seen.add(jti);
		}
	};
}
//#endregion
//#region src/ssf/create.ts
function createPermDock(policy, options) {
	if (typeof options.subject !== "function") throw new TypeError("PermDock: permdock/ssf requires subject.");
	if (options.audience === void 0) throw new TypeError("PermDock: permdock/ssf requires audience.");
	if (options.verifier === void 0 && options.jwks === void 0 && options.discovery === void 0) throw new TypeError("PermDock: permdock/ssf requires verifier, jwks, or discovery.");
	if (options.issuer === void 0 && options.discovery === void 0) throw new TypeError("PermDock: permdock/ssf requires issuer or discovery.");
	const jwks = typeof options.jwks === "string" ? new URL(options.jwks) : options.jwks;
	const verifier = options.verifier ?? joseTokenVerifier(compact({
		jwks,
		discovery: options.discovery,
		issuer: options.issuer,
		audience: options.audience,
		clockTolerance: options.clockTolerance
	}));
	return { receiver: createReceiver(compact({
		verifier,
		issuer: options.issuer,
		audience: options.audience,
		subject: options.subject,
		onEvent: options.onEvent ?? {},
		replay: options.replay ?? memoryReplayStore(),
		clockTolerance: options.clockTolerance
	})) };
}
//#endregion
export { createPermDock, memoryReplayStore };
