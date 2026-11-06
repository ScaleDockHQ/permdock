import { describe, expect, it } from "vitest";

import {
  operationsModule,
  routePath,
  routesFromSource,
} from "../../src/openapi/annotate-routes.ts";

describe("route annotation", () => {
  it("reads @permission, @permissionCheck and @oauthScopes", () => {
    const source = `/** @permission post.create
 * @permissionCheck handler
 * @oauthScopes posts:write posts:read
 */
export async function POST() {
  return new Response();
}
`;
    const routes = routesFromSource("app/orgs/[org]/posts/route.ts", source);
    expect(routePath("app/orgs/[org]/posts/route.ts")).toBe(
      "/orgs/{org}/posts",
    );
    expect(routes).toStrictEqual([
      {
        method: "POST",
        path: "/orgs/{org}/posts",
        permission: "post.create",
        check: "handler",
        oauthScopes: ["posts:write", "posts:read"],
      },
    ]);
    expect(operationsModule(routes)).toContain(
      '"POST /orgs/{org}/posts": { permission: permissions.post.create, oauthScopes: ["posts:write", "posts:read"], enforcement: "handler" },',
    );
  });
});
