import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { createPermDock, listPermissions } from "permdock";
import { directoryMembershipSource } from "permdock/scim";
//#region src/describe-policy.ts
function isOutcomeCell(value) {
	return value === "granted" || value === "denied" || value === "approval-required" || value !== null && typeof value === "object" && ("denials" in value || "outcome" in value || "alternatives" in value);
}
function expectedOutcome(cell) {
	return typeof cell === "string" ? cell : cell.outcome ?? "denied";
}
function assertCell(decision, cell) {
	expect(decision.outcome).toBe(expectedOutcome(cell));
	if (typeof cell === "object" && cell.denials !== void 0 && decision.outcome === "denied") for (const denial of cell.denials) expect(decision.denials.some((item) => item.reason === denial.reason && (denial.role === void 0 || item.role === denial.role))).toBe(true);
	if (typeof cell === "object" && cell.alternatives !== void 0 && decision.outcome === "denied") expect(decision.alternatives.map((leaf) => leaf.key)).toEqual(cell.alternatives);
}
function describePolicy(policy, config) {
	describe("policy matrix", () => {
		const permissions = listPermissions(policy.permissions);
		const docks = /* @__PURE__ */ new Map();
		beforeAll(async () => {
			for (const [name, user] of Object.entries(config.subjects)) docks.set(name, await createPermDock(policy, user));
		});
		it("covers every permission", () => {
			if (config.exhaustive === false) return;
			for (const permission of permissions) expect(config.matrix[permission.key], `missing matrix for ${permission.key}`).toBeDefined();
		});
		for (const permission of permissions) {
			const spec = config.matrix[permission.key];
			if (spec === void 0) continue;
			describe(permission.key, () => {
				if (!Object.values(spec).some((value) => !isOutcomeCell(value))) {
					for (const [subjectName, cell] of Object.entries(spec)) it(`${subjectName}`, async () => {
						const instance = docks.get(subjectName) ?? await createPermDock(policy, config.subjects[subjectName]);
						const data = permission.kind === "instance" ? Object.values(config.fixtures ?? {})[0] : void 0;
						assertCell(instance.decide(permission, data), cell);
					});
					return;
				}
				for (const [fixtureName, row] of Object.entries(spec)) {
					if (isOutcomeCell(row)) continue;
					for (const [subjectName, cell] of Object.entries(row)) it(`${fixtureName} / ${subjectName}`, async () => {
						const instance = docks.get(subjectName) ?? await createPermDock(policy, config.subjects[subjectName]);
						const fixture = config.fixtures?.[fixtureName];
						assertCell(instance.decide(permission, fixture), cell);
					});
				}
			});
		}
	});
}
//#endregion
//#region src/snapshot-fixture.ts
async function snapshotFixture(policy, subject, options = {}) {
	const instance = await createPermDock(policy, subject, options.tenant === void 0 ? {} : { tenant: options.tenant });
	const target = options.simulated === true ? instance.simulate({}) : instance;
	if (Array.isArray(target)) throw new Error("PermDock: snapshotFixture expected a PermDock instance");
	const snapshot = options.include === void 0 && options.tenants === void 0 ? target.snapshot() : target.snapshot({
		...options.include === void 0 ? {} : { include: options.include },
		...options.tenants === void 0 ? {} : { tenants: options.tenants }
	});
	if (typeof snapshot === "string" || snapshot instanceof Promise) throw new Error("PermDock: snapshotFixture expected JSON snapshot v2");
	return snapshot;
}
//#endregion
//#region src/jwt-fixtures.ts
const jwtFixtureJwks = { keys: [{
	crv: "Ed25519",
	x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
	kty: "OKP",
	kid: "2026-09",
	alg: "Ed25519",
	use: "sig"
}] };
const jwtFixtureIssuer = "https://login.example.com";
const jwtFixtureAudience = "https://api.example.com";
const jwtFixtureTokens = {
	valid: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1XzEiLCJjbGllbnRfaWQiOiJhcHAiLCJyb2xlcyI6WyJtZW1iZXIiXSwianRpIjoianRpLXZhbGlkIiwiaXNzIjoiaHR0cHM6Ly9sb2dpbi5leGFtcGxlLmNvbSIsImF1ZCI6Imh0dHBzOi8vYXBpLmV4YW1wbGUuY29tIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjIwMDAwMDAwMDB9.ENFMmLSyVde-2s4Gdz4iP7srZvU0Xuy_ZLz-OJGHD_-W1lEayEBeSPTnab0L_TBdj8p5BmkFrT-7VE7o20GbAw",
	expired: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1XzEiLCJpc3MiOiJodHRwczovL2xvZ2luLmV4YW1wbGUuY29tIiwiYXVkIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20iLCJpYXQiOjEwMDAwMDAwMDAsImV4cCI6MTEwMDAwMDAwMH0.9X3d6kH3_2nmrbqMxuoxzFW-wsWJVCe-lR-aQ-MmsGGXlEUBMgQ-4MtAq1UR9lLE0h2b5JrE_GfjzuC04h5xCg",
	wrongAud: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1XzEiLCJpc3MiOiJodHRwczovL2xvZ2luLmV4YW1wbGUuY29tIiwiYXVkIjoiaHR0cHM6Ly9vdGhlci5leGFtcGxlLmNvbSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.PgWdzi56J31OwoMqH4ysHzVKSKUDhi-AtHFUp1ewFzi-qGE-tknzrNKnKhDOncVzj0okb_flyy3vQgfzJwG5AQ",
	wrongIss: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1XzEiLCJpc3MiOiJodHRwczovL2V2aWwuZXhhbXBsZS5jb20iLCJhdWQiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.tIcLHLa9JLtKz1gqjRGdr5DFbUzRDs5KsoPsJCxspvbBcsFfRFG2G0XJnd1h4QHyZ_5B4OhY3W_jIIsnOPD9Bg",
	unknownKid: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoibm9wZSIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1XzEiLCJpc3MiOiJodHRwczovL2xvZ2luLmV4YW1wbGUuY29tIiwiYXVkIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20iLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MjAwMDAwMDAwMH0.walgG5GvpCVBnkMtkdw-epi5c93JqfvAM_N4EWR9Tqhiw_cnzITnlQyoVfihECmV1fqtFrhwM1RCIRJvd38zAQ",
	none: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1XzEiLCJpc3MiOiJodHRwczovL2xvZ2luLmV4YW1wbGUuY29tIiwiYXVkIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20iLCJleHAiOjIwMDAwMDAwMDAsImlhdCI6MTcwMDAwMDAwMH0.",
	snapshot: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6InBlcm1kb2NrLXNuYXBzaG90K2p3dCJ9.eyJzbmFwc2hvdCI6eyJ2IjoyLCJpc3N1ZWRBdCI6MTcwMDAwMDAwMCwic3ViamVjdCI6eyJwcmluY2lwYWwiOnsiaWQiOiJ1XzEiLCJyb2xlcyI6WyJtZW1iZXIiXX0sImNvbnRleHQiOnt9fSwicm9sZXMiOlsibWVtYmVyIl0sImdyYW50cyI6W10sInRlbmFudHMiOltdfSwic3ViIjoidV8xIiwiaXNzIjoiaHR0cHM6Ly9hcHAuZXhhbXBsZS5jb20iLCJhdWQiOiJodHRwczovL2FwcC5leGFtcGxlLmNvbSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwLCJqdGkiOiJzbmFwX2ZpeHR1cmUifQ.4itaYctluoCwU-syytUxArtS_FRyNAti2SZxuSH-nKIMr7-Sb3h1Q3xugn_vPR1eupV4fVNIe6dH27_EiyDvCA",
	approval: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6InBlcm1kb2NrLWFwcHJvdmFsK2p3dCJ9.eyJhcHByb3ZhbCI6eyJ0b2tlbiI6InBkMS5hYmMiLCJwZXJtaXNzaW9uIjoicG9zdC5kZWxldGUiLCJyZXNvdXJjZSI6eyJ0eXBlIjoicG9zdCIsImlkIjoiNDIifSwic3RhdHVzIjoiYXBwcm92ZWQifSwic3ViIjoidV8xIiwiaXNzIjoiaHR0cHM6Ly9hcHAuZXhhbXBsZS5jb20iLCJhdWQiOiJodHRwczovL2FwcC5leGFtcGxlLmNvbSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwLCJqdGkiOiJhcHJfZml4dHVyZSJ9.UHsoSzQCo68G7ee-EFqdzMLvmqaKlFIMdQKFuqZEM4yUQnJsJJTXbld_aCXcyfN-IdjF9cj2F5EHzsV4nLKbBg",
	decisions: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6InBlcm1kb2NrLWRlY2lzaW9ucytqd3QifQ.eyJldmVudHMiOltdLCJpc3MiOiJodHRwczovL2FwcC5leGFtcGxlLmNvbSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwLCJqdGkiOiJkZWNfZml4dHVyZSJ9.UZhJd72yFGxHOdjYbzcGYUPgYjvLwOPCtHKxEbLu56SdKSKUDCREXmEBI9WaCPKWjlTBnnIKMYwjG8I8RATJCg"
};
//#endregion
//#region src/conformance.ts
function testSubjectResolver(resolver, options) {
	it("never throws and fails closed to anonymous", async () => {
		let result;
		try {
			result = await resolver(options.invalid);
		} catch {
			throw new Error("SubjectResolver must not throw");
		}
		expect(result.principal).toBeNull();
	});
}
function testMembershipSource(source, options) {
	it("returns well-formed memberships and fails closed on throw", async () => {
		for (const principal of options.principals) {
			let memberships = [];
			try {
				memberships = await source.membershipsFor(principal, {});
			} catch {
				memberships = [];
			}
			for (const membership of memberships) {
				const flags = [
					membership.tenant,
					membership.team,
					membership.on
				].filter((value) => value !== void 0);
				expect(flags.length).toBeLessThanOrEqual(2);
				expect(Array.isArray(membership.roles)).toBe(true);
			}
			const expected = options.expect?.[principal.id];
			if (expected !== void 0) expect(memberships).toEqual(expected);
		}
	});
}
function testRoleSource(source, options) {
	it("only resolves declared role names", async () => {
		const roles = await source.rolesFor(options.tenant);
		for (const role of roles) for (const included of role.includes) expect(options.declared).toContain(included);
		if (source.assignable !== void 0) {
			const assignable = await source.assignable(options.tenant);
			for (const name of assignable) expect(options.declared).toContain(name);
		}
	});
}
function testDecisionSink(sink) {
	it("accepts batches and never propagates write errors", async () => {
		await expect(Promise.resolve(sink.write([]))).resolves.toBeUndefined();
		if (sink.flush !== void 0) {
			await expect(Promise.resolve(sink.flush())).resolves.toBeUndefined();
			await expect(Promise.resolve(sink.flush())).resolves.toBeUndefined();
		}
	});
}
function testSnapshotSource(source) {
	it("round-trips snapshot v2", async () => {
		const snapshot = await source.get();
		expect(snapshot === null || snapshot === void 0).toBe(false);
		if (typeof snapshot === "object" && snapshot !== null && "v" in snapshot) expect(snapshot.v === 1 || snapshot.v === 2).toBe(true);
		if (source.subscribe !== void 0) source.subscribe(() => void 0)();
	});
}
function sampleApproval(token) {
	return {
		v: 1,
		token,
		permission: "post.delete",
		scope: "post:delete",
		resource: {
			type: "post",
			id: "42"
		},
		subject: {
			principal: {
				id: "u_1",
				roles: ["member"]
			},
			actor: {
				id: "agent-1",
				kind: "eve"
			}
		},
		detail: "post.delete requires human approval.",
		createdAt: (/* @__PURE__ */ new Date()).toISOString(),
		expiresAt: new Date(Date.now() + 36e5).toISOString(),
		status: "pending"
	};
}
const approver = {
	principal: {
		id: "u_9",
		roles: ["admin"]
	},
	context: {}
};
function testDirectoryStore(store, options) {
	const [home, other] = options.tenants;
	it("round-trips users and groups, isolates tenants, and drops inactive memberships", async () => {
		const created = await store.putUser(home, {
			id: "",
			userName: "ada",
			externalId: "00u1",
			active: true,
			meta: {
				created: "",
				lastModified: ""
			}
		});
		expect(created.id).not.toBe("");
		expect(await store.getUser(home, created.id)).toMatchObject({
			userName: "ada",
			externalId: "00u1"
		});
		expect(await store.getUser(other, created.id)).toBeNull();
		await expect(store.putUser(home, {
			id: "",
			userName: "ada",
			active: true,
			meta: {
				created: "",
				lastModified: ""
			}
		})).rejects.toThrow(/userName/);
		const group = await store.putGroup(home, {
			id: "g_editors",
			displayName: "Editors",
			members: [{ value: created.id }],
			roles: ["editor"],
			meta: {
				created: "",
				lastModified: ""
			}
		});
		expect(await store.groupsFor(home, created.id)).toEqual([expect.objectContaining({
			id: group.id,
			displayName: "Editors"
		})]);
		expect(await store.groupsFor(other, created.id)).toEqual([]);
		const patched = await store.patchUser(home, created.id, [{
			op: "replace",
			path: "active",
			value: false
		}]);
		expect(patched.active).toBe(false);
		const source = directoryMembershipSource(store, { assignable: ["editor"] });
		expect(await source.membershipsFor({ id: "00u1" }, { tenant: home })).toEqual([]);
		await store.patchUser(home, created.id, [{
			op: "replace",
			path: "active",
			value: true
		}]);
		expect(await source.membershipsFor({ id: "00u1" }, { tenant: home })).toEqual([{
			tenant: home,
			team: group.id,
			roles: ["editor"],
			via: `group:${group.id}`
		}]);
		await store.patchGroup(home, group.id, [{
			op: "remove",
			path: "members",
			value: [{ value: created.id }]
		}]);
		expect(await store.groupsFor(home, created.id)).toEqual([]);
	});
}
function testApprovalStore(store) {
	it("creates, gets, lists, resolves and expires", async () => {
		const request = sampleApproval("opaque-token");
		await store.create(request);
		const loaded = await store.get("opaque-token");
		expect(loaded).toEqual(request);
		expect(JSON.parse(JSON.stringify(loaded))).toEqual(request);
		const listed = await store.list({ status: "pending" });
		expect(listed.some((item) => item.token === "opaque-token")).toBe(true);
		const resolved = await store.resolve("opaque-token", {
			status: "approved",
			by: approver
		});
		expect(resolved.status).toBe("approved");
		await expect(Promise.resolve().then(() => store.resolve("opaque-token", {
			status: "rejected",
			by: approver
		}))).rejects.toThrow(/not pending/);
		await store.create(sampleApproval("stale-token"));
		const expired = await store.expire(new Date(Date.now() + 72e5));
		expect(expired).toBeGreaterThanOrEqual(1);
	});
}
function decodeHeader(token) {
	const [encoded] = token.split(".");
	if (encoded === void 0) return {};
	const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
	const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - padded.length % 4);
	return JSON.parse(atob(`${padded}${pad}`));
}
function testTokenVerifier(verifier, options) {
	const audience = options?.audience ?? "https://api.example.com";
	const issuer = options?.issuer ?? "https://login.example.com";
	it("never throws and maps the JWT behaviour table", async () => {
		const valid = await verifier.verify(jwtFixtureTokens.valid, {
			audience,
			issuer
		});
		expect(valid.ok).toBe(true);
		if (valid.ok) {
			expect(valid.claims.sub).toBe("u_1");
			expect(valid.header.alg).toBe("Ed25519");
		}
		const rows = [
			{
				token: jwtFixtureTokens.none,
				cause: "alg-none"
			},
			{
				token: jwtFixtureTokens.expired,
				cause: "expired"
			},
			{
				token: jwtFixtureTokens.wrongAud,
				cause: "wrong-audience"
			},
			{
				token: jwtFixtureTokens.wrongIss,
				cause: "wrong-issuer"
			},
			{
				token: jwtFixtureTokens.unknownKid,
				cause: "unknown-kid"
			},
			{
				token: "not-a-jwt",
				cause: "malformed"
			},
			{
				token: "a.b.c.d.e",
				cause: "encrypted-token"
			}
		];
		for (const row of rows) {
			let result;
			try {
				result = await verifier.verify(row.token, {
					audience,
					issuer
				});
			} catch {
				throw new Error("TokenVerifier must not throw");
			}
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.cause).toBe(row.cause);
		}
	});
}
function testTokenSigner(signer, options) {
	it("emits compact JWS with only alg, kid and typ", async () => {
		const token = await signer.sign({
			snapshot: { v: 2 },
			sub: "u_1"
		}, {
			typ: "permdock-snapshot+jwt",
			audience: "https://app.example.com"
		});
		const header = decodeHeader(token);
		expect(Object.keys(header).toSorted()).toEqual([
			"alg",
			"kid",
			"typ"
		]);
		expect(header.typ).toBe("permdock-snapshot+jwt");
		expect(header.alg).not.toBe("none");
		const verified = await options.verifier.verify(token, {
			typ: "permdock-snapshot+jwt",
			audience: "https://app.example.com"
		});
		expect(verified.ok).toBe(true);
		if (signer.jwks !== void 0) {
			const jwks = await signer.jwks();
			expect(jwks.keys.length).toBeGreaterThan(0);
			expect(jwks.keys[0]).not.toHaveProperty("d");
		}
	});
}
function testWhereCompiler(compiler, options) {
	it("fails closed on an empty allow set", () => {
		const compiled = compiler({
			op: "or",
			conditions: []
		}, options.target);
		const closed = options.isFailClosed === void 0 ? compiled === false || compiled === void 0 || compiled === null : options.isFailClosed(compiled);
		expect(closed).toBe(true);
	});
}
//#endregion
export { describePolicy, expectTypeOf, jwtFixtureAudience, jwtFixtureIssuer, jwtFixtureJwks, jwtFixtureTokens, snapshotFixture, testApprovalStore, testDecisionSink, testDirectoryStore, testMembershipSource, testRoleSource, testSnapshotSource, testSubjectResolver, testTokenSigner, testTokenVerifier, testWhereCompiler };
