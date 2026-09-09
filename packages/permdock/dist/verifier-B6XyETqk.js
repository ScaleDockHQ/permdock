import { n as isForbiddenKey, o as splitPath } from "./paths-AH4M6YYV.js";
import { t as compact } from "./compact-CxSqQNw0.js";
//#region src/jwt/header.ts
function compactParts(token) {
	return token.split(".");
}
function isJwe(token) {
	return compactParts(token).length === 5;
}
function decodeHeader(token) {
	const [encoded] = compactParts(token);
	if (encoded === void 0 || encoded.length === 0) return;
	try {
		const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
		const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - padded.length % 4);
		const json = atob(`${padded}${pad}`);
		const value = JSON.parse(json);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return;
		return value;
	} catch {
		return;
	}
}
function unknownCrit(header) {
	const crit = header.crit;
	if (crit === void 0) return false;
	if (!Array.isArray(crit)) return true;
	const understood = /* @__PURE__ */ new Set([
		"alg",
		"kid",
		"typ",
		"cty",
		"enc"
	]);
	return crit.some((name) => !understood.has(name));
}
function normalizeTyp(typ) {
	if (typ === void 0) return;
	const lower = typ.toLowerCase();
	return lower.startsWith("application/") ? lower.slice(12) : lower;
}
//#endregion
//#region src/jwt/load-jose.ts
let cached;
function loadJose() {
	cached ??= import("jose").catch((cause) => {
		cached = void 0;
		throw new Error("PermDock: permdock/jwt requires the optional peer \"jose\".", { cause });
	});
	return cached;
}
//#endregion
//#region src/jwt/config.ts
const DEFAULT_ALGORITHMS = [
	"ES256",
	"PS256",
	"Ed25519",
	"RS256"
];
const FAPI2_ALGORITHMS = [
	"ES256",
	"PS256",
	"Ed25519"
];
const DEFAULT_DECRYPTION_ALGS = [
	"RSA-OAEP-256",
	"ECDH-ES",
	"ECDH-ES+A256KW",
	"dir"
];
function fail(cause) {
	return {
		ok: false,
		reason: "invalid-token",
		cause
	};
}
function isSecretJwks(jwks) {
	return typeof jwks === "object" && jwks !== null && !(jwks instanceof URL) && "secret" in jwks;
}
function isKeySet(jwks) {
	return typeof jwks === "object" && jwks !== null && !(jwks instanceof URL) && "keys" in jwks && Array.isArray(jwks.keys);
}
function issuerFromDiscovery(discovery) {
	return typeof discovery === "string" ? discovery : discovery.issuer;
}
function resolveAlgorithms(options) {
	if (options.algorithms !== void 0) return options.algorithms;
	return options.profile === "fapi2" ? FAPI2_ALGORITHMS : DEFAULT_ALGORITHMS;
}
function resolveClockTolerance(options, override) {
	const configured = override ?? options.clockTolerance ?? 5;
	if (options.profile === "fapi2") return Math.min(configured, 5);
	return configured;
}
function assertSafeClaimPaths(claims) {
	if (claims === void 0) return;
	const paths = [
		claims.id,
		claims.roles,
		claims.groups,
		claims.entitlements,
		claims.tenant,
		claims.memberships,
		claims.session
	].filter((path) => path !== void 0);
	if (typeof claims.assurance === "string") paths.push(claims.assurance);
	else if (claims.assurance !== void 0) paths.push(...[
		claims.assurance.acr,
		claims.assurance.amr,
		claims.assurance.authTime
	].filter((path) => path !== void 0));
	if (claims.kind !== void 0 && claims.kind !== "workload" && claims.kind !== "user" && claims.kind !== "service") paths.push(claims.kind);
	for (const path of paths) for (const segment of splitPath(path)) if (isForbiddenKey(segment)) throw new Error(`PermDock: forbidden claim path '${path}'.`);
}
function assertVerifierConfig(options) {
	if (options.discovery !== void 0 && options.jwks !== void 0) throw new Error("PermDock: discovery and jwks are mutually exclusive.");
	if (options.discovery === void 0 && options.jwks === void 0) throw new Error("PermDock: joseTokenVerifier requires jwks or discovery.");
	if (options.discovery !== void 0) {
		const issuer = issuerFromDiscovery(options.discovery);
		let url;
		try {
			url = new URL(issuer);
		} catch {
			throw new Error("PermDock: discovery issuer must be an absolute URL.");
		}
		if (url.protocol !== "https:") throw new Error("PermDock: discovery issuer must use https.");
		if (options.issuer !== void 0 && options.issuer !== issuer) throw new Error("PermDock: issuer must match discovery or be omitted.");
	}
	if (options.jwks !== void 0 && isSecretJwks(options.jwks)) {
		if (secretBits(options.jwks.secret) < 256) throw new Error("PermDock: HMAC secret must be at least 256 bits.");
	}
	if (resolveAlgorithms(options).includes("none")) throw new Error("PermDock: alg none is never accepted.");
}
function assertSubjectConfig(options) {
	if (options.verifier === void 0) {
		assertVerifierConfig(options);
		if (options.jwks !== void 0 && isKeySet(options.jwks) && options.issuer === void 0) throw new Error("PermDock: issuer is required with jwks.");
	}
	assertSafeClaimPaths(options.claims);
	if (options.profile === "fapi2" && options.sender === "none") throw new Error("PermDock: profile 'fapi2' requires a sender constraint.");
}
function secretBits(secret) {
	if (typeof secret === "string") return secret.length * 8;
	return secret.byteLength * 8;
}
function secretBytes(secret) {
	if (typeof secret === "string") return new TextEncoder().encode(secret);
	return secret;
}
//#endregion
//#region src/jwt/cache.ts
function clampTtl(seconds, minTtl, maxTtl) {
	return Math.min(maxTtl, Math.max(minTtl, seconds));
}
function cacheControlMaxAge(header) {
	if (header === null) return;
	const match = /max-age=(\d+)/iu.exec(header);
	if (match?.[1] === void 0) return;
	return Math.trunc(Number(match[1]));
}
function discoveryUrls(issuer) {
	const url = new URL(issuer);
	const oidc = new URL("/.well-known/openid-configuration", url.origin);
	if (url.pathname !== "/" && url.pathname !== "") oidc.pathname = `${url.pathname.replace(/\/$/u, "")}/.well-known/openid-configuration`;
	const rfc8414 = new URL(url.href);
	rfc8414.pathname = `/.well-known/oauth-authorization-server${url.pathname === "/" ? "" : url.pathname.replace(/\/$/u, "")}`;
	return [oidc.href, rfc8414.href];
}
function createKeyCache(options) {
	const minTtl = options.jwksCache?.minTtl ?? 60;
	const maxTtl = options.jwksCache?.maxTtl ?? 3600;
	const cooldown = options.jwksCache?.cooldown ?? 60;
	const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
	let discoveryCache;
	let jwksCache;
	let cooldownUntil = 0;
	let discoveryCause;
	const readDiscovery = async (href, issuer, now) => {
		try {
			const response = await fetchImpl(href, { headers: { accept: "application/json" } });
			if (!response.ok) return;
			const body = await response.json();
			if (body.issuer !== issuer) {
				discoveryCause = "discovery-mismatch";
				return {
					ok: false,
					cause: "discovery-mismatch"
				};
			}
			if (typeof body.jwks_uri !== "string") return;
			const ttl = clampTtl(cacheControlMaxAge(response.headers.get("cache-control")) ?? maxTtl, minTtl, maxTtl);
			discoveryCache = {
				value: {
					issuer: body.issuer,
					jwks_uri: body.jwks_uri
				},
				expiresAt: now + ttl
			};
			discoveryCause = void 0;
			return {
				ok: true,
				...discoveryCache.value
			};
		} catch {
			return;
		}
	};
	const loadDiscovery = async (discovery, now) => {
		if (typeof discovery !== "string" && discovery.metadata?.jwks_uri !== void 0) {
			const issuer = issuerFromDiscovery(discovery);
			if (discovery.metadata.issuer !== void 0 && discovery.metadata.issuer !== issuer) {
				discoveryCause = "discovery-mismatch";
				return {
					ok: false,
					cause: "discovery-mismatch"
				};
			}
			return {
				ok: true,
				issuer,
				jwks_uri: discovery.metadata.jwks_uri
			};
		}
		if (discoveryCache !== void 0 && discoveryCache.expiresAt > now) return {
			ok: true,
			...discoveryCache.value
		};
		const issuer = issuerFromDiscovery(discovery);
		const [oidc, rfc8414] = discoveryUrls(issuer);
		const fromOidc = oidc === void 0 ? void 0 : await readDiscovery(oidc, issuer, now);
		if (fromOidc !== void 0) return fromOidc;
		const fromRfc8414 = rfc8414 === void 0 ? void 0 : await readDiscovery(rfc8414, issuer, now);
		if (fromRfc8414 !== void 0) return fromRfc8414;
		if (discoveryCache !== void 0) return {
			ok: true,
			...discoveryCache.value
		};
		return {
			ok: false,
			cause: discoveryCause ?? "discovery-unavailable"
		};
	};
	const loadJwks = async (href, now, force) => {
		if (!force && jwksCache !== void 0 && jwksCache.expiresAt > now) return {
			ok: true,
			jwks: jwksCache.value
		};
		try {
			const response = await fetchImpl(href, { headers: { accept: "application/jwk-set+json, application/json" } });
			if (!response.ok) throw new Error("jwks fetch failed");
			const body = await response.json();
			if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("empty jwks");
			jwksCache = {
				value: body,
				expiresAt: now + clampTtl(cacheControlMaxAge(response.headers.get("cache-control")) ?? maxTtl, minTtl, maxTtl)
			};
			return {
				ok: true,
				jwks: body
			};
		} catch {
			if (jwksCache !== void 0 && jwksCache.expiresAt > now) return {
				ok: true,
				jwks: jwksCache.value
			};
			return {
				ok: false,
				cause: "jwks-unavailable"
			};
		}
	};
	const resolve = async (force, nowInput) => {
		const now = nowInput ?? Math.floor(Date.now() / 1e3);
		if (options.jwks instanceof URL) return loadJwks(options.jwks.href, now, force);
		if (options.jwks !== void 0 && typeof options.jwks === "object" && "keys" in options.jwks) return {
			ok: true,
			jwks: options.jwks
		};
		if (options.discovery === void 0) return {
			ok: false,
			cause: "jwks-unavailable"
		};
		const discovered = await loadDiscovery(options.discovery, now);
		if (!discovered.ok) return discovered;
		return loadJwks(discovered.jwks_uri, now, force);
	};
	return {
		resolveJwks(now) {
			return resolve(false, now);
		},
		refetchJwks(now) {
			const current = now ?? Math.floor(Date.now() / 1e3);
			if (current < cooldownUntil) return resolve(false, current);
			cooldownUntil = current + cooldown;
			return resolve(true, current);
		}
	};
}
//#endregion
//#region src/jwt/verifier.ts
const ACCESS_TYPS = /* @__PURE__ */ new Set(["at+jwt", "jwt"]);
const FAPI2_TYPS = /* @__PURE__ */ new Set(["at+jwt"]);
function algorithmAllowed(alg, allowed, key) {
	if (alg === "none") return false;
	if (alg === "EdDSA") return allowed.includes("Ed25519") && key?.kty === "OKP" && key.crv === "Ed25519";
	return allowed.includes(alg);
}
function findKey(keys, kid, profile) {
	const usable = keys.filter((key) => !skipUndersized(key, profile));
	if (kid === void 0) return usable.length === 1 ? usable[0] : void 0;
	return usable.find((key) => key.kid === kid);
}
function skipUndersized(key, profile) {
	if (profile !== "fapi2") return false;
	if (key.kty === "RSA" && typeof key.n === "string") return Math.floor(key.n.length * 6 / 8) * 8 < 2048;
	if (key.kty === "EC" && key.crv === "P-192") return true;
	return false;
}
function typAccepted(headerTyp, expected, profile) {
	const seen = normalizeTyp(headerTyp);
	if (expected !== void 0) return (typeof expected === "string" ? [expected] : expected).some((item) => normalizeTyp(item) === seen);
	if (profile === "fapi2") return seen !== void 0 && FAPI2_TYPS.has(seen.toLowerCase());
	if (seen === void 0) return true;
	return ACCESS_TYPS.has(seen.toLowerCase());
}
function mapJoseCause(error) {
	if (typeof error !== "object" || error === null || !("code" in error)) return "invalid-signature";
	const code = String(error.code);
	if (code === "ERR_JWT_EXPIRED") return "expired";
	if (code === "ERR_JWKS_NO_MATCHING_KEY") return "unknown-kid";
	if (code === "ERR_JOSE_ALG_NOT_ALLOWED" || code === "ERR_JWS_ALG_NOT_ALLOWED") return "alg-not-allowed";
	if (code === "ERR_JWE_INVALID" || code === "ERR_JWE_NOT_SUPPORTED") return "encrypted-token";
	if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
		const claim = error.claim;
		if (claim === "aud") return "wrong-audience";
		if (claim === "iss") return "wrong-issuer";
		if (claim === "nbf" || claim === "iat") return "not-yet-valid";
		if (claim === "typ") return "wrong-token-type";
		return "malformed";
	}
	if (code === "ERR_JWS_INVALID" || code === "ERR_JWT_INVALID") return "malformed";
	return "invalid-signature";
}
function joseTokenVerifier(options) {
	assertVerifierConfig(options);
	const algorithms = resolveAlgorithms(options);
	const cache = options.jwks !== void 0 && isSecretJwks(options.jwks) ? void 0 : createKeyCache(options);
	const issuer = options.issuer;
	const verifyInner = async (token, expectations, keys, header) => {
		const jose = await loadJose();
		const alg = header?.alg ?? "";
		const key = keys instanceof Uint8Array ? void 0 : findKey(keys, header?.kid, options.profile);
		if (!(keys instanceof Uint8Array) && key === void 0) return fail("unknown-kid");
		if (!algorithmAllowed(alg, algorithms, key)) return fail(alg === "none" ? "alg-none" : "alg-not-allowed");
		const expectedTyp = expectations.typ ?? options.typ;
		if (!typAccepted(header?.typ, expectedTyp, options.profile)) return fail("wrong-token-type");
		const verifyAlgs = algorithms.includes("Ed25519") ? [...algorithms, "EdDSA"] : [...algorithms];
		try {
			const getKey = keys instanceof Uint8Array ? keys : jose.createLocalJWKSet({ keys });
			const result = await jose.jwtVerify(token, getKey, compact({
				algorithms: verifyAlgs,
				issuer: expectations.issuer ?? issuer,
				audience: expectations.audience ?? options.audience,
				clockTolerance: resolveClockTolerance(options, expectations.clockTolerance),
				requiredClaims: ["exp"]
			}));
			const claims = result.payload;
			if (typeof claims.exp !== "number") return fail("expired");
			return {
				ok: true,
				claims,
				header: compact({
					alg: String(result.protectedHeader.alg ?? alg),
					kid: typeof result.protectedHeader.kid === "string" ? result.protectedHeader.kid : header?.kid,
					typ: typeof result.protectedHeader.typ === "string" ? result.protectedHeader.typ : header?.typ
				})
			};
		} catch (error) {
			return fail(mapJoseCause(error));
		}
	};
	const decryptNested = async (token) => {
		if (options.decryptionKeys === void 0) return fail("encrypted-token");
		const header = decodeHeader(token);
		if (header?.zip !== void 0 || header?.alg === "RSA1_5" || header?.cty === void 0 || normalizeTyp(header.cty) !== "jwt") return fail("encrypted-token");
		const jose = await loadJose();
		try {
			const listed = options.decryptionKeys;
			const first = ("keys" in listed && Array.isArray(listed.keys) ? listed.keys : [listed])[0];
			if (first === void 0 || first.kty !== "oct" || typeof first.k !== "string") return fail("encrypted-token");
			const { plaintext } = await jose.compactDecrypt(token, jose.base64url.decode(first.k), { keyManagementAlgorithms: [...options.decryptionAlgorithms ?? DEFAULT_DECRYPTION_ALGS].filter((alg) => alg !== "RSA1_5") });
			return {
				ok: true,
				jwt: new TextDecoder().decode(plaintext)
			};
		} catch {
			return fail("encrypted-token");
		}
	};
	return { verify(token, expectations = {}) {
		return verifyToken(token, expectations);
	} };
	async function verifyToken(token, expectations) {
		try {
			if (typeof token !== "string" || token.length === 0) return fail("malformed");
			let jwt = token;
			if (isJwe(token)) {
				const decrypted = await decryptNested(token);
				if (!decrypted.ok) return decrypted;
				jwt = decrypted.jwt;
			}
			const header = decodeHeader(jwt);
			if (header === void 0) return fail("malformed");
			if (header.alg === "none") return fail("alg-none");
			if (unknownCrit(header)) return fail("malformed");
			if (options.jwks !== void 0 && isSecretJwks(options.jwks)) {
				if (!algorithms.includes("HS256") || header.alg !== "HS256") return fail(header.alg === "none" ? "alg-none" : "alg-not-allowed");
				return await verifyInner(jwt, expectations, secretBytes(options.jwks.secret), header);
			}
			if (cache === void 0) return fail("jwks-unavailable");
			let resolved = await cache.resolveJwks();
			if (!resolved.ok) return fail(resolved.cause);
			let key = findKey(resolved.jwks.keys, header.kid, options.profile);
			if (key === void 0 && header.kid !== void 0) {
				resolved = await cache.refetchJwks();
				if (!resolved.ok) return fail(resolved.cause);
				key = findKey(resolved.jwks.keys, header.kid, options.profile);
			}
			if (key === void 0) return fail("unknown-kid");
			return await verifyInner(jwt, expectations, resolved.jwks.keys, header);
		} catch {
			return fail("malformed");
		}
	}
}
//#endregion
export { decodeHeader as a, loadJose as i, assertSubjectConfig as n, issuerFromDiscovery as r, joseTokenVerifier as t };
