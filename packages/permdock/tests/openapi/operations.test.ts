import { describe, expect, it } from "vitest";

import {
  operationPermissions,
  operationPermissionsFromOpenApi,
} from "../../src/openapi/index.ts";
import { permissions } from "../fixtures/quick-start.ts";

describe("operationPermissions", () => {
  const operations = operationPermissions(
    {
      "GET /posts": permissions.post.list,
      "POST /posts": {
        permission: permissions.post.create,
        operationId: "create_post",
      },
      "GET /posts/{id}": {
        permission: permissions.post.read,
        operationId: "get_post",
      },
      "GET /posts/drafts": permissions.post.update,
      "delete /posts/{id}": permissions.post.delete,
    },
    { base: "/api/v1" },
  );

  it("matches a request by method and template, a literal segment first", () => {
    expect(operations.forRequest("get", "/api/v1/posts")?.key).toBe(
      "post.list",
    );
    expect(operations.forRequest("GET", "/api/v1/posts/p1?x=1")?.key).toBe(
      "post.read",
    );
    expect(operations.forRequest("GET", "/api/v1/posts/drafts/")?.key).toBe(
      "post.update",
    );
    expect(operations.forRequest("DELETE", "/api/v1/posts/p1")?.key).toBe(
      "post.delete",
    );
    expect(operations.forRequest("PATCH", "/api/v1/posts/p1")).toBeUndefined();
    expect(operations.forRequest("GET", "/other/posts")).toBeUndefined();
    expect(
      operations.forRequest("GET", "/api/v1/posts/p1/comments"),
    ).toBeUndefined();
  });

  it("answers an operation id, as a tool name", () => {
    expect(operations.forOperation("get_post")?.key).toBe("post.read");
    expect(operations.forOperation("create_post")?.key).toBe("post.create");
    expect(operations.forOperation("nope")).toBeUndefined();
  });

  it("refuses a key that is not a method and a path", () => {
    expect(() =>
      operationPermissions({ "/posts": permissions.post.list }),
    ).toThrow("must be a method and a path");
    expect(() =>
      operationPermissions({ "FETCH /posts": permissions.post.list }),
    ).toThrow("must be a method and a path");
  });

  it("reads x-permdock-permissions from an OpenAPI document", () => {
    const fromDocument = operationPermissionsFromOpenApi(
      {
        paths: {
          "/posts/{id}": {
            parameters: [],
            get: {
              operationId: "get_post",
              "x-permdock-permissions": ["post.read"],
            },
            delete: { "x-permdock-permissions": ["post.delete"] },
            put: { "x-permdock-permissions": ["post.update", "post.publish"] },
            patch: { "x-permdock-permissions": ["nope.read"] },
          },
          "/broken": "x",
        },
      },
      permissions,
    );
    expect(fromDocument.forOperation("get_post")?.key).toBe("post.read");
    expect(fromDocument.forRequest("DELETE", "/posts/p1")?.key).toBe(
      "post.delete",
    );
    expect(fromDocument.forRequest("PUT", "/posts/p1")).toBeUndefined();
    expect(fromDocument.forRequest("PATCH", "/posts/p1")).toBeUndefined();
    expect(
      operationPermissionsFromOpenApi(null, permissions).forOperation("x"),
    ).toBeUndefined();
  });
});
