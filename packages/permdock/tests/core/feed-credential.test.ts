import { describe, expect, it } from "vitest";

import type { Subject } from "../../src/core/subject.ts";

import { applyApprovalVerdict } from "../../src/approvals/index.ts";
import {
  credentialSubject,
  isFeedId,
  parseCredential,
} from "../../src/core/credential.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { decideCredential } from "../../src/index.ts";
import {
  generateFeedKey,
  memoryCredentialStore,
  parseApiKey,
  parseFeedKey,
  subjectFromApiKey,
} from "../../src/server/credentials.ts";

const permissions = definePermissions({
  calendar: resource({
    actions: ["read", "share"],
    relations: { org: { field: "orgId", memberOf: "organization" } },
  }),
});

const policy = definePolicy(
  { permissions },
  {
    subject: (user: Subject) => user.principal,
    scopes: { organization: { key: "orgId" } },
    roles: [
      role(
        "owner",
        [allow(permissions.calendar.read), allow(permissions.calendar.share)],
        {
          on: "organization",
        },
      ),
      role("guest", [allow(permissions.calendar.read)], {
        on: permissions.calendar,
      }),
    ],
  },
);

const row = { id: "cal_1", orgId: "o_1" };

function owner(): Subject {
  return {
    principal: {
      id: "u_1",
      kind: "user",
      tenant: "o_1",
      memberships: [{ tenant: "o_1", roles: ["owner"] }],
    },
    context: {},
  };
}

describe("feed credentials", () => {
  it("builds a lowercase key that parses, rotates and fits an email local part", async () => {
    expect(isFeedId("team-calendar")).toBe(true);
    expect(isFeedId("Team")).toBe(false);
    const key = generateFeedKey("team-calendar");
    expect(key).toMatch(/^pdfeed_team-calendar_[a-z2-7]{32}$/u);
    expect(key.length).toBeLessThanOrEqual(64);
    expect(parseFeedKey(key)).toMatchObject({ id: "team-calendar" });
    expect(parseApiKey(key)).toBeUndefined();
    expect(parseFeedKey(key.toUpperCase())).toBeUndefined();
    const wide = generateFeedKey("a".repeat(16));
    expect(wide.length).toBe(56);

    const credential = parseCredential({
      v: 1,
      id: "team-calendar",
      kind: "feed",
      principal: "team-calendar",
      on: { resource: "calendar", id: "cal_1" },
      roles: ["guest"],
      permissions: [{ permission: "calendar.read", ids: ["cal_1"] }],
      createdBy: "u_1",
      createdAt: "2023-11-14T22:13:20.000Z",
    });
    expect(credential?.expiresAt).toBeUndefined();
    const store = memoryCredentialStore();
    if (credential === undefined) {
      throw new Error("expected a feed credential");
    }
    const issued = await store.issue(credential);
    expect(parseFeedKey(issued)?.id).toBe("team-calendar");
    const rotated = await store.rotate("team-calendar");
    expect(rotated).not.toBe(issued);
    expect(await store.verify(issued)).toBeNull();
    expect((await store.verify(rotated ?? ""))?.kind).toBe("feed");
  });

  it("acts as a feed principal on one resource and cannot create a key or approve", async () => {
    const permdock = getPermDockSync(policy, owner());
    const decision = await decideCredential(permdock, {
      id: "cal-feed",
      kind: "feed",
      on: { resource: permissions.calendar, id: "cal_1" },
      roles: ["guest"],
      permissions: [permissions.calendar.read],
      row,
    });
    expect(decision.outcome).toBe("granted");
    if (decision.outcome !== "granted") {
      return;
    }
    const subject = credentialSubject(decision.credential, {
      permissions,
    });
    expect(subject.principal).toMatchObject({
      id: "cal-feed",
      kind: "feed",
      memberships: [
        {
          on: { resource: "calendar", id: "cal_1" },
          roles: ["guest"],
          via: "feed",
        },
      ],
    });
    expect(subject.delegation?.authorizationDetails).toEqual([
      { type: "calendar", actions: ["read"], identifier: "cal_1" },
    ]);
    const asFeed = getPermDockSync(policy, subject);
    const minted = await decideCredential(asFeed, {
      id: "other-feed",
      kind: "feed",
      on: { resource: permissions.calendar, id: "cal_1" },
      roles: ["guest"],
      permissions: [permissions.calendar.read],
      row,
    });
    expect(minted).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "exceeds-creator" }],
    });
    expect(() =>
      applyApprovalVerdict(
        {
          v: 1,
          id: "r1",
          token: "t",
          permission: "calendar.share",
          scope: "calendar:share",
          resource: { type: "calendar", id: "cal_1" },
          subject: {
            principal: { id: "u_2", roles: ["owner"], tenant: "o_1" },
          },
          detail: "share",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          status: "pending",
        },
        { status: "approved", by: subject },
      ),
    ).toThrow(/feed/u);

    const store = memoryCredentialStore();
    const key = await store.issue(decision.credential);
    const resolved = await subjectFromApiKey(key, {
      verifier: store,
      permissions,
      kinds: ["feed"],
    });
    expect(resolved.principal?.kind).toBe("feed");
    const refused = await subjectFromApiKey(key, {
      verifier: store,
      permissions,
      kinds: ["user"],
    });
    expect(refused.principal).toBeNull();
  });

  it("refuses a feed role the resource does not declare and a permission the creator lacks", async () => {
    const permdock = getPermDockSync(policy, owner());
    const undeclared = await decideCredential(permdock, {
      id: "cal-feed",
      kind: "feed",
      on: { resource: permissions.calendar, id: "cal_1" },
      roles: ["owner"],
      permissions: [permissions.calendar.read],
      row,
    });
    expect(undeclared).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "exceeds-creator", detail: { role: "owner" } }],
    });
    const member: Subject = {
      principal: {
        id: "u_2",
        kind: "user",
        tenant: "o_1",
        memberships: [{ tenant: "o_1", roles: ["guest"] }],
      },
      context: {},
    };
    const lacking = await decideCredential(getPermDockSync(policy, member), {
      id: "cal-feed",
      kind: "feed",
      on: { resource: permissions.calendar, id: "cal_1" },
      roles: ["guest"],
      permissions: [permissions.calendar.read],
      row,
    });
    expect(lacking.outcome).toBe("denied");
    const pinned = await decideCredential(permdock, {
      id: "cal-feed",
      kind: "feed",
      on: { resource: permissions.calendar, id: "cal_1" },
      roles: ["guest"],
      permissions: [{ permission: permissions.calendar.read, ids: ["other"] }],
      row,
    });
    expect(pinned.outcome).toBe("denied");
    expect(() => generateFeedKey("Bad Id")).toThrow(/feed id/u);
    expect(parseFeedKey("pdfeed_ok_")).toBeUndefined();
    expect(parseFeedKey("not-a-key")).toBeUndefined();
    const badId = await decideCredential(permdock, {
      id: "Bad",
      kind: "feed",
      on: { resource: permissions.calendar, id: "cal_1" },
      roles: ["guest"],
      permissions: [permissions.calendar.read],
      row,
    });
    expect(badId.outcome).toBe("denied");
    const noRow = await decideCredential(permdock, {
      id: "cal-feed",
      kind: "feed",
      on: { resource: permissions.calendar, id: "cal_1" },
      roles: ["guest"],
      permissions: [permissions.calendar.read],
      row: null,
    });
    expect(noRow.outcome).toBe("denied");
  });
});
