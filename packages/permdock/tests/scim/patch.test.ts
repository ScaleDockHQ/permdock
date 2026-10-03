import { describe, expect, it } from "vitest";

import type { ScimPatchOp } from "../../src/scim/types.ts";

import {
  normalizePatchOps,
  readPatchOperations,
} from "../../src/scim/patch.ts";
import { ROLES_EXTENSION } from "../../src/scim/types.ts";

describe("normalizePatchOps", () => {
  it.each<[string, unknown, readonly ScimPatchOp[]]>([
    [
      "op names case-insensitively",
      { op: "Replace", path: "userName", value: "ada" },
      [{ op: "replace", path: "userName", value: "ada" }],
    ],
    [
      "active strings to booleans",
      { op: "replace", path: "active", value: "False" },
      [{ op: "replace", path: "active", value: false }],
    ],
    [
      'active "TRUE"',
      { op: "replace", path: "active", value: "TRUE" },
      [{ op: "replace", path: "active", value: true }],
    ],
    [
      "an uncoercible active value as is",
      { op: "replace", path: "active", value: "maybe" },
      [{ op: "replace", path: "active", value: "maybe" }],
    ],
    [
      "a pathless scalar value",
      { op: "add", value: "x" },
      [{ op: "add", value: "x" }],
    ],
    [
      "a pathless object into one op per attribute",
      {
        op: "replace",
        value: {
          active: "false",
          displayName: "Eng",
          [ROLES_EXTENSION]: { roles: ["admin"] },
        },
      },
      [
        { op: "replace", path: "active", value: false },
        { op: "replace", path: "displayName", value: "Eng" },
        { op: "replace", path: "roles", value: ["admin"] },
      ],
    ],
    [
      "a pathless active boolean and an uncoercible one",
      { op: "replace", value: { active: true } },
      [{ op: "replace", path: "active", value: true }],
    ],
    [
      "a pathless uncoercible active",
      { op: "replace", value: { active: 3 } },
      [{ op: "replace", path: "active", value: 3 }],
    ],
    [
      "a pathless roles extension that is not an object",
      { op: "replace", value: { [ROLES_EXTENSION]: "admin" } },
      [{ op: "replace", path: ROLES_EXTENSION, value: "admin" }],
    ],
    [
      "the roles path",
      { op: "replace", path: "roles", value: ["a"] },
      [{ op: "replace", path: "roles", value: ["a"] }],
    ],
    [
      "the extension roles path with a colon",
      { op: "add", path: `${ROLES_EXTENSION}:roles`, value: ["a"] },
      [{ op: "add", path: "roles", value: ["a"] }],
    ],
    [
      "the extension roles path with a dot and an object value",
      {
        op: "replace",
        path: `${ROLES_EXTENSION}.roles`,
        value: { roles: ["b"] },
      },
      [{ op: "replace", path: "roles", value: ["b"] }],
    ],
    [
      "a filtered remove into a member list",
      { op: "remove", path: 'members[value eq "u_1"]' },
      [{ op: "remove", path: "members", value: [{ value: "u_1" }] }],
    ],
    [
      "a filtered add without a value",
      { op: "add", path: 'members[value eq "u_2"]' },
      [{ op: "add", path: "members", value: [{ value: "u_2" }] }],
    ],
    [
      "a filtered replace with a value",
      {
        op: "replace",
        path: 'emails[type eq "work"].value',
        value: [{ value: "a@b.c" }],
      },
      [{ op: "replace", path: "emails", value: [{ value: "a@b.c" }] }],
    ],
    [
      "a plain path",
      { op: "remove", path: "externalId" },
      [{ op: "remove", path: "externalId", value: undefined }],
    ],
    [
      "a non-string path as pathless",
      { op: "add", path: 7, value: "x" },
      [{ op: "add", value: "x" }],
    ],
  ])("normalizes %s", (_label, raw, expected) => {
    expect(normalizePatchOps([raw])).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["a non-object op", "replace"],
    ["an array op", [{ op: "add" }]],
    ["null", null],
    ["an unknown op", { op: "move", path: "a" }],
    ["a non-string op", { op: 1, path: "a" }],
  ])("rejects %s", (_label, raw) => {
    expect(normalizePatchOps([{ op: "add", value: 1 }, raw])).toBeUndefined();
  });
});

describe("readPatchOperations", () => {
  it.each<[unknown, readonly unknown[] | undefined]>([
    [{ Operations: [{ op: "add" }] }, [{ op: "add" }]],
    [{ operations: [] }, []],
    [{ Operations: "nope" }, undefined],
    [{}, undefined],
    [[], undefined],
    [null, undefined],
    ["text", undefined],
  ])("%j", (body, expected) => {
    expect(readPatchOperations(body)).toEqual(expected);
  });
});
