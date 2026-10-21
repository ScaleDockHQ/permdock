import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  HttpAdapterOptions,
  HttpCall,
  HttpMounted,
  HttpOp,
  HttpResult,
  HttpScenarioName,
} from "./domain.ts";
import type { EventStream } from "./wire.ts";

import { resolveApproval } from "../../approvals/index.ts";
import { getPermDock } from "../../index.ts";
import { problemFromDecision } from "../../server/index.ts";
import { saasPolicy } from "../saas/policy.ts";
import { saasPrincipal } from "../saas/seed.ts";
import { signSaasToken } from "../saas/tokens.ts";
import { approverSubject, createDomain, project } from "./domain.ts";
import {
  PARALLEL,
  eventStream,
  field,
  readResult,
  reasonsOf,
  restRequest,
  untilEnd,
} from "./wire.ts";

/**
 * Real-life HTTP scenarios over the shared SaaS domain. `mount` builds the
 * application once with the adapter under test; every expectation below is
 * written by hand, never computed with PermDock.
 */
export function testHttpAdapter(options: HttpAdapterOptions): void {
  const scenario = (
    name: HttpScenarioName,
    title: string,
    run: () => Promise<void>,
    timeout?: number,
  ): void => {
    const reason =
      options.skip?.[name] ??
      (name.startsWith("stream-") && options.streams !== true
        ? "no events stream"
        : undefined);

    it.skipIf(reason !== undefined)(
      reason === undefined ? title : `${title} (${reason})`,
      run,
      timeout,
    );
  };

  describe(`${options.name}: real-life HTTP scenarios`, () => {
    const domain = createDomain();
    const tokens = new Map<string, string>();
    let mounted: HttpMounted;

    beforeAll(async () => {
      mounted = await options.mount(domain);
      for (const user of [
        "alice",
        "bob",
        "carol",
        "dave",
        "erin",
        "frank",
        "hank",
        "mallory",
      ]) {
        tokens.set(
          user,
          `Bearer ${await signSaasToken(user, { memberships: false })}`,
        );
      }
    });

    afterAll(async () => {
      await mounted.close?.();
    });

    const send = async (
      user: string | null,
      op: HttpOp,
      approval?: string,
    ): Promise<HttpResult> => {
      const call: HttpCall = {
        ...op,
        authorization: user === null ? null : (tokens.get(user) ?? null),
        ...(approval === undefined ? {} : { approval }),
      };
      if (mounted.call !== undefined) {
        return mounted.call(call);
      }
      if (mounted.fetch === undefined) {
        throw new Error(
          `${options.name}: mount returned neither fetch nor call`,
        );
      }
      return readResult(
        await mounted.fetch(restRequest("http://app.test", call)),
      );
    };

    const openStream = async (
      authorization: string | null,
      org: string,
      id: string,
    ): Promise<EventStream> => {
      if (mounted.fetch === undefined) {
        throw new Error(`${options.name}: streams need a fetch mount`);
      }
      const headers = new Headers({ accept: "text/event-stream" });
      if (authorization !== null) {
        headers.set("authorization", authorization);
      }
      return eventStream(
        await mounted.fetch(
          new Request(`http://app.test/${org}/projects/${id}/events`, {
            headers,
          }),
        ),
      );
    };

    scenario(
      "tenant",
      "resolves the tenant from the path on every protect",
      async () => {
        expect(
          (await send("alice", { op: "project.get", org: "acme", id: "p2" }))
            .status,
        ).toBe(200);
        expect(
          (await send("alice", { op: "project.get", org: "globex", id: "g1" }))
            .status,
        ).toBe(200);
        expect(
          (await send("alice", { op: "project.get", org: "acme", id: "g1" }))
            .status,
        ).toBe(403);
        expect(
          (await send("mallory", { op: "project.get", org: "acme", id: "p1" }))
            .status,
        ).toBe(403);
        expect(
          (await send(null, { op: "project.get", org: "acme", id: "p1" }))
            .status,
        ).toBe(401);
      },
    );

    scenario(
      "roles",
      "applies the role held in the requested org",
      async () => {
        expect(
          (await send("alice", { op: "project.update", org: "acme", id: "p1" }))
            .status,
        ).toBe(200);
        expect(
          (
            await send("alice", {
              op: "project.update",
              org: "globex",
              id: "g1",
            })
          ).status,
        ).toBe(403);
        expect(
          (await send("bob", { op: "project.update", org: "acme", id: "p1" }))
            .status,
        ).toBe(200);
        expect(
          (await send("bob", { op: "project.update", org: "acme", id: "p2" }))
            .status,
        ).toBe(403);
      },
    );

    scenario("custom-roles", "grants through an org custom role", async () => {
      const body = {
        id: "c1",
        orgId: "acme",
        ownerId: "dave",
        name: "Contract",
        archived: false,
      };
      expect(
        (await send("dave", { op: "project.create", org: "acme", body }))
          .status,
      ).toBe(201);
      expect(
        (await send("hank", { op: "project.create", org: "acme", body }))
          .status,
      ).toBe(403);
    });

    scenario(
      "plans",
      "gates a feature on the plan of the requested org",
      async () => {
        expect(
          (await send("erin", { op: "analytics.read", org: "globex" })).status,
        ).toBe(200);
        const upgrade = await send("erin", {
          op: "analytics.read",
          org: "acme",
        });
        expect(upgrade.status).toBe(403);
        expect(new Set(reasonsOf(upgrade.body))).toStrictEqual(
          new Set(["not-entitled"]),
        );
      },
    );

    scenario("expired", "ignores an expired membership", async () => {
      expect(
        (await send("frank", { op: "project.get", org: "acme", id: "p1" }))
          .status,
      ).toBe(403);
    });

    scenario("limits", "counts a quota per subject and tenant", async () => {
      for (let index = 0; index < 5; index += 1) {
        expect(
          (await send("erin", { op: "apiKey.create", org: "acme" })).status,
        ).toBe(201);
      }
      const exhausted = await send("erin", {
        op: "apiKey.create",
        org: "acme",
      });
      expect(exhausted.status).toBe(429);
      expect(reasonsOf(exhausted.body)).toContain("limit");
      expect(
        (await send("erin", { op: "apiKey.create", org: "globex" })).status,
      ).toBe(201);
    });

    scenario(
      "validation",
      "validates an untrusted body before the check",
      async () => {
        const valid = {
          id: "n2",
          orgId: "acme",
          ownerId: "bob",
          name: "New",
          archived: false,
        };
        expect(
          (
            await send("bob", {
              op: "project.create",
              org: "acme",
              body: valid,
            })
          ).status,
        ).toBe(201);
        const invalid = await send("bob", {
          op: "project.create",
          org: "acme",
          body: { ...valid, name: 42 },
        });
        expect(invalid.status).toBe(400);
        expect(
          (
            await send("bob", {
              op: "project.create",
              org: "acme",
              body: { ...valid, orgId: "globex" },
            })
          ).status,
        ).toBe(403);
      },
    );

    scenario(
      "assert",
      "maps assert inside a handler to the Problem protect sends",
      async () => {
        const denied = await send("bob", {
          op: "project.delete",
          org: "acme",
          id: "p2",
        });
        expect(denied.status).toBe(403);
        expect(field(denied.body, "type")).toBe(
          "https://permdock.com/problems/denied",
        );
        const bob = await getPermDock(
          saasPolicy,
          saasPrincipal("bob", "acme"),
          { tenant: "acme" },
        );
        const permission = saasPolicy.permissions.project.delete;
        const fromProtect = await readResult(
          problemFromDecision(
            bob.decide(permission, project("p2")),
            permission,
            bob.subject,
          ),
        );
        expect(denied.status).toBe(fromProtect.status);
        for (const key of ["type", "title", "permission", "denials"]) {
          expect(field(denied.body, key)).toStrictEqual(
            field(fromProtect.body, key),
          );
        }
        expect(
          (await send("bob", { op: "project.delete", org: "acme", id: "p3" }))
            .status,
        ).toBe(204);
        expect(
          (await send("bob", { op: "project.delete", org: "acme", id: "p4" }))
            .status,
        ).toBe(403);
      },
    );

    scenario(
      "approval",
      "asks for approval, resumes once and refuses a replay",
      async () => {
        const asked = await send("alice", {
          op: "apiKey.revokeAll",
          org: "acme",
        });
        expect(asked.status).toBe(403);
        expect(field(asked.body, "type")).toBe(
          "https://permdock.com/problems/approval-required",
        );
        const token = field(asked.body, "token");
        expect(token).toBeTypeOf("string");
        await resolveApproval(domain.store, String(token), {
          status: "approved",
          by: await approverSubject("carol", "acme"),
        });
        expect(
          (
            await send(
              "alice",
              { op: "apiKey.revokeAll", org: "acme" },
              String(token),
            )
          ).status,
        ).toBe(204);
        expect(
          (
            await send(
              "alice",
              { op: "apiKey.revokeAll", org: "acme" },
              String(token),
            )
          ).status,
        ).toBe(403);
        expect(
          (await send("carol", { op: "apiKey.revokeAll", org: "acme" })).status,
        ).toBe(204);
      },
    );

    scenario(
      "stale-approval",
      "ignores an approval header meant for another request",
      async () => {
        expect(
          (
            await send(
              "bob",
              { op: "project.get", org: "acme", id: "p1" },
              "pd1.not-a-real-token",
            )
          ).status,
        ).toBe(200);
      },
    );

    scenario(
      "evaluations",
      "answers the decision endpoint in the path tenant",
      async () => {
        const result = await send("bob", {
          op: "evaluations",
          org: "acme",
          body: {
            evaluations: [
              {
                action: { name: "project.update" },
                resource: {
                  type: "project",
                  id: "p1",
                  properties: project("p1"),
                },
              },
              {
                action: { name: "project.update" },
                resource: {
                  type: "project",
                  id: "p2",
                  properties: project("p2"),
                },
              },
            ],
          },
        });
        expect(result.status).toBe(200);
        const rows = field(result.body, "evaluations");
        expect(
          Array.isArray(rows)
            ? rows.map((row: unknown) => field(row, "decision"))
            : rows,
        ).toStrictEqual([true, false]);
      },
    );

    scenario(
      "upload",
      "leaves a multipart body to the framework parser",
      async () => {
        const file = { name: "notes.txt", content: "hello" };
        const uploaded = await send("bob", {
          op: "project.upload",
          org: "acme",
          id: "p1",
          file,
        });
        expect(uploaded.status).toBe(201);
        expect(uploaded.body).toStrictEqual({ name: "notes.txt", size: 5 });
        expect(
          (
            await send("bob", {
              op: "project.upload",
              org: "acme",
              id: "p2",
              file,
            })
          ).status,
        ).toBe(403);
      },
    );

    scenario("sub-app", "protects a route inside a sub-app", async () => {
      expect(
        (await send("alice", { op: "admin.members", org: "acme" })).status,
      ).toBe(200);
      expect(
        (await send("bob", { op: "admin.members", org: "acme" })).status,
      ).toBe(403);
    });

    scenario(
      "parallel",
      "keeps 50 parallel requests with mixed subjects apart",
      async () => {
        const calls = Array.from({ length: 50 }, (_, index) => {
          const entry = PARALLEL[(index * 7) % PARALLEL.length];
          if (entry === undefined) {
            throw new Error("parallel table is empty");
          }
          return entry;
        });
        const statuses = await Promise.all(
          calls.map(
            async (entry) =>
              (
                await send(entry.user, {
                  op: "project.get",
                  org: entry.org,
                  id: entry.id,
                })
              ).status,
          ),
        );
        expect(statuses).toStrictEqual(calls.map((entry) => entry.status));
      },
    );

    scenario(
      "stream-revoked",
      "closes an open stream when the session is revoked",
      async () => {
        expect((await openStream(null, "acme", "p1")).status).toBe(401);
        const stream = await openStream(
          tokens.get("bob") ?? null,
          "acme",
          "p1",
        );
        try {
          expect(stream.status).toBe(200);
          expect((await stream.next())?.event).toBe("message");
          await domain.revocations.revoke({
            principal: "bob",
            kind: "session-revoked",
          });
          const end = await untilEnd(stream);
          expect(end.problem).toMatchObject({
            type: "about:blank",
            status: 401,
            detail: "session-revoked",
          });
          expect(end.ended).toBe(true);
        } finally {
          await stream.cancel();
        }
      },
    );

    scenario(
      "stream-demoted",
      "closes an open stream when a membership change re-denies it",
      async () => {
        const stream = await openStream(
          tokens.get("bob") ?? null,
          "acme",
          "p1",
        );
        const restore = domain.demote("bob", "acme");
        try {
          expect(stream.status).toBe(200);
          expect((await stream.next())?.event).toBe("message");
          await domain.revocations.revoke({
            principal: "bob",
            tenant: "acme",
            kind: "changed",
          });
          const end = await untilEnd(stream);
          expect(end.problem).toMatchObject({
            type: "https://permdock.com/problems/denied",
            status: 403,
          });
          expect(end.ended).toBe(true);
        } finally {
          restore();
          await stream.cancel();
        }
      },
    );

    scenario(
      "stream-filter",
      "drops the items a subscriber cannot read and keeps the stream open",
      async () => {
        const stream = await openStream(
          tokens.get("bob") ?? null,
          "acme",
          "p1",
        );
        try {
          expect(stream.status).toBe(200);
          const ids: string[] = [];
          while (ids.length < 7) {
            const frame = await stream.next();
            expect(frame?.event).toBe("message");
            ids.push(String(field(JSON.parse(frame?.data ?? "{}"), "id")));
          }
          expect(new Set(ids)).toStrictEqual(new Set(["p1", "p3", "p4"]));
        } finally {
          await stream.cancel();
        }
      },
    );

    scenario(
      "stream-expired",
      "closes an open stream when the token expires",
      async () => {
        const stream = await openStream(
          `Bearer ${await signSaasToken("bob", { memberships: false, ttl: 2 })}`,
          "acme",
          "p1",
        );
        try {
          expect(stream.status).toBe(200);
          expect((await stream.next())?.event).toBe("message");
          const end = await untilEnd(stream);
          expect(end.problem).toMatchObject({
            type: "about:blank",
            detail: "expired",
          });
          expect(end.ended).toBe(true);
        } finally {
          await stream.cancel();
        }
      },
      10_000,
    );
  });
}
