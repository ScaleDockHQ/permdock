import { createPermDock } from "permdock/solid-start";

import { memberUser, policy } from "./policy.ts";

export const { middleware, protect, withPermDock, permdockHandler } =
  createPermDock(policy, { subject: () => memberUser });
