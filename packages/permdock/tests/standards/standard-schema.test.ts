import type { StandardSchemaV1 } from "@standard-schema/spec";

import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { jsonSchemaOf } from "../../src/cli/catalog-doc.ts";
import { PermDockValidationError } from "../../src/core/errors.ts";
import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

type Post = { readonly id: string; readonly title: string };

/** A dependency-free implementer: trims `title`, so a rule sees the parsed value. */
function handWritten(
  extra: Readonly<Record<string, unknown>> = {},
): StandardSchemaV1<unknown, Post> {
  return {
    "~standard": {
      version: 1,
      vendor: "hand-written",
      validate: (value) => {
        if (
          value !== null &&
          typeof value === "object" &&
          "id" in value &&
          typeof value.id === "string" &&
          "title" in value &&
          typeof value.title === "string"
        ) {
          return { value: { id: value.id, title: value.title.trim() } };
        }
        return {
          issues: [{ message: "expected a post", path: [{ key: "title" }] }],
        };
      },
      ...extra,
    },
  };
}

const validators: readonly {
  readonly vendor: string;
  readonly schema: StandardSchemaV1<unknown, Post>;
}[] = [
  { vendor: "hand-written", schema: handWritten() },
  {
    vendor: "zod",
    schema: z.object({ id: z.string(), title: z.string().trim() }),
  },
  {
    vendor: "valibot",
    schema: v.object({ id: v.string(), title: v.pipe(v.string(), v.trim()) }),
  },
];

function setup(
  schema: StandardSchemaV1<unknown, Post>,
  validate?: "boundary" | "always" | "never",
) {
  const permissions = definePermissions({
    post: resource(schema, { actions: ["read", "update"] }),
  });
  const policy = definePolicy(permissions, {
    roles: [
      role("member", [
        allow(permissions.post.update, { where: { title: "Hello" } }),
        allow(permissions.post.read),
      ]),
    ],
    subject: () => ({ id: "u1", roles: ["member"] }),
    ...(validate === undefined ? {} : { validate }),
  });
  return { permissions, policy };
}

describe("Standard Schema", () => {
  for (const { vendor, schema } of validators) {
    describe(vendor, () => {
      it("reports its vendor and version 1", () => {
        expect(schema["~standard"]).toMatchObject({ version: 1, vendor });
      });

      it("keeps the schema off the plain JSON leaf", () => {
        const { permissions } = setup(schema);
        const leaf = permissions.post.update;
        expect(Object.isFrozen(leaf)).toBe(true);
        expect(Object.keys(leaf).toSorted()).toEqual(
          ["action", "key", "meta", "resource", "scope"].toSorted(),
        );
        expect(JSON.stringify(leaf)).not.toContain("~standard");
      });

      it("hands the rule the validated value", async () => {
        const { permissions, policy } = setup(schema);
        const permdock = await createPermDock(policy, { id: "u1" });
        const post = { id: "p1", title: "  Hello  " };
        expect(
          permdock.can(permissions.post.update, post, { trusted: false }),
        ).toBe(true);
        expect(
          permdock.can(permissions.post.update, post, { trusted: true }),
        ).toBe(false);
      });

      it("turns issues into a validation denial that carries them", async () => {
        const { permissions, policy } = setup(schema);
        const permdock = await createPermDock(policy, { id: "u1" });
        const decision = permdock.decide(
          permissions.post.read,
          { id: "p1", title: 7 },
          { trusted: false },
        );
        expect(decision.outcome).toBe("denied");
        if (decision.outcome !== "denied") {
          return;
        }
        const [denial] = decision.denials;
        expect(denial?.reason).toBe("validation");
        expect(denial?.detail).toBeInstanceOf(PermDockValidationError);
        if (!(denial?.detail instanceof PermDockValidationError)) {
          return;
        }
        expect(denial.detail.code).toBe("invalid-data");
        expect(denial.detail.issues.length).toBeGreaterThan(0);
        expect(denial.detail.issues[0]?.message).toBeTypeOf("string");
      });
    });
  }

  it("validates only untrusted data by default, everything with always, nothing with never", async () => {
    const bad = { id: "p1", title: 7 };
    const boundary = setup(handWritten());
    const always = setup(handWritten(), "always");
    const never = setup(handWritten(), "never");
    const [b, a, n] = await Promise.all([
      createPermDock(boundary.policy, { id: "u1" }),
      createPermDock(always.policy, { id: "u1" }),
      createPermDock(never.policy, { id: "u1" }),
    ]);
    expect(b.can(boundary.permissions.post.read, bad, { trusted: true })).toBe(
      true,
    );
    expect(b.can(boundary.permissions.post.read, bad, { trusted: false })).toBe(
      false,
    );
    expect(a.can(always.permissions.post.read, bad, { trusted: true })).toBe(
      false,
    );
    expect(n.can(never.permissions.post.read, bad, { trusted: false })).toBe(
      true,
    );
  });

  it("refuses an async validator instead of silently denying, and can() still never throws", async () => {
    const asyncSchema: StandardSchemaV1<unknown, Post> = {
      "~standard": {
        version: 1,
        vendor: "async",
        validate: () =>
          Promise.resolve({ value: { id: "p1", title: "Hello" } }),
      },
    };
    const { permissions, policy } = setup(asyncSchema);
    const permdock = await createPermDock(policy, { id: "u1" });
    const post = { id: "p1", title: "Hello" };
    expect(() =>
      permdock.decide(permissions.post.read, post, { trusted: false }),
    ).toThrow(
      expect.objectContaining({
        name: "PermDockValidationError",
        code: "async-schema",
      }),
    );
    expect(permdock.can(permissions.post.read, post, { trusted: false })).toBe(
      false,
    );
  });

  describe("Standard JSON Schema export", () => {
    it("asks the converter for draft 2020-12 output", () => {
      const targets: unknown[] = [];
      const schema = handWritten({
        jsonSchema: {
          input: () => ({ type: "object" }),
          output: (options: unknown) => {
            targets.push(options);
            return { type: "object", properties: { id: { type: "string" } } };
          },
        },
      });
      const { policy } = setup(schema);
      const node = policy.resources.get("post");
      expect(node).toBeDefined();
      if (node === undefined) {
        return;
      }
      expect(jsonSchemaOf(node)).toEqual({
        type: "object",
        properties: { id: { type: "string" } },
      });
      expect(targets).toEqual([{ target: "draft-2020-12" }]);
    });

    it("exports Zod output as a 2020-12 JSON Schema", () => {
      const { policy } = setup(
        z.object({ id: z.string(), title: z.string().trim() }),
      );
      const node = policy.resources.get("post");
      expect(node && jsonSchemaOf(node)).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["id", "title"],
      });
    });

    it("exports null without a converter or when the converter throws", () => {
      const plain = setup(handWritten()).policy.resources.get("post");
      const throwing = setup(
        handWritten({
          jsonSchema: {
            input: () => ({}),
            output: () => {
              throw new Error("unsupported target");
            },
          },
        }),
      ).policy.resources.get("post");
      expect(plain && jsonSchemaOf(plain)).toBeNull();
      expect(throwing && jsonSchemaOf(throwing)).toBeNull();
    });
  });
});
