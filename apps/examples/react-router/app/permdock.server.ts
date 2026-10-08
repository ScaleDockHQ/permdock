import { createPermDock } from "permdock/server";

import { memberUser, policy } from "./policy.ts";

export const { getSnapshot, permdockHandler } = createPermDock(policy, {
  // A real app reads its session here; the example signs everyone in as the member.
  subject: () => memberUser,
});
