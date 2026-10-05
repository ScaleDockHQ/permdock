import { oc } from "@orpc/contract";
import { OpenAPIGenerator, openapi as route } from "@orpc/openapi";
import { call, implement, isDefinedError, ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { problemDetails, securityFor } from "../../src/openapi/index.ts";
import { createPermDock } from "../../src/orpc/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

type Ctx = { readonly user: typeof memberUser | null };

const byId = z.object({ id: z.string() });

const contract = {
  posts: {
    update: oc.input(byId).output(z.object({ id: z.string() })),
  },
};

describe("permdock/orpc with a contract", () => {
  it("protects a contract procedure with a declared output", async () => {
    const { permdock, protect } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.context.user,
    });
    const os = implement(contract).$context<Ctx>();
    const posts = new Map([
      [ownPost.id, ownPost],
      [otherPost.id, otherPost],
    ]);
    const update = os
      .use(permdock())
      .posts.update.use(
        protect(permissions.post.update, ({ input }) =>
          posts.get(byId.parse(input).id),
        ),
      )
      .handler(({ input }) => ({ id: input.id }));

    await expect(
      call(update, { id: ownPost.id }, { context: { user: memberUser } }),
    ).resolves.toEqual({ id: ownPost.id });
    await expect(
      call(update, { id: otherPost.id }, { context: { user: memberUser } }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it("gives the contract the security fragment the server hook gives", () => {
    const { openapi } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.context.user,
    });
    expect(securityFor(permissions.post.update)).toEqual(
      openapi.security(permissions.post.update),
    );
  });
});

const typed = {
  posts: {
    update: oc
      .meta(route({ method: "PATCH", path: "/posts/{id}" }))
      .errors({ FORBIDDEN: { status: 403, data: problemDetails } })
      .input(byId)
      .output(z.object({ id: z.string() })),
  },
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("permdock/orpc typed errors", () => {
  const { permdock, protect } = createPermDock<Ctx>(policy, {
    subject: (opts) => opts.context.user,
  });
  const os = implement(typed).$context<Ctx>();
  const posts = new Map([
    [ownPost.id, ownPost],
    [otherPost.id, otherPost],
  ]);
  const router = os.router({
    posts: {
      update: os
        .use(permdock())
        .posts.update.use(
          protect(permissions.post.update, ({ input }) =>
            posts.get(byId.parse(input).id),
          ),
        )
        .handler(({ input }) => ({ id: input.id })),
    },
  });

  it("throws the contract's FORBIDDEN as a defined error with Problem Details data", async () => {
    const error = await rejection(
      call(
        router.posts.update,
        { id: otherPost.id },
        { context: { user: memberUser } },
      ),
    );
    expect(error).toBeInstanceOf(ORPCError);
    if (!(error instanceof ORPCError) || !isDefinedError(error)) {
      throw new Error("expected a defined ORPCError");
    }
    expect(error.code).toBe("FORBIDDEN");
    expect(problemDetails["~standard"].validate(error.data)).toEqual({
      value: error.data,
    });
    expect(error.data).toMatchObject({
      status: 403,
      permission: "post.update",
    });
  });

  it("keeps a plain ORPCError when the contract declares no FORBIDDEN", async () => {
    const error = await rejection(
      call(
        implement(contract)
          .$context<Ctx>()
          .use(permdock())
          .posts.update.use(
            protect(permissions.post.update, ({ input }) =>
              posts.get(byId.parse(input).id),
            ),
          )
          .handler(({ input }) => ({ id: input.id })),
        { id: otherPost.id },
        { context: { user: memberUser } },
      ),
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect(error instanceof ORPCError && error.defined).toBe(false);
  });

  it("puts the Problem Details schema on the generated 403 response", async () => {
    const document = await new OpenAPIGenerator().generate(typed);
    const forbidden = JSON.stringify(
      document.paths?.["/posts/{id}"]?.patch?.responses?.["403"] ?? null,
    );
    expect(forbidden).toContain("#/components/schemas/Forbidden");
    expect(document.components?.schemas?.["Forbidden"]).toMatchObject({
      properties: {
        code: { const: "FORBIDDEN" },
        data: {
          description: "RFC 9457 Problem Details for a PermDock denial",
          required: ["type", "title", "status", "detail"],
        },
      },
    });
  });
});

describe("problemDetails", () => {
  const { validate, jsonSchema } = problemDetails["~standard"];

  it("accepts a PermDock problem with extension members", () => {
    const problem = {
      type: "https://permdock.com/problems/denied",
      title: "Forbidden",
      status: 403,
      detail: "denied",
      denials: [],
    };
    expect(validate(problem)).toEqual({ value: problem });
  });

  it("rejects anything else with a path per missing member", () => {
    expect(validate(null)).toEqual({
      issues: [{ message: "Expected a Problem Details object" }],
    });
    expect(validate([])).toHaveProperty("issues");
    const result = validate({ type: "x", title: "t", status: 200 });
    expect(result).toEqual({
      issues: [
        { message: "Expected a string", path: ["detail"] },
        { message: "Expected an HTTP error status", path: ["status"] },
      ],
    });
  });

  it("emits a JSON Schema for the common targets and throws for others", () => {
    for (const target of ["draft-2020-12", "draft-07", "openapi-3.0"]) {
      expect(jsonSchema.input({ target })).toMatchObject({
        type: "object",
        required: ["type", "title", "status", "detail"],
      });
    }
    expect(() => jsonSchema.output({ target: "draft-04" })).toThrow(
      "no JSON Schema for target draft-04",
    );
    const copy = jsonSchema.output({ target: "draft-07" });
    copy["type"] = "array";
    expect(jsonSchema.output({ target: "draft-07" })["type"]).toBe("object");
  });
});
