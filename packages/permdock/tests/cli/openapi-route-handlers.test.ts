import { describe, expect, it } from "vitest";

import {
  routePath,
  routesFromSource,
} from "../../src/cli/openapi/route-handlers.ts";

describe("route handler annotations", () => {
  it("reads the paths of the root route, groups and an optional catch-all", () => {
    expect(routePath("app/route.ts")).toBe("/");
    expect(routePath("src/app/(site)/route.ts")).toBe("/");
    expect(routePath("app/docs/[[...slug]]/route.ts")).toBe("/docs/{slug}");
    expect(routePath("app/files/[...path]/route.ts")).toBe("/files/{path}");
    expect(routePath("app/page.tsx")).toBeUndefined();
  });

  it("attaches only the JSDoc block directly above each export", () => {
    const source = `/**
 * Posts API.
 * @permission post.read
 */
import { handler } from "./handler.ts";

/** @oauthScopes posts:write */
export async function POST() {
  return new Response();
}

export function GET() {
  return new Response();
}
`;
    expect(routesFromSource("app/posts/route.ts", source)).toStrictEqual([
      { method: "POST", path: "/posts", oauthScopes: ["posts:write"] },
    ]);
  });

  it("reads export const and export { handler as METHOD }", () => {
    const source = `/** @permission post.update */
export const PATCH = async () => new Response();

/** @permission post.delete
 * @permissionCheck kernel
 */
async function remove() {
  return new Response();
}

/** @oauthScopes posts:read */
const read = async () => new Response();

export { remove as DELETE, read as GET };
`;
    expect(routesFromSource("app/posts/[id]/route.ts", source)).toStrictEqual([
      { method: "PATCH", path: "/posts/{id}", permission: "post.update" },
      {
        method: "DELETE",
        path: "/posts/{id}",
        permission: "post.delete",
        check: "kernel",
      },
      { method: "GET", path: "/posts/{id}", oauthScopes: ["posts:read"] },
    ]);
  });

  it("skips a handler named in a comment or a string", () => {
    const source = `// /** @permission post.read */ export function GET() {}
export const doc = "/** @permission post.read */ export function GET() {}";
`;
    expect(routesFromSource("app/posts/route.ts", source)).toStrictEqual([]);
  });
});
