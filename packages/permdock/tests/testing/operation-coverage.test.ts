import { describe } from "vitest";

import { operationPermissions } from "../../src/openapi/index.ts";
import { testOperationCoverage } from "../../src/testing/index.ts";
import { permissions } from "../fixtures/quick-start.ts";

describe(testOperationCoverage, () => {
  testOperationCoverage(
    operationPermissions({
      "GET /orgs/{org}/posts": permissions.post.list,
      "GET /health": permissions.post.list,
    }),
    { paths: { "/orgs/{orgId}/posts": { get: {} }, "/health": { get: {} } } },
    { tenantPaths: ["/orgs/{org}"] },
  );
});
