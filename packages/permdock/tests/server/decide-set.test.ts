import { describe, expect, it } from "vitest";

import type { Decision } from "../../src/core/decision.ts";
import type { Permission } from "../../src/core/permission-types.ts";

import { getPermDockSync } from "../../src/index.ts";
import { decideSet, permissionList } from "../../src/server/decide-set.ts";
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const granted = getPermDockSync(policy, memberUser).decide(
  permissions.post.read,
  ownPost,
);
const denied: Decision = {
  outcome: "denied",
  denials: [{ role: "member", reason: "condition" }],
  alternatives: [],
};

function decider(grants: Readonly<Record<string, readonly string[]>>) {
  const calls: { readonly key: string; readonly rows: readonly unknown[] }[] =
    [];
  const decide = (permission: Permission, rows: readonly unknown[]) => {
    calls.push({ key: permission.key, rows });
    return Promise.resolve(
      rows.map((row) =>
        typeof row === "string" &&
        grants[permission.key]?.includes(row) === true
          ? granted
          : denied,
      ),
    );
  };
  return { calls, decide };
}

const { read, update, publish } = permissions.post;

describe(decideSet, () => {
  it("grants all-of only when every permission grants every row", async () => {
    const { decide } = decider({
      "post.read": ["a", "b"],
      "post.update": ["a", "b"],
    });
    await expect(
      decideSet([read, update], ["a", "b"], false, decide),
    ).resolves.toMatchObject({ ok: true });
  });

  it("stops all-of at the first refused row and does not ask later permissions", async () => {
    const { calls, decide } = decider({
      "post.read": ["a"],
      "post.update": ["a", "b"],
    });
    await expect(
      decideSet([read, update], ["a", "b"], false, decide),
    ).resolves.toMatchObject({
      ok: false,
      permission: { key: "post.read" },
      row: "b",
    });
    expect(calls.map((call) => call.key)).toStrictEqual(["post.read"]);
  });

  it("asks a later anyOf permission only for the rows still refused", async () => {
    const { calls, decide } = decider({
      "post.publish": ["a"],
      "post.update": ["b"],
    });
    await expect(
      decideSet([publish, update], ["a", "b"], true, decide),
    ).resolves.toMatchObject({ ok: true });
    expect(calls).toStrictEqual([
      { key: "post.publish", rows: ["a", "b"] },
      { key: "post.update", rows: ["b"] },
    ]);
  });

  it("reports the first permission's decision for the first row anyOf leaves refused", async () => {
    const { decide } = decider({ "post.update": ["a"] });
    await expect(
      decideSet([publish, update], ["a", "b"], true, decide),
    ).resolves.toStrictEqual({
      ok: false,
      decision: denied,
      permission: publish,
      row: "b",
    });
  });

  it("denies with validation when a decider answers too few decisions", async () => {
    const short = () => Promise.resolve([]);
    await expect(decideSet([read], ["a"], false, short)).resolves.toMatchObject(
      {
        ok: false,
        decision: { denials: [{ role: null, reason: "validation" }] },
      },
    );
  });

  it("denies an empty row set", async () => {
    const { decide } = decider({});
    await expect(decideSet([read], [], false, decide)).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe(permissionList, () => {
  it("wraps one permission and refuses an empty list", () => {
    expect(permissionList(read)).toStrictEqual([read]);
    expect(() => permissionList([])).toThrow(TypeError);
  });
});
