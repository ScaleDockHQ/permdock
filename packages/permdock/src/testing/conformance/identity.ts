import { expect, it } from "vitest";

import { normalizeMemberships, scopeList } from "../../core/scopes.ts";
import {
  type EntitlementSource,
  type Membership,
  type MembershipSource,
  type Policy,
  type RevocationEvent,
  type Role,
  type RoleSource,
  type SettingsSource,
  type Subject,
  type SubjectResolver,
  memoryRevocationFeed,
  validateCustomRole,
} from "../../index.ts";
import {
  type DirectoryStore,
  directoryMembershipSource,
  scimHandler,
  sha256Hex,
} from "../../scim/index.ts";

export function testSubjectResolver<TInput>(
  resolver: SubjectResolver<TInput>,
  options: { readonly invalid: TInput },
): void {
  it("never throws and fails closed to anonymous", async () => {
    let result: Subject;
    try {
      result = await resolver(options.invalid);
    } catch {
      throw new Error("SubjectResolver must not throw");
    }
    expect(result.principal).toBeNull();
  });
}

export function testMembershipSource(
  source: MembershipSource,
  options: {
    readonly principals: readonly {
      readonly id: string;
      readonly kind?: string;
    }[];
    readonly expect?: Record<string, readonly Membership[]>;
    /** With the policy, every membership must name one of its scopes and carry its parent ids. */
    readonly policy?: Policy;
    /** Passed to every `membershipsFor`; a source keyed by tenant answers nothing without one. */
    readonly tenant?: string;
  },
): void {
  const query = options.tenant === undefined ? {} : { tenant: options.tenant };
  it("returns well-formed memberships and fails closed on throw", async () => {
    for (const principal of options.principals) {
      let memberships: Membership[] = [];
      try {
        memberships = await source.membershipsFor(principal, query);
      } catch {
        memberships = [];
      }
      for (const membership of memberships) {
        const named = membership.scope !== undefined;
        const legacy =
          membership.tenant !== undefined || membership.team !== undefined;
        const shapes = [named, legacy, membership.on !== undefined].filter(
          Boolean,
        );
        expect(shapes.length).toBe(1);
        expect(Array.isArray(membership.roles)).toBe(true);
        if (options.policy !== undefined) {
          expect(
            normalizeMemberships(
              [membership],
              scopeList(options.policy.scopes),
            ),
          ).toHaveLength(1);
        }
      }
      const expected = options.expect?.[principal.id];
      if (expected !== undefined) {
        expect(memberships).toEqual(expected);
      }
    }
  });
  if (source.list !== undefined) {
    it("lists every member of an instance it returns a membership for", async () => {
      for (const principal of options.principals) {
        let memberships: Membership[] = [];
        try {
          memberships = await source.membershipsFor(principal, query);
        } catch {
          continue;
        }
        for (const membership of memberships) {
          if (membership.scope === undefined || membership.id === undefined) {
            continue;
          }
          const members =
            (await source.list?.({
              scope: membership.scope,
              id: membership.id,
            })) ?? [];
          expect(
            members.some(
              (entry) =>
                entry.principal.id === principal.id &&
                entry.membership.scope === membership.scope &&
                entry.membership.id === membership.id,
            ),
          ).toBe(true);
        }
      }
    });
  }
  if (source.version !== undefined) {
    it("reports a finite version or none", async () => {
      for (const principal of options.principals) {
        const version = await source.version?.({ id: principal.id });
        expect(
          version === undefined ||
            (typeof version === "number" && Number.isFinite(version)),
        ).toBe(true);
      }
    });
  }
}

export function testEntitlementSource(
  source: EntitlementSource,
  options: {
    readonly principal: { readonly id: string };
    readonly tenant: string;
    readonly expect?: readonly string[];
  },
): void {
  it("returns plan names for a tenant and none without one", async () => {
    const found = await source.entitlementsFor(options.principal, {
      tenant: options.tenant,
    });
    expect(Array.isArray(found)).toBe(true);
    for (const name of found) {
      expect(typeof name).toBe("string");
    }
    if (options.expect !== undefined) {
      expect([...found].toSorted()).toEqual([...options.expect].toSorted());
    }
    expect(await source.entitlementsFor(options.principal, {})).toEqual([]);
  });
}

export function testRoleSource(
  source: RoleSource,
  options: {
    readonly tenant: string;
    readonly declared: readonly (string | Role)[];
    /** When set, every custom role's `grants` must resolve inside the ceiling. */
    readonly policy?: Policy;
    /**
     * Names of every custom role the tenant has. When set, `rolesFor` must
     * return each of them with nothing held, as role management needs.
     */
    readonly every?: readonly string[];
  },
): void {
  it("only resolves declared role names", async () => {
    const declared = options.declared.map((item) =>
      typeof item === "string" ? item : item.key,
    );
    const roles = await source.rolesFor(options.tenant);
    for (const role of roles) {
      expect(role.tenant).toBe(options.tenant);
      for (const included of role.includes ?? []) {
        expect(declared).toContain(included);
      }
      if (options.policy !== undefined) {
        expect(validateCustomRole(options.policy, role).dropped).toEqual([]);
      }
    }
    if (source.assignable !== undefined) {
      const assignable = await source.assignable(options.tenant);
      for (const name of assignable) {
        expect(declared).toContain(name);
      }
    }
  });
  const every = options.every;
  if (every !== undefined) {
    it("returns every custom role of the tenant, held or not", async () => {
      const roles = await source.rolesFor(options.tenant, { held: [] });
      expect([...new Set(roles.map((role) => role.name))].toSorted()).toEqual(
        [...new Set(every)].toSorted(),
      );
    });
  }
}

