import { describe, expect, it } from "vitest";

import type { SubjectRecord } from "../../src/index.ts";

import { sourceMemo } from "../../src/core/source-memo.ts";
import { memorySubjectCache } from "../../src/index.ts";
import { postgrestSources } from "../../src/supabase/index.ts";
import { postgrestFixture } from "../../src/testing/fixtures/postgrest.ts";

const member = (id: string): SubjectRecord["memberships"][number] => ({
  scope: "organization",
  id,
  roles: ["member"],
});

const all: SubjectRecord = {
  id: "u1",
  active: true,
  roles: [],
  memberships: [member("acme"), member("globex")],
  customRoles: [],
  authzVersion: 4,
};

const database = () =>
  postgrestFixture({
    subjects: { u1: all },
    tenantSubjects: {
      acme: { u1: { ...all, memberships: [member("acme")] } },
      globex: { u1: { ...all, memberships: [member("globex")] } },
    },
  });

describe("postgrestSources tenantScoped", () => {
  it("reads subject_for(p_user, p_tenant) for the instance's tenant", async () => {
    const client = database();
    const sources = postgrestSources(client, { tenantScoped: true });
    const found = await sources.memberships.membershipsFor(
      { id: "u1" },
      { tenant: "acme" },
    );
    expect(found).toStrictEqual([member("acme")]);
    expect(client.calls.map(({ fn, args }) => [fn, args])).toStrictEqual([
      ["subject_for", { p_user: "u1", p_tenant: "acme" }],
    ]);
  });

  it("reads every tenant through subject_for(p_user) without the option", async () => {
    const client = database();
    const sources = postgrestSources(client);
    const found = await sources.memberships.membershipsFor(
      { id: "u1" },
      { tenant: "acme" },
    );
    expect(found).toHaveLength(2);
    expect(client.calls[0]?.args).toStrictEqual({ p_user: "u1" });
  });

  it("reads no memberships and makes no call without a tenant", async () => {
    const client = database();
    const sources = postgrestSources(client, { tenantScoped: true });
    expect(
      await sources.memberships.membershipsFor({ id: "u1" }, {}),
    ).toStrictEqual([]);
    expect(
      await sources.memberships.membershipsFor({ id: "u1" }, { tenant: "" }),
    ).toStrictEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it("answers no memberships for a tenant the user holds none in", async () => {
    const sources = postgrestSources(database(), { tenantScoped: true });
    expect(
      await sources.memberships.membershipsFor(
        { id: "u1" },
        { tenant: "initech" },
      ),
    ).toStrictEqual([]);
  });

  it("rejects when the function fails, never reading all tenants", async () => {
    const calls: Record<string, unknown>[] = [];
    const sources = postgrestSources(
      {
        schema: () => ({
          async rpc(_fn, args) {
            calls.push(args);
            return { data: null, error: { message: "boom" } };
          },
        }),
      },
      { tenantScoped: true },
    );
    await expect(
      sources.memberships.membershipsFor({ id: "u1" }, { tenant: "acme" }),
    ).rejects.toThrow("boom");
    expect(calls).toStrictEqual([{ p_user: "u1", p_tenant: "acme" }]);
  });

  it("keeps one memo entry per tenant", async () => {
    const client = database();
    const sources = postgrestSources(client, { tenantScoped: true });
    const memo = sourceMemo();
    const acme = await sources.memberships.membershipsFor(
      { id: "u1" },
      { tenant: "acme", memo },
    );
    const globex = await sources.memberships.membershipsFor(
      { id: "u1" },
      { tenant: "globex", memo },
    );
    await sources.memberships.membershipsFor(
      { id: "u1" },
      { tenant: "acme", memo },
    );
    expect(acme).toStrictEqual([member("acme")]);
    expect(globex).toStrictEqual([member("globex")]);
    expect(client.calls).toHaveLength(2);
  });

  it("caches per tenant and never serves one tenant's record for another", async () => {
    const client = database();
    const sources = postgrestSources(client, {
      tenantScoped: true,
      subjects: memorySubjectCache(),
    });
    for (const tenant of ["acme", "globex", "acme", "globex"]) {
      const memo = sourceMemo();
      await sources.memberships.version?.({ id: "u1" }, { memo });
      const found = await sources.memberships.membershipsFor(
        { id: "u1" },
        { tenant, memo },
      );
      expect(found).toStrictEqual([member(tenant)]);
    }
    expect(client.calls.filter(({ fn }) => fn === "subject_for")).toHaveLength(
      2,
    );
  });

  it("does not take a scoped record from a cache that ignores the tenant", async () => {
    const client = database();
    const stored = new Map<string, SubjectRecord>();
    const sources = postgrestSources(client, {
      tenantScoped: true,
      subjects: {
        record: (id) => stored.get(id) ?? null,
        seed: (record) => {
          stored.set(record.id, record);
        },
        evict: (id) => {
          stored.delete(id);
        },
      },
    });
    await sources.memberships.membershipsFor(
      { id: "u1" },
      { tenant: "acme", memo: sourceMemo() },
    );
    const globex = await sources.memberships.membershipsFor(
      { id: "u1" },
      { tenant: "globex", memo: sourceMemo() },
    );
    expect(globex).toStrictEqual([member("globex")]);
  });
});

describe("memorySubjectCache tenant", () => {
  const scoped = (tenant: string): SubjectRecord => ({
    ...all,
    tenant,
    memberships: [member(tenant)],
  });

  it("keeps the all-tenants record and each tenant's record apart", async () => {
    const cache = memorySubjectCache();
    await cache.seed(all);
    await cache.seed(scoped("acme"));
    expect(await cache.record("u1", 4)).toBe(all);
    expect(await cache.record("u1", 4, undefined, "acme")).toStrictEqual(
      scoped("acme"),
    );
    expect(await cache.record("u1", 4, undefined, "globex")).toBeNull();
  });

  it("evicts every record of a user", async () => {
    const cache = memorySubjectCache();
    await cache.seed(all);
    await cache.seed(scoped("acme"));
    await cache.evict("u1");
    expect(await cache.record("u1", 4)).toBeNull();
    expect(await cache.record("u1", 4, undefined, "acme")).toBeNull();
  });
});
