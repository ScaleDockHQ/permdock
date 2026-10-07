import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";

import type { Credential } from "../../src/core/credential.ts";
import type { AuthEvent } from "../../src/core/interfaces.ts";
import type { Subject } from "../../src/core/subject.ts";
import type { ApiKeySubjectOptions } from "../../src/server/credentials.ts";

import { memorySettings } from "../../src/core/interfaces.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import {
  definePermissions,
  listPermissions,
  resource,
} from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { memorySink } from "../../src/core/sink.ts";
import {
  apiKeyVerifier,
  generateApiKey,
  hashApiKey,
  memoryCredentials,
  parseApiKey,
  subjectFromApiKey,
} from "../../src/server/credentials.ts";
import {
  testCredentialVerifier,
  testSubjectResolver,
} from "../../src/testing/conformance.ts";

const org = { organization: { field: "orgId", memberOf: "organization" } };
const permissions = definePermissions({
  repo: resource({ actions: ["read", "write"], relations: org }),
});
const { repo } = permissions;
const policy = definePolicy(
  { permissions },
  {
    subject: (user: Subject) => user.principal,
    scopes: { organization: { key: "orgId" } },
    roles: [
      role("developer", [allow(repo.read), allow(repo.write)], {
        on: "organization",
      }),
    ],
  },
);

const NOW = Math.floor(Date.now() / 1000);
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const r1 = { id: "r_1", orgId: "o_1" };

function credential(overrides: Record<string, unknown> = {}): Credential {
  // SAFETY: overrides may be deliberately invalid to exercise fail-closed credential checks.
  return {
    v: 1,
    id: "key_1",
    kind: "user",
    principal: "u_1",
    permissions: [{ permission: "repo.read" }],
    createdBy: "u_1",
    createdAt: NOW,
    expiresAt: NOW + 3600,
    ...overrides,
  } as Credential;
}

const service = {
  id: "svc_1",
  kind: "service",
  principal: "ci",
  tenant: "o_1",
  roles: ["developer"],
};

const owner = {
  id: "u_1",
  kind: "user" as const,
  tenant: "o_1",
  memberships: [{ tenant: "o_1", roles: ["developer"] }],
};

function permdockFor(subject: Subject) {
  const instance = createPermDock(policy, subject);
  if (instance instanceof Promise) {
    throw new TypeError("expected a synchronous instance");
  }
  return instance;
}

async function issue(overrides: Record<string, unknown> = {}) {
  const store = memoryCredentials();
  const key = await store.issue(credential(overrides));
  return { store, key };
}

function resolve(
  key: string | undefined,
  options: ApiKeySubjectOptions,
  tenant?: string,
) {
  return subjectFromApiKey(options)(
    key,
    tenant === undefined ? undefined : { tenant },
  );
}

describe("testCredentialVerifier on memoryCredentials", () => {
  const conformance = memoryCredentials();
  testCredentialVerifier(conformance, {
    key: () => conformance.issue(credential(service)),
    revoke: () => {
      conformance.revoke("svc_1");
    },
  });
});

describe("testCredentialVerifier on apiKeyVerifier", () => {
  const key = generateApiKey("key_1");
  let revoked = false;
  testCredentialVerifier(
    apiKeyVerifier({
      find: async (id) =>
        id === "key_1" && !revoked
          ? { credential: credential(), hash: await hashApiKey(key) }
          : null,
    }),
    {
      key,
      revoke: () => {
        revoked = true;
      },
    },
  );
});

