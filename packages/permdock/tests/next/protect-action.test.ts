import type { StandardSchemaV1 } from "@standard-schema/spec";

import { redirect } from "next/navigation";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  memoryApprovalStore,
  resolveApproval,
} from "../../src/approvals/index.ts";
import { createPermDock } from "../../src/next/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const POSTS = new Map([ownPost, otherPost].map((post) => [post.id, post]));
const Rename = z.object({ id: z.string(), title: z.string().min(2) });

function guarded(subject: () => typeof memberUser | null = () => memberUser) {
  const { protectAction } = createPermDock(policy, { subject });
  return protectAction(permissions.post.update, {
    input: Rename,
    data: (input) => POSTS.get(input.id),
  });
}

describe("protectAction", () => {
  it("runs the handler with the loaded row on a grant", async () => {
    const rename = guarded()(async (input, { data, decision }) => ({
      id: data.id,
      title: input.title,
      outcome: decision.outcome,
    }));
    await expect(rename({ id: "p1", title: "Launch" })).resolves.toStrictEqual({
      ok: true,
      value: { id: "p1", title: "Launch", outcome: "granted" },
    });
  });

  it("answers a denial as Problem Details without running the handler", async () => {
    let ran = false;
    const rename = guarded()(() => {
      ran = true;
    });
    const result = await rename({ id: "p2", title: "Launch" });
    expect(ran).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      problem: { status: 403, permission: "post.update" },
    });
  });

  it("answers an anonymous caller with 401", async () => {
    const rename = guarded(() => null)(() => "never");
    await expect(rename({ id: "p1", title: "Launch" })).resolves.toMatchObject({
      ok: false,
      problem: { status: 401 },
    });
  });

  it("rejects invalid input with plain issues before loading anything", async () => {
    let loaded = false;
    const { protectAction } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const rename = protectAction(permissions.post.update, {
      input: Rename,
      data: (input) => {
        loaded = true;
        return POSTS.get(input.id);
      },
    })(() => "never");
    const result = await rename({ id: "p1", title: "x" });
    expect(loaded).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      problem: {
        type: "https://permdock.com/problems/validation",
        status: 400,
        issues: [{ path: ["title"] }],
      },
    });
    expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
  });

  it("answers a missing row with 404 and a throwing loader with 403", async () => {
    const missing = guarded()(() => "never");
    await expect(
      missing({ id: "nope", title: "Launch" }),
    ).resolves.toMatchObject({ ok: false, problem: { status: 404 } });
    const { protectAction } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const broken = protectAction(permissions.post.update, {
      input: Rename,
      data: () => {
        throw new Error("database down");
      },
    })(() => "never");
    const result = await broken({ id: "p1", title: "Launch" });
    expect(result).toMatchObject({ ok: false, problem: { status: 403 } });
    expect(JSON.stringify(result)).not.toContain("database down");
  });

  it("answers a throwing handler with 500 and lets Next.js interrupts through", async () => {
    const failing = guarded()(() => {
      throw new Error("secret stack");
    });
    const result = await failing({ id: "p1", title: "Launch" });
    expect(result).toMatchObject({ ok: false, problem: { status: 500 } });
    expect(JSON.stringify(result)).not.toContain("secret stack");

    const redirecting = guarded()(() => redirect("/posts"));
    await expect(redirecting({ id: "p1", title: "Launch" })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
  });

  it("denies when the subject cannot be resolved", async () => {
    const rename = guarded(() => {
      throw new Error("session store down");
    })(() => "never");
    await expect(rename({ id: "p1", title: "Launch" })).resolves.toMatchObject({
      ok: false,
      problem: { status: 401 },
    });
  });

  it("returns approval-required with a token and resumes once it is approved", async () => {
    const store = memoryApprovalStore();
    const { protectAction } = createPermDock(policy, {
      subject: () => memberUser,
      store,
    });
    const remove = protectAction(permissions.post.delete, {
      input: z.object({ id: z.string() }),
      data: (input) => POSTS.get(input.id),
      tenant: () => undefined,
    })(({ id }) => `deleted ${id}`);

    const pending = await remove({ id: "p1" });
    expect(pending).toMatchObject({
      ok: false,
      problem: {
        type: "https://permdock.com/problems/approval-required",
        status: 403,
      },
    });
    const token = pending.ok ? undefined : pending.problem.token;
    expect(token).toBeTypeOf("string");
    if (typeof token !== "string") {
      return;
    }
    await expect(
      remove({ id: "p1" }, { approval: token }),
    ).resolves.toMatchObject({ ok: false, problem: { status: 403 } });
    await resolveApproval(store, token, {
      status: "approved",
      by: { principal: { id: "u9", roles: ["admin"] }, context: {} },
    });
    await expect(
      remove({ id: "p1" }, { approval: token }),
    ).resolves.toStrictEqual({ ok: true, value: "deleted p1" });
  });

  it("keeps object, number and symbol issue paths as JSON", async () => {
    const { protectAction } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const rejecting: StandardSchemaV1<unknown, never> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({
          issues: [
            { message: "nested", path: [{ key: "items" }, 0, Symbol("tag")] },
            { message: "root" },
          ],
        }),
      },
    };
    const result = await protectAction(permissions.post.read, {
      input: rejecting,
    })(() => "never")({});
    expect(result).toMatchObject({
      ok: false,
      problem: {
        issues: [
          { message: "nested", path: ["items", 0, "Symbol(tag)"] },
          { message: "root" },
        ],
      },
    });
  });

  it("denies without a loader, and when the tenant resolver throws", async () => {
    const { protectAction } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const publish = protectAction(permissions.post.publish, {
      input: z.object({}),
    })(() => "never");
    await expect(publish({})).resolves.toMatchObject({
      ok: false,
      problem: { status: 403, permission: "post.publish" },
    });
    const tenantless = protectAction(permissions.post.read, {
      input: z.object({}),
      tenant: () => {
        throw new Error("no tenant");
      },
    })(() => "never");
    await expect(tenantless({})).resolves.toMatchObject({
      ok: false,
      problem: { status: 403 },
    });
  });

  it("validates async Standard Schemas", async () => {
    const { protectAction } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const Async = z.object({ id: z.string() }).refine(async () => true);
    const read = protectAction(permissions.post.read, { input: Async })(
      ({ id }) => id,
    );
    await expect(read({ id: "p1" })).resolves.toStrictEqual({
      ok: true,
      value: "p1",
    });
  });
});
