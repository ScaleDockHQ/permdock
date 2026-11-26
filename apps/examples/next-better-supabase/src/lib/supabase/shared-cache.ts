import "server-only";
import type { AuthorizationRequest } from "better-supabase/server";
import type { Intent, Permission } from "permdock";

import { readFileSync } from "node:fs";
import path from "node:path";
import { isPermission } from "permdock";
import {
  authorizationHooks,
  authorizer,
  widenedKeys,
} from "permdock/better-supabase";

import { env } from "../../env.ts";
import { policy } from "../../policy.ts";
import { memberships, version } from "./runtime.ts";

const intent = (request: AuthorizationRequest<Permission>): Intent =>
  isPermission(request.action) &&
  ["read", "list", "view"].includes(request.action.action)
    ? "read"
    : "write";

export const authorization = authorizer({
  policy,
  memberships,
  version,
  intent,
});

function widened(): readonly string[] {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(process.cwd(), "permdock.manifest.json"), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || !("rls" in parsed)) {
    return [];
  }
  // SAFETY: inspect writes this file; widenedKeys reads rls.tableReads only.
  return widenedKeys(parsed as Parameters<typeof widenedKeys>[0]);
}

/** Off when a measurement build sets MEASURE_WITHOUT=shared-cache. */
export const sharedCache =
  env.without === "shared-cache"
    ? {}
    : { authorization: authorizationHooks({ policy, widened: widened() }) };