describe("API key format", () => {
  it("generates pdk_<id>_<secret><checksum> keys that parse back, ids with underscores included", () => {
    const key = generateApiKey("key_1");
    expect(key).toMatch(/^pdk_key_1_[A-Za-z0-9]{49}$/);
    expect(parseApiKey(key)).toEqual({
      id: "key_1",
      secret: key.slice(10, 53),
    });
    expect(generateApiKey("key_1")).not.toBe(key);
  });

  it("ends in the base62 CRC-32 of the rest of the key", () => {
    const key = generateApiKey("ci");
    const body = key.slice(0, -6);
    let value = crc32(body);
    let expected = "";
    for (let index = 0; index < 6; index += 1) {
      expected = BASE62[value % 62] + expected;
      value = Math.floor(value / 62);
    }
    expect(key.slice(-6)).toBe(expected);
    const secret = key.slice(7, 50);
    const swapped = secret.startsWith("A")
      ? `B${secret.slice(1)}`
      : `A${secret.slice(1)}`;
    expect(parseApiKey(`pdk_ci_${swapped}${key.slice(-6)}`)).toBeUndefined();
  });

  it("refuses anything else", () => {
    const secret = "a".repeat(49);
    for (const key of [
      undefined,
      42,
      "",
      "pdk_",
      `pdk__${secret}`,
      `pdk_key_${"a".repeat(48)}`,
      `pdk_key_${secret}`,
      `pdk_key_${secret}_`,
      `sk_key_${secret}`,
      `pdk_k.y_${secret}`,
      `pdk_${"k".repeat(129)}_${secret}`,
    ]) {
      expect(parseApiKey(key)).toBeUndefined();
    }
    expect(() => generateApiKey("bad id")).toThrow(TypeError);
  });

  it("hashes the whole key with SHA-256 as base64url", async () => {
    expect(await hashApiKey("abc")).toBe(
      "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
    );
  });
});

describe("memoryCredentials", () => {
  it("issues, rotates and revokes, reporting each to the sink", async () => {
    const sink = memorySink();
    const store = memoryCredentials({ sink, source: "app" });
    const first = await store.issue(credential());
    expect(parseApiKey(first)?.id).toBe("key_1");
    expect(store.list()).toEqual([credential()]);
    const second = await store.rotate("key_1");
    expect(second).toBeDefined();
    expect(await store.verify(first)).toBeNull();
    expect(await store.verify(second!)).toMatchObject({ id: "key_1" });
    expect(await store.rotate("missing")).toBeUndefined();
    expect(store.revoke("key_1")).toBe(true);
    expect(store.revoke("key_1")).toBe(false);
    expect(await store.verify(second!)).toBeNull();
    expect(
      sink
        .events()
        .map((event) =>
          event.type === "credential" ? [event.operation, event.source] : [],
        ),
    ).toEqual([
      ["created", "app"],
      ["rotated", "app"],
      ["revoked", "app"],
    ]);
  });

  it("refuses an invalid or duplicate credential", async () => {
    const { store } = await issue();
    await expect(store.issue(credential({ kind: "robot" }))).rejects.toThrow(
      TypeError,
    );
    await expect(store.issue(credential())).rejects.toThrow(/exists/);
  });

  it("keeps working when the sink throws", async () => {
    const store = memoryCredentials({
      sink: {
        write() {
          throw new Error("down");
        },
      },
    });
    const key = await store.issue(credential());
    expect(await store.verify(key)).toMatchObject({ id: "key_1" });
  });
});

describe("apiKeyVerifier", () => {
  it("returns null for a wrong hash, a mismatched id or an invalid record", async () => {
    const key = generateApiKey("key_1");
    const hash = await hashApiKey(key);
    // SAFETY: a numeric hash is deliberately malformed to exercise fail-closed verification.
    const rows = [
      {
        credential: credential(),
        hash: await hashApiKey(generateApiKey("key_1")),
      },
      { credential: credential({ id: "key_2" }), hash },
      { credential: credential({ v: 2 }), hash },
      { credential: credential(), hash: 42 as unknown as string },
      null,
    ];
    for (const row of rows) {
      expect(await apiKeyVerifier({ find: () => row }).verify(key)).toBeNull();
    }
    const verifier = apiKeyVerifier({
      find: async (id) =>
        id === "key_1" ? { credential: credential(), hash } : null,
    });
    expect(await verifier.verify(key)).toMatchObject({ id: "key_1" });
  });
});

