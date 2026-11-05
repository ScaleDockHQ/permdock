import { describe, expect, it } from "vitest";

import type { Subject } from "../../src/core/subject.ts";

import {
  allow,
  definePermissions,
  definePolicy,
  getPermDock,
  parseSnapshot,
  resource,
  role,
} from "../../src/index.ts";
import { snapshotKey } from "../../src/server/index.ts";

const Doc = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;
const permissions = definePermissions({
  doc: resource(Doc, { id: "id", actions: ["read"] }),
});
const policy = definePolicy(permissions, {
  roles: [role("member", [allow(permissions.doc.read)])],
  subject: (user: Subject | null) => user?.principal ?? null,
});

const user: Subject = {
  principal: { id: "u1", roles: ["member"], tenant: "T", authzVersion: 7 },
  context: {},
  session: "s1",
};

describe("snapshot authzVersion, sessionId and snapshotKey", () => {
  it("carries the token's version and session", async () => {
    const snapshot = (await getPermDock(policy, user)).snapshot();
    expect(snapshot.authzVersion).toBe(7);
    expect(snapshot.sessionId).toBe("s1");
    expect(snapshotKey(snapshot)).toBe("u1:7:");
    const inTenant = {
      ...snapshot,
      subject: {
        ...snapshot.subject,
        principal: { id: "u1", roles: [], tenant: "T" },
      },
    };
    expect(snapshotKey(inTenant)).toBe("u1:7:T");
    expect(parseSnapshot(JSON.stringify(snapshot))).toStrictEqual(snapshot);
  });

  it("keys an anonymous snapshot without a version or tenant", async () => {
    const snapshot = (await getPermDock(policy, null)).snapshot();
    expect(snapshotKey(snapshot)).toBe("anon::");
  });

  it("rejects a malformed version or session", async () => {
    const snapshot = (await getPermDock(policy, user)).snapshot();
    expect(() => parseSnapshot({ ...snapshot, authzVersion: -1 })).toThrow(
      "authzVersion",
    );
    expect(() => parseSnapshot({ ...snapshot, sessionId: 1 })).toThrow(
      "sessionId",
    );
  });
});
