import { a as readPath } from "../paths-AH4M6YYV.js";
import { t as freezeDeep } from "../freeze-BF4IK5al.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { n as sha256, t as bytesToBase64Url } from "../sha256-CeSpVRME.js";
import { t as anonymousSubject } from "../subject-DgYVJ_Q0.js";
import { a as decodeHeader, i as loadJose, n as assertSubjectConfig, r as issuerFromDiscovery, t as joseTokenVerifier } from "../verifier-B6XyETqk.js";
//#region src/jwt/dpop.ts
const DPOP_WINDOW_SECONDS = 60;
function headerOf(request) {
	return request.headers.get("DPoP") ?? request.headers.get("dpop");
}
function requestUrl(request) {
	const url = new URL(request.url);
	url.hash = "";
	return url.href;
}
function verifyDpopProof(request, claims, accessToken) {
	return verify(request, claims, accessToken);
}
async function verify(request, claims, accessToken) {
	const proof = headerOf(request);
	if (proof === null || proof.length === 0) return {
		ok: false,
		cause: "dpop-proof-invalid"
	};
	const expectedJkt = claims.cnf !== null && typeof claims.cnf === "object" && !Array.isArray(claims.cnf) && typeof claims.cnf.jkt === "string" ? claims.cnf.jkt : void 0;
	if (expectedJkt === void 0) return {
		ok: false,
		cause: "dpop-proof-invalid"
	};
	const header = decodeHeader(proof);
	if (header?.typ?.toLowerCase() !== "dpop+jwt") return {
		ok: false,
		cause: "dpop-proof-invalid"
	};
	const jwk = header.jwk;
	if (jwk === null || typeof jwk !== "object" || Array.isArray(jwk)) return {
		ok: false,
		cause: "dpop-proof-invalid"
	};
	try {
		const jose = await loadJose();
		const key = await jose.importJWK(jwk, header.alg);
		const result = await jose.jwtVerify(proof, key, {
			typ: "dpop+jwt",
			maxTokenAge: DPOP_WINDOW_SECONDS
		});
		if (await jose.calculateJwkThumbprint(jwk, "sha256") !== expectedJkt) return {
			ok: false,
			cause: "dpop-proof-invalid"
		};
		const htm = result.payload.htm;
		const htu = result.payload.htu;
		if (htm !== request.method || htu !== requestUrl(request)) return {
			ok: false,
			cause: "dpop-proof-invalid"
		};
		if (accessToken !== void 0) {
			const ath = bytesToBase64Url(sha256(accessToken));
			if (result.payload.ath !== ath) return {
				ok: false,
				cause: "dpop-proof-invalid"
			};
		}
		return { ok: true };
	} catch {
		return {
			ok: false,
			cause: "dpop-proof-invalid"
		};
	}
}
//#endregion
//#region src/jwt/signer.ts
const SIGNING_ALGS = /* @__PURE__ */ new Set([
	"ES256",
	"PS256",
	"Ed25519",
	"RS256"
]);
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function publicJwk(key) {
	const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, k: _k, ...pub } = key;
	return pub;
}
function joseTokenSigner(options) {
	if (options.alg === "HS256" || options.alg === "EdDSA") throw new Error("PermDock: joseTokenSigner refuses HS* and polymorphic EdDSA on outputs.");
	if (!SIGNING_ALGS.has(options.alg)) throw new Error(`PermDock: unsupported signing alg '${options.alg}'.`);
	if (options.kid.length === 0) throw new Error("PermDock: joseTokenSigner requires kid.");
	const importKey = async () => {
		if (options.key instanceof Uint8Array) throw new TypeError("PermDock: HMAC keys cannot sign PermDock outputs.");
		return (await loadJose()).importJWK(options.key, options.alg);
	};
	return {
		kid: options.kid,
		sign(payload, signOptions) {
			return signJwt(payload, signOptions);
		},
		jwks() {
			if (isRecord(options.key)) return Promise.resolve({ keys: [publicJwk(options.key)] });
			return Promise.resolve({ keys: [] });
		}
	};
	async function signJwt(payload, signOptions) {
		const jose = await loadJose();
		const key = await importKey();
		const now = Math.floor(Date.now() / 1e3);
		const jwt = new jose.SignJWT({ ...payload });
		jwt.setProtectedHeader({
			alg: options.alg,
			kid: options.kid,
			typ: signOptions.typ
		});
		jwt.setIssuedAt(now);
		jwt.setJti(globalThis.crypto.randomUUID());
		if (options.issuer !== void 0) jwt.setIssuer(options.issuer);
		if (signOptions.audience !== void 0) jwt.setAudience(signOptions.audience);
		jwt.setExpirationTime(signOptions.expiresAt ?? now + 3600);
		return jwt.sign(key);
	}
}
//#endregion
//#region src/jwt/map-claims.ts
const DEFAULT_CLAIMS = {
	id: "sub",
	roles: "roles",
	groups: "groups",
	entitlements: "entitlements",
	session: "sid"
};
function asStringArray(value) {
	if (typeof value === "string") return value.length === 0 ? [] : value.split(/[,\s]+/u).filter(Boolean);
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (typeof item === "string") {
			out.push(item);
			continue;
		}
		if (item !== null && typeof item === "object" && "value" in item && typeof item.value === "string") out.push(item.value);
	}
	return out;
}
function kindOf(claims, paths) {
	const kind = paths?.kind;
	if (kind === "workload" || kind === "user" || kind === "service") return kind;
	if (kind !== void 0) {
		const value = readPath(claims, kind);
		if (value === "workload" || value === "user" || value === "service") return value;
	}
}
function assuranceOf(claims, paths) {
	const configured = paths?.assurance;
	const acrPath = typeof configured === "string" ? configured : configured?.acr ?? "acr";
	const amrPath = typeof configured === "string" ? "amr" : configured?.amr ?? "amr";
	const authTimePath = typeof configured === "string" ? "auth_time" : configured?.authTime ?? "auth_time";
	const acr = readPath(claims, acrPath);
	const amr = readPath(claims, amrPath);
	const authTime = readPath(claims, authTimePath);
	const assurance = compact({
		acr: typeof acr === "string" ? acr : void 0,
		amr: Array.isArray(amr) ? amr.filter((item) => typeof item === "string") : void 0,
		authTime: typeof authTime === "number" ? authTime : void 0
	});
	return Object.keys(assurance).length === 0 ? void 0 : assurance;
}
function bindingOf(claims) {
	const cnf = claims.cnf;
	if (cnf === null || typeof cnf !== "object" || Array.isArray(cnf)) return;
	const record = cnf;
	const binding = compact({
		jkt: typeof record.jkt === "string" ? record.jkt : void 0,
		"x5t#S256": typeof record["x5t#S256"] === "string" ? record["x5t#S256"] : void 0,
		jwk: record.jwk !== null && typeof record.jwk === "object" ? record.jwk : void 0,
		kid: typeof record.kid === "string" ? record.kid : void 0
	});
	return Object.keys(binding).length === 0 ? void 0 : binding;
}
function membershipsFromGroups(groups, groupRoles, tenant) {
	return groups.map((team) => compact({
		tenant,
		team,
		roles: groupRoles?.[team] ?? [],
		via: `group:${team}`
	}));
}
function membershipsFromClaim(value) {
	if (Array.isArray(value)) return value.flatMap((item) => membershipsFromClaim(item));
	if (value === null || typeof value !== "object") return [];
	const record = value;
	if (typeof record.tenant === "string" || typeof record.org_id === "string") return [compact({
		tenant: typeof record.tenant === "string" ? record.tenant : String(record.org_id),
		roles: asStringArray(record.roles),
		team: typeof record.team === "string" ? record.team : void 0
	})];
	const out = [];
	for (const [tenant, entry] of Object.entries(record)) {
		if (Array.isArray(entry)) {
			out.push(compact({
				tenant,
				roles: asStringArray(entry)
			}));
			continue;
		}
		if (entry !== null && typeof entry === "object") {
			const nested = entry;
			out.push(compact({
				tenant,
				roles: asStringArray(nested.roles ?? nested)
			}));
		}
	}
	return out;
}
function actorFromAct(claims, options) {
	const configured = options.actor;
	if (typeof configured === "function") {
		const actor = configured(claims);
		return actor === void 0 ? void 0 : {
			actor,
			chain: claims.act
		};
	}
	if (configured !== void 0 && configured.from !== "act") return;
	const act = claims.act;
	if (act === null || typeof act !== "object" || Array.isArray(act)) return;
	let current = act;
	let innermost = act;
	while (current !== null && typeof current === "object" && !Array.isArray(current) && "act" in current) {
		current = current.act;
		if (current !== null && typeof current === "object" && !Array.isArray(current)) innermost = current;
	}
	if (typeof innermost.sub !== "string") return;
	return {
		actor: compact({
			id: innermost.sub,
			kind: configured?.kind ?? "oauth-client"
		}),
		chain: act
	};
}
function delegationOf(claims, options, chain) {
	const paths = options.delegation;
	const scopes = asStringArray(readPath(claims, paths?.scopes ?? "scope"));
	const details = readPath(claims, paths?.authorizationDetails ?? "authorization_details");
	const access = readPath(claims, paths?.access ?? "access");
	const authorizationDetails = Array.isArray(details) ? details : void 0;
	const accessList = Array.isArray(access) ? access : void 0;
	const delegation = compact({
		scopes: scopes.length > 0 ? scopes : void 0,
		authorizationDetails,
		access: accessList,
		chain
	});
	return Object.keys(delegation).length === 0 ? void 0 : delegation;
}
function customClaims(claims, reserved) {
	const out = {};
	for (const [key, value] of Object.entries(claims)) {
		if (reserved.includes(key)) continue;
		out[key] = value;
	}
	return out;
}
function validateCustomClaims(claims, schema) {
	const result = schema["~standard"].validate(claims);
	if (result instanceof Promise) return { ok: false };
	if ("issues" in result && result.issues !== void 0) return { ok: false };
	return {
		ok: true,
		value: result.value
	};
}
function mapClaimsToSubject(claims, options) {
	const paths = options.claims;
	const idPath = paths?.id ?? DEFAULT_CLAIMS.id;
	const id = readPath(claims, idPath);
	if (typeof id !== "string" || id.length === 0) return {
		subject: anonymousSubject(),
		invalidClaims: false
	};
	const tenantPath = paths?.tenant;
	const tenant = tenantPath === void 0 ? void 0 : readPath(claims, tenantPath);
	const activeTenant = typeof tenant === "string" ? tenant : void 0;
	const roles = [...asStringArray(readPath(claims, paths?.roles ?? DEFAULT_CLAIMS.roles)), ...asStringArray(readPath(claims, paths?.entitlements ?? DEFAULT_CLAIMS.entitlements))];
	const groups = asStringArray(readPath(claims, paths?.groups ?? DEFAULT_CLAIMS.groups));
	const memberships = [...membershipsFromClaim(paths?.memberships === void 0 ? void 0 : readPath(claims, paths.memberships)), ...membershipsFromGroups(groups, options.groupRoles, activeTenant)];
	let extra = customClaims(claims, [
		"iss",
		"sub",
		"aud",
		"exp",
		"nbf",
		"iat",
		"jti",
		"client_id",
		"scope",
		"cnf",
		"act",
		"sid",
		"acr",
		"amr",
		"auth_time",
		"roles",
		"groups",
		"entitlements",
		"authorization_details",
		"access",
		"nonce",
		"azp"
	]);
	let invalidClaims = false;
	if (options.schema !== void 0) {
		const validated = validateCustomClaims(extra, options.schema);
		if (validated.ok) extra = validated.value;
		else {
			extra = {};
			invalidClaims = true;
		}
	}
	const binding = bindingOf(claims);
	const act = actorFromAct(claims, options);
	const principal = freezeDeep(compact({
		id,
		issuer: typeof claims.iss === "string" ? claims.iss : options.issuer,
		kind: kindOf(claims, paths),
		roles: roles.length > 0 ? roles : void 0,
		memberships: memberships.length > 0 ? memberships : void 0,
		tenant: activeTenant,
		assurance: assuranceOf(claims, paths),
		binding: act === void 0 ? binding : void 0,
		claims: Object.keys(extra).length === 0 ? void 0 : extra
	}));
	const actor = act === void 0 ? void 0 : freezeDeep(compact({
		...act.actor,
		binding
	}));
	const sessionPath = paths?.session ?? DEFAULT_CLAIMS.session;
	const sessionValue = readPath(claims, sessionPath);
	const sessionExpiry = claims.session_expiry;
	const exp = typeof claims.exp === "number" ? claims.exp : void 0;
	const expiresAt = typeof sessionExpiry === "number" && exp !== void 0 ? Math.min(exp, sessionExpiry) : exp;
	return {
		subject: freezeDeep(compact({
			principal,
			actor,
			delegation: options.accept === "id-token" ? void 0 : delegationOf(claims, options, act?.chain),
			context: {},
			session: typeof sessionValue === "string" ? sessionValue : void 0,
			expiresAt
		})),
		invalidClaims
	};
}
function acceptMismatch(claims, headerTyp, options, audience) {
	const accept = options.accept ?? "access-token";
	const typ = headerTyp?.toLowerCase();
	if (accept === "id-token") {
		if (typ !== void 0 && typ !== "jwt" && typ !== "application/jwt") return true;
		const aud = claims.aud;
		if ((Array.isArray(aud) ? aud : aud === void 0 ? [] : [aud]).length > 1 && claims.azp !== audience) return true;
		return false;
	}
	if (options.profile === "fapi2" && typ !== "at+jwt") return true;
	if (typeof claims.nonce === "string") return true;
	if (audience !== void 0 && typeof claims.aud === "string") {
		const expected = typeof audience === "string" ? audience : audience[0];
		if (claims.aud !== expected && typ !== "at+jwt") return true;
	}
	return false;
}
//#endregion
//#region src/jwt/subject.ts
function emitAuth(options, cause, token) {
	if (options.onAuth === void 0) return;
	const header = token === void 0 ? void 0 : decodeHeader(token);
	options.onAuth(compact({
		reason: "invalid-token",
		cause,
		source: "jwt",
		kid: header?.kid,
		alg: header?.alg,
		typ: header?.typ,
		issuer: options.issuer,
		requestId: options.requestId
	}));
}
function tokenInQuery(request) {
	if (request === void 0) return false;
	return new URL(request.url, "https://permdock.invalid").searchParams.has("access_token");
}
function mtlsThumbprint(claims) {
	const cnf = claims.cnf;
	if (cnf === null || typeof cnf !== "object" || Array.isArray(cnf)) return;
	const value = cnf["x5t#S256"];
	return typeof value === "string" ? value : void 0;
}
async function extraMemberships(options, subject, tenant) {
	if (options.memberships === void 0 || subject.principal === null) return subject;
	try {
		const extra = await options.memberships.membershipsFor(compact({
			id: subject.principal.id,
			kind: subject.principal.kind
		}), compact({ tenant }));
		if (extra.length === 0) return subject;
		const merged = [...subject.principal.memberships ?? [], ...extra];
		return freezeDeep({
			...subject,
			principal: {
				...subject.principal,
				memberships: merged
			}
		});
	} catch {
		return subject;
	}
}
function subjectFromJwt(token, options, request) {
	return resolveSubject(token, options, request);
}
function createJwtSubjectResolver(options) {
	assertSubjectConfig(options);
	const verifier = options.verifier ?? joseTokenVerifier(options);
	return (token, request) => resolveSubject(token, {
		...options,
		verifier
	}, request);
}
async function resolveSubject(token, options, request) {
	if (options.verifier === void 0) assertSubjectConfig(options);
	if (token === void 0 || token === null || token.length === 0) return anonymousSubject();
	if (options.profile === "fapi2" && tokenInQuery(request)) {
		emitAuth(options, "token-in-query", token);
		return anonymousSubject();
	}
	const verifier = options.verifier ?? joseTokenVerifier(options);
	const issuer = options.issuer ?? (options.discovery === void 0 ? void 0 : issuerFromDiscovery(options.discovery));
	const verified = await verifier.verify(token, compact({
		audience: options.audience,
		issuer,
		clockTolerance: options.clockTolerance,
		typ: options.accept === "id-token" ? ["JWT"] : options.profile === "fapi2" ? "at+jwt" : ["at+jwt", "JWT"]
	}));
	if (!verified.ok) {
		emitAuth(options, verified.cause, token);
		return anonymousSubject();
	}
	if (acceptMismatch(verified.claims, verified.header.typ, options, options.audience)) {
		emitAuth(options, "wrong-token-type", token);
		return anonymousSubject();
	}
	const sender = options.sender ?? (options.profile === "fapi2" ? "dpop" : "none");
	const cnf = verified.claims.cnf;
	const hasCnf = cnf !== null && typeof cnf === "object";
	if (options.profile === "fapi2" && !hasCnf) {
		emitAuth(options, "sender-constraint-required", token);
		return anonymousSubject();
	}
	if (sender === "dpop" && request !== void 0) {
		const proof = await verifyDpopProof(request, verified.claims, token);
		if (!proof.ok) {
			emitAuth(options, proof.cause, token);
			return anonymousSubject();
		}
	}
	if (sender === "mtls") {
		const expected = options.certificateThumbprint;
		const seen = mtlsThumbprint(verified.claims);
		if (expected === void 0 || seen !== expected) {
			emitAuth(options, "mtls-binding-mismatch", token);
			return anonymousSubject();
		}
	}
	const mapped = mapClaimsToSubject(verified.claims, options);
	if (mapped.subject.principal === null) {
		emitAuth(options, "invalid-claims", token);
		return anonymousSubject();
	}
	if (mapped.invalidClaims) emitAuth(options, "invalid-claims", token);
	return extraMemberships(options, mapped.subject, mapped.subject.principal.tenant);
}
//#endregion
export { createJwtSubjectResolver, joseTokenSigner, joseTokenVerifier, subjectFromJwt, verifyDpopProof };