describe("subjectFromApiKey", () => {
  testSubjectResolver(
    subjectFromApiKey({ verifier: memoryCredentials(), permissions }),
    { invalid: `pdk_nope_${"a".repeat(49)}` },
  );

  it("checks a service key against its tenant and a user key against the request tenant", async () => {
    const settings = memorySettings({
      o_1: { credentials: { maxTtl: 60 } },
    });
    const serviceKey = await issue(service);
    expect(
      (
        await resolve(serviceKey.key, {
          verifier: serviceKey.store,
          permissions,
          settings,
        })
      ).principal,
    ).toBeNull();
    const userKey = await issue();
    const options = { verifier: userKey.store, permissions, settings };
    expect((await resolve(userKey.key, options)).principal?.id).toBe("u_1");
    expect((await resolve(userKey.key, options, "o_2")).principal?.id).toBe(
      "u_1",
    );
    expect((await resolve(userKey.key, options, "o_1")).principal).toBeNull();
  });

  it("resolves a user key to its live owner narrowed to the key", async () => {
    const { store, key } = await issue();
    const subject = await resolve(key, {
      verifier: store,
      permissions,
      owner: (id) => (id === "u_1" ? owner : null),
    });
    expect(subject.principal).toMatchObject({
      id: "u_1",
      kind: "user",
      credential: { id: "key_1", kind: "user" },
    });
    expect(subject.delegation).toEqual({ scopes: ["repo:read"] });
    const permdock = permdockFor(subject);
    expect(permdock.can(repo.read, r1)).toBe(true);
    expect(permdock.can(repo.write, r1)).toBe(false);
  });

  it("touches the verifier on a resolved key only, and ignores a throwing touch", async () => {
    const { store, key } = await issue();
    const options = { verifier: store, permissions, owner: () => owner };
    const wrong = key.endsWith("x") ? "y" : "x";
    await resolve(`${key.slice(0, -1)}${wrong}`, options);
    expect(store.lastUsedAt("key_1")).toBeUndefined();
    await resolve(key, options);
    expect(store.lastUsedAt("key_1")).toBeGreaterThanOrEqual(NOW);
    const throwing = {
      verify: (secret: string) => store.verify(secret),
      touch: () => {
        throw new Error("database down");
      },
    };
    const subject = await resolve(key, { ...options, verifier: throwing });
    expect(subject.principal?.id).toBe("u_1");
    const rejecting = {
      verify: (secret: string) => store.verify(secret),
      touch: () => Promise.reject(new Error("database down")),
    };
    expect(
      (await resolve(key, { ...options, verifier: rejecting })).principal?.id,
    ).toBe("u_1");
  });

  it("takes the owner rights from createPermDock memberships without an owner loader", async () => {
    const { store, key } = await issue();
    const subject = await resolve(key, {
      verifier: store,
      permissions,
    });
    const permdock = await createPermDock(policy, subject, {
      tenant: "o_1",
      memberships: {
        membershipsFor: (principal) =>
          principal.id === "u_1"
            ? [{ tenant: "o_1", roles: ["developer"] }]
            : [],
      },
    });
    expect(permdock.can(repo.read, r1)).toBe(true);
    expect(permdock.can(repo.write, r1)).toBe(false);
  });

  it("resolves a service key to a service principal in one tenant", async () => {
    const { store, key } = await issue({
      ...service,
      permissions: [{ permission: "repo.write", ids: ["r_1"] }],
    });
    const permdock = permdockFor(
      await resolve(key, { verifier: store, permissions }),
    );
    expect(permdock.subject.principal?.kind).toBe("service");
    expect(permdock.can(repo.write, r1)).toBe(true);
    expect(permdock.can(repo.write, { id: "r_2", orgId: "o_1" })).toBe(false);
    expect(permdock.can(repo.read, r1)).toBe(false);
  });

  it("fails closed with a cause for every refusal", async () => {
    const { store, key } = await issue();
    const expired = await issue({ expiresAt: NOW - 1 });
    const thrower = (): never => {
      throw new Error("db down");
    };
    const rows: readonly {
      readonly key: string;
      readonly options?: Partial<ApiKeySubjectOptions>;
      readonly tenant?: string;
      readonly cause?: string;
      readonly reason?: string;
    }[] = [
      { key: "not-a-key", cause: "malformed" },
      { key: generateApiKey("key_1"), cause: "unknown-credential" },
      {
        key: expired.key,
        options: { verifier: expired.store },
        cause: "expired",
      },
      {
        key,
        options: {
          settings: memorySettings({ o_1: { credentials: { maxTtl: 60 } } }),
        },
        tenant: "o_1",
        cause: "credential-policy",
      },
      {
        key,
        options: { revoked: (id) => id === "key_1" },
        cause: "credential-revoked",
      },
      { key, options: { owner: () => null }, cause: "owner-unavailable" },
      {
        key,
        options: { owner: () => ({ id: "u_1", kind: "service" }) },
        cause: "owner-unavailable",
      },
      {
        key,
        options: { verifier: { verify: () => credential({ id: "key_2" }) } },
        cause: "invalid-claims",
      },
      { key, options: { owner: thrower }, reason: "source-threw" },
      {
        key,
        options: { settings: { settingsFor: thrower } },
        tenant: "o_1",
        reason: "source-threw",
      },
      {
        key,
        options: { revoked: () => Promise.reject(new Error("db down")) },
        reason: "source-threw",
      },
      {
        key,
        options: { verifier: { verify: thrower } },
        reason: "source-threw",
      },
    ];
    for (const row of rows) {
      const events: AuthEvent[] = [];
      const subject = await resolve(
        row.key,
        {
          verifier: store,
          permissions,
          onAuth: (event) => {
            events.push(event);
          },
          requestId: "req_1",
          ...row.options,
        },
        row.tenant,
      );
      expect(subject.principal).toBeNull();
      expect(events).toEqual([
        {
          reason: row.reason ?? "invalid-token",
          ...(row.cause === undefined ? {} : { cause: row.cause }),
          source: "api-key",
          requestId: "req_1",
        },
      ]);
    }
    const none = await resolve(undefined, {
      verifier: store,
      permissions,
    });
    expect(none.principal).toBeNull();
  });

  it("reports sampled uses to the sink and never lets the sink decide", async () => {
    const { store, key } = await issue();
    const sink = memorySink();
    await resolve(key, {
      verifier: store,
      permissions,
      sink,
      source: "api",
    });
    expect(sink.events()).toEqual([
      expect.objectContaining({
        type: "credential",
        operation: "used",
        source: "api",
        credential: { id: "key_1", kind: "user" },
        principal: { id: "u_1" },
        sample: 1,
      }),
    ]);
    const quiet = memorySink();
    for (const sample of [0, 2, Number.NaN]) {
      await resolve(key, {
        verifier: store,
        permissions,
        sink: quiet,
        sample,
      });
    }
    expect(quiet.events()).toHaveLength(0);
    const subject = await resolve(key, {
      verifier: store,
      permissions,
      sink: {
        write() {
          throw new Error("down");
        },
      },
    });
    expect(subject.principal?.id).toBe("u_1");
    const counted = memorySink();
    for (let index = 0; index < 200; index += 1) {
      await resolve(key, {
        verifier: store,
        permissions,
        sink: counted,
        sample: 0.5,
      });
    }
    expect(counted.events().length).toBeGreaterThan(40);
    expect(counted.events().length).toBeLessThan(160);
    expect(counted.events()[0]).toMatchObject({ sample: 0.5 });
  });
});

