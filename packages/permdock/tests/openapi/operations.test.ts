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

  it("matches a HEAD request to the GET entry of its path when no HEAD entry matches", () => {
    expect(operations.forRequest("HEAD", "/api/v1/posts/p1")?.key).toBe(
      "post.read",
    );
    expect(operations.forRequest("head", "/api/v1/posts")?.key).toBe(
      "post.list",
    );
    expect(operations.forRequest("HEAD", "/api/v1/nope")).toBeUndefined();
    const withHead = operationPermissions({
      "GET /posts/{id}": permissions.post.read,
      "HEAD /posts/{id}": permissions.post.list,
      "GET /drafts": { oauthScopes: ["api:read"] },
    });
    expect(withHead.forRequest("HEAD", "/posts/p1")?.key).toBe("post.list");
    expect(withHead.forRequest("HEAD", "/drafts")).toBeUndefined();
    expect(withHead.oauthScopesForRequest("HEAD", "/drafts")).toEqual([
      "api:read",
    ]);
    expect(operations.forRequest("POST", "/api/v1/posts/p1")).toBeUndefined();
  });

  it("answers an operation id, as a tool name", () => {
    expect(operations.forOperation("get_post")?.key).toBe("post.read");
    expect(operations.forOperation("create_post")?.key).toBe("post.create");
    expect(operations.forOperation("nope")).toBeUndefined();
  });

  it("answers the OAuth scopes an operation declares, by request or operation id", () => {
    const scoped = operationPermissions(
      {
        "GET /exports/{id}": {
          permission: permissions.post.read,
          operationId: "get_export",
          oauthScopes: ["api:read"],
        },
        "POST /exports": {
          permission: permissions.post.read,
          operationId: "create_export",
          oauthScopes: ["api:write"],
        },
        "GET /posts": permissions.post.list,
      },
      { base: "/api" },
    );
    expect(scoped.oauthScopesForRequest("GET", "/api/exports/e1")).toEqual([
      "api:read",
    ]);
    expect(scoped.oauthScopesForRequest("POST", "/api/exports")).toEqual([
      "api:write",
    ]);
    expect(scoped.oauthScopesForRequest("GET", "/api/posts")).toBeUndefined();
    expect(scoped.oauthScopesForRequest("GET", "/nope")).toBeUndefined();
    expect(scoped.oauthScopesForOperation("create_export")).toEqual([
      "api:write",
    ]);
    expect(scoped.oauthScopesForOperation("nope")).toBeUndefined();
    expect(() =>
      operationPermissions({
        "GET /posts": { permission: permissions.post.list, oauthScopes: [] },
      }),
    ).toThrow(/oauthScopes/u);
  });

  it("declares OAuth scopes for an operation without a permission", () => {
    const scoped = operationPermissions({
      "POST /chat": { oauthScopes: ["api:chat"], operationId: "chat" },
    });
    expect(scoped.forRequest("POST", "/chat")).toBeUndefined();
    expect(scoped.forOperation("chat")).toBeUndefined();
    expect(scoped.oauthScopesForRequest("POST", "/chat")).toEqual(["api:chat"]);
    expect(scoped.oauthScopesForOperation("chat")).toEqual(["api:chat"]);
    expect(() =>
      // SAFETY: an untyped caller declaring an operation with neither a permission nor scopes.
      operationPermissions({ "POST /chat": { operationId: "chat" } as never }),
    ).toThrow("needs a permission, oauthScopes or both");
    expect(() =>
      operationPermissions({
        // SAFETY: an untyped caller passing a key where a permission belongs.
        "POST /chat": { permission: "chat" as never, oauthScopes: ["x"] },
      }),
    ).toThrow("needs a permission, oauthScopes or both");
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
