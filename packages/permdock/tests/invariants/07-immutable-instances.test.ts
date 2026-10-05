import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createPermDock } from "../../src/index.ts";
import {
  adminUser,
  memberUser,
  otherPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const src = path.join(import.meta.dirname, "../../src");

function sources(dir: string): string[] {
  return readdirSync(path.join(src, dir), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => path.join(dir, file));
}

const coreSources = [...sources("core"), ...sources("conditions")];

/** Process-wide memo caches of values that never depend on a request. */
const MEMO_CACHES: Readonly<Record<string, string>> = {
  [path.join("jwt", "load-jose.ts")]: "the optional jose module promise",
  [path.join("cli", "package-root.ts")]: "the permdock package directory",
  [path.join("cli", "openapi-schema.ts")]: "compiled JSON Schema validators",
};

function moduleState(file: string): string[] {
  const text = readFileSync(path.join(src, file), "utf8");
  const offenders: string[] = [];
  if (/^(?:export )?(?:let|var) /mu.test(text)) {
    offenders.push(`${file}: top-level let or var`);
  }
  if (text.includes("AsyncLocalStorage")) {
    offenders.push(`${file}: AsyncLocalStorage`);
  }
  for (const [, name] of text.matchAll(
    /^const (\w+) = new (?:Map|Set|WeakMap|WeakSet)\b/gmu,
  )) {
    if (
      new RegExp(`\\b${name}\\.(?:add|set|delete|clear)\\(`, "u").test(text)
    ) {
      offenders.push(`${file}: ${name} is mutated`);
    }
  }
  return offenders;
}

describe("invariant 7: immutable, request-scoped instances", () => {
  it("freezes the instance and its subject", async () => {
    const permdock = await createPermDock(policy, memberUser);
    expect(Object.isFrozen(permdock)).toBe(true);
    expect(Object.isFrozen(permdock.subject)).toBe(true);
    expect(Object.isFrozen(permdock.subject.principal)).toBe(true);
  });

  it("keeps two instances apart", async () => {
    const member = await createPermDock(policy, memberUser);
    const admin = await createPermDock(policy, adminUser);
    expect(member.can(permissions.post.update, otherPost)).toBe(false);
    expect(admin.can(permissions.post.update, otherPost)).toBe(true);
    expect(member.can(permissions.post.update, otherPost)).toBe(false);
  });

  it("delivers events only to the instance they were registered on", async () => {
    const member = await createPermDock(policy, memberUser);
    const admin = await createPermDock(policy, adminUser);
    const onMember = vi.fn<(payload: unknown) => void>();
    const onAdmin = vi.fn<(payload: unknown) => void>();
    member.on("decision", onMember);
    admin.on("decision", onAdmin);
    admin.can(permissions.post.publish, otherPost, { trusted: true });
    expect(onMember).not.toHaveBeenCalled();
    expect(onAdmin).toHaveBeenCalledTimes(1);
  });

  it("does not let a caller mutate the user it was built from", async () => {
    const user = { id: "u1", orgId: "o1", roles: ["member"] };
    const permdock = await createPermDock(policy, user);
    user.roles.push("admin");
    expect(permdock.can(permissions.post.publish, otherPost)).toBe(false);
  });

  it("holds no module-level mutable state in core", () => {
    expect(coreSources.flatMap(moduleState)).toEqual([]);
  });

  it("holds module-level state elsewhere in src only as a listed memo cache", () => {
    const offenders = sources("")
      .filter((file) => !(file in MEMO_CACHES))
      .flatMap(moduleState);
    expect(offenders).toEqual([]);
    expect(
      Object.keys(MEMO_CACHES).filter((file) => moduleState(file).length === 0),
    ).toEqual([]);
  });
});