export function testDirectoryStore(
  store: DirectoryStore,
  options: { readonly tenants: readonly [string, string] },
): void {
  const [home, other] = options.tenants;
  it("round-trips users and groups, isolates tenants, and drops inactive memberships", async () => {
    const created = await store.putUser(home, {
      id: "",
      userName: "ada",
      externalId: "00u1",
      active: true,
      meta: { created: "", lastModified: "" },
    });
    expect(created.id).not.toBe("");
    expect(await store.getUser(home, created.id)).toMatchObject({
      userName: "ada",
      externalId: "00u1",
    });
    expect(await store.getUser(other, created.id)).toBeNull();
    await expect(
      store.putUser(home, {
        id: "",
        userName: "ada",
        active: true,
        meta: { created: "", lastModified: "" },
      }),
    ).rejects.toThrow(/userName/);
    const group = await store.putGroup(home, {
      id: "g_editors",
      displayName: "Editors",
      members: [{ value: created.id }],
      roles: ["editor"],
      meta: { created: "", lastModified: "" },
    });
    expect(await store.groupsFor(home, created.id)).toEqual([
      expect.objectContaining({ id: group.id, displayName: "Editors" }),
    ]);
    expect(await store.groupsFor(other, created.id)).toEqual([]);
    const patched = await store.patchUser(home, created.id, [
      { op: "replace", path: "active", value: false },
    ]);
    expect(patched.active).toBe(false);
    const source = directoryMembershipSource(store, { assignable: ["editor"] });
    expect(
      await source.membershipsFor({ id: "00u1" }, { tenant: home }),
    ).toEqual([]);
    await store.patchUser(home, created.id, [
      { op: "replace", path: "active", value: true },
    ]);
    expect(
      await source.membershipsFor({ id: "00u1" }, { tenant: home }),
    ).toEqual([
      {
        tenant: home,
        roles: ["editor"],
        via: `group:${group.id}`,
        managedBy: "idp",
      },
    ]);
    await store.patchGroup(home, group.id, [
      {
        op: "remove",
        path: "members",
        value: [{ value: created.id }],
      },
    ]);
    expect(await store.groupsFor(home, created.id)).toEqual([]);
  });

  it("ends sessions when scimHandler deactivates a user in this store", async () => {
    const feed = memoryRevocationFeed();
    const seen: RevocationEvent[] = [];
    feed.subscribe((event) => {
      seen.push(event);
    });
    const kinds: string[] = [];
    const token = "conformance-scim-token";
    const handle = scimHandler({
      store,
      tenant: home,
      token: { hash: "sha256", lookup: () => sha256Hex(token) },
      revocations: feed,
      onChange: (change) => {
        kinds.push(change.kind);
      },
    });
    const call = (path: string, method: string, body: unknown) =>
      handle(
        new Request(`https://app.example.com/scim/v2${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/scim+json",
          },
          body: JSON.stringify(body),
        }),
      );
    const created = await call("/Users", "POST", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "grace",
      active: true,
    });
    expect(created.status).toBe(201);
    // SAFETY: a 201 from the SCIM handler under test returns the created User resource with id.
    const id = String(((await created.json()) as { id: unknown }).id);
    seen.length = 0;
    const patched = await call(`/Users/${id}`, "PATCH", {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(patched.status).toBe(200);
    expect(seen).toContainEqual({
      principal: "grace",
      tenant: home,
      kind: "session-revoked",
    });
    expect(seen.every((event) => event.kind === "session-revoked")).toBe(true);
    expect(kinds).toEqual(["changed", "session-revoked"]);
  });
}

/** Settings for `tenant`, or `undefined`; a thrown source fails the runner. */
export function testSettingsSource(
  source: SettingsSource,
  options: { readonly tenant: string; readonly unknown?: string },
): void {
  it("answers per tenant with plain settings and nothing for an unknown tenant", async () => {
    const settings = await source.settingsFor(options.tenant);
    if (settings !== undefined) {
      expect(typeof settings).toBe("object");
      const credentials = settings.credentials;
      if (credentials !== undefined) {
        expect(
          credentials.maxTtl === undefined ||
            (Number.isFinite(credentials.maxTtl) && credentials.maxTtl >= 0),
        ).toBe(true);
        expect(
          credentials.kinds === undefined ||
            credentials.kinds.every(
              (kind) =>
                kind === "user" || kind === "service" || kind === "feed",
            ),
        ).toBe(true);
      }
      expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
    }
    expect(
      await source.settingsFor(options.unknown ?? "__permdock_unknown__"),
    ).toBeUndefined();
  });
}
