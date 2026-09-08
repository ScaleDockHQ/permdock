import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { createPermDock, listPermissions } from "permdock";
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
function testWhereCompiler(compiler, options) {
	it("fails closed on an empty allow set", () => {
		const compiled = compiler({
			op: "or",
			conditions: []
		}, options.target);
		expect(compiled === false || compiled === void 0 || compiled === null).toBe(true);
	});
}
//#endregion
export { describePolicy, expectTypeOf, snapshotFixture, testDecisionSink, testMembershipSource, testRoleSource, testSnapshotSource, testSubjectResolver, testWhereCompiler };
