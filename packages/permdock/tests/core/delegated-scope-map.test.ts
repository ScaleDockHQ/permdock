import { describe, expect, it } from "vitest";

import { delegatedScopeMap } from "../../src/core/oauth-scopes.ts";

describe("delegatedScopeMap", () => {
  it("maps own scopes, former scopes and coarse scopes, sorted by code point", () => {
    expect(
      delegatedScopeMap(
        [
          { key: "task.update", scope: "task:update" },
          { key: "doc.read", scope: "doc:read", renamedFrom: ["doc.view"] },
          { key: "task.read", scope: "task:read" },
        ],
        [
          { scope: "mcp:write", permissions: ["task.update", "task.read"] },
          { scope: "mcp:read", permissions: ["task.read", "task.gone"] },
        ],
      ),
    ).toEqual({
      "doc:read": ["doc.read"],
      "doc:view": ["doc.read"],
      "mcp:read": ["task.read"],
      "mcp:write": ["task.read", "task.update"],
      "task:read": ["task.read"],
      "task:update": ["task.update"],
    });
  });

  it("drops a coarse scope whose keys the permissions do not list", () => {
    expect(
      delegatedScopeMap(
        [{ key: "task.read", scope: "task:read" }],
        [{ scope: "stale", permissions: ["task.gone"] }],
      ),
    ).toEqual({ "task:read": ["task.read"] });
  });
});
