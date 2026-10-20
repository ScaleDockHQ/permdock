import type { Decision, DecideIdsOptions, LoadedRows } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  getPermDockSync,
  resource,
  role,
} from "permdock";

const permissions = definePermissions({
  post: resource({ id: "id", actions: ["read"] }),
});
const policy = definePolicy(permissions, {
  subject: () => null,
  roles: [role("reader", [allow(permissions.post.read)])],
});

declare const options: DecideIdsOptions;
declare const rows: LoadedRows;

export const permdock = getPermDockSync(policy, null);

export const decisions: Promise<readonly Decision[]> = permdock.decideIds(
  permissions.post.read,
  ["p1"],
  { data: () => rows },
);

// @ts-expect-error `data` is required: the server must load the rows itself.
permdock.decideIds(permissions.post.read, ["p1"], {});

// @ts-expect-error `trusted` is always true for loaded rows.
permdock.decideIds(permissions.post.read, ["p1"], {
  ...options,
  trusted: false,
});
