import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";

const dirs: string[] = [];

describe("openapi annotate --routes through run", () => {
  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the operations module from route comments", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-routes-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, "app/posts"), { recursive: true });
    writeFileSync(join(cwd, "permdock.config.ts"), "export default {};\n");
    writeFileSync(
      join(cwd, "app/posts/route.ts"),
      "/** @permission post.create */\nexport async function POST() {\n  return new Response();\n}\n",
    );
    const result = await run([
      "openapi",
      "annotate",
      "--routes",
      "app/**/route.ts",
      "--out",
      "ops.ts",
      "--cwd",
      cwd,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("wrote ops.ts (1 operations)");
    expect(readFileSync(join(cwd, "ops.ts"), "utf8")).toContain("post.create");
  });

  it("writes x-authorization and x-oauth-scopes into the spec with --write-spec", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-routes-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, "app/orgs/[org]/posts"), { recursive: true });
    writeFileSync(join(cwd, "permdock.config.ts"), "export default {};\n");
    writeFileSync(
      join(cwd, "app/orgs/[org]/posts/route.ts"),
      [
        "/**",
        " * @permission post.create",
        " * @permissionCheck handler",
        " * @oauthScopes posts:write",
        " */",
        "export async function POST() {",
        "  return new Response();",
        "}",
        "/** @permission post.delete */",
        "export async function DELETE() {",
        "  return new Response();",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "openapi.yaml"),
      [
        "openapi: 3.1.0",
        "paths:",
        "  /orgs/{org}/posts:",
        "    # create a post",
        "    post:",
        "      operationId: createPost",
        "",
      ].join("\n"),
    );
    const result = await run([
      "openapi",
      "annotate",
      "--routes",
      "app/**/route.ts",
      "--write-spec",
      "openapi.yaml",
      "--cwd",
      cwd,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("operation-not-in-spec");
    const spec = readFileSync(join(cwd, "openapi.yaml"), "utf8");
    expect(spec).toContain("# create a post");
    expect(spec).toContain("permission: post.create");
    expect(spec).toContain("check: handler");
    expect(spec).toContain("- posts:write");
    expect(spec).not.toContain("delete:");
  });
});