describe("subjectFromApiKey: a key over many permissions", () => {
  const wide = definePermissions(
    Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [
        `area${index}`,
        resource({
          actions: ["read", "create", "update", "delete"],
          relations: org,
        }),
      ]),
    ),
  );
  const leaves = listPermissions(wide);
  const delegated = leaves.slice(0, 200);
  const held = leaves.at(-1);
  const widePolicy = definePolicy(
    { permissions: wide },
    {
      subject: (user: Subject) => user.principal,
      scopes: { organization: { key: "orgId" } },
      roles: [
        role(
          "admin",
          leaves.map((leaf) => allow(leaf)),
          { on: "organization" },
        ),
      ],
    },
  );

  it("resolves a verified key that delegates 200 permissions", async () => {
    const store = memoryCredentials();
    const key = await store.issue(
      credential({
        permissions: delegated.map((leaf) => ({ permission: leaf.key })),
      }),
    );
    const causes: AuthEvent[] = [];
    const subject = await resolve(key, {
      verifier: store,
      permissions: wide,
      owner: () => ({
        id: "u_1",
        kind: "user",
        tenant: "o_1",
        memberships: [{ tenant: "o_1", roles: ["admin"] }],
      }),
      onAuth: (event) => {
        causes.push(event);
      },
    });
    expect(causes).toEqual([]);
    expect(subject.principal?.credential.permissions).toHaveLength(200);
    expect(subject.delegation?.scopes).toHaveLength(200);
    const permdock = createPermDock(widePolicy, subject);
    if (permdock instanceof Promise || held === undefined) {
      throw new TypeError("expected a synchronous instance and 204 leaves");
    }
    const row = { id: "r_1", orgId: "o_1" };
    expect(delegated.every((leaf) => permdock.can(leaf, row))).toBe(true);
    expect(permdock.can(held, row)).toBe(false);
  });
});
