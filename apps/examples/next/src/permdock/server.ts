import { createPermDock } from "permdock/next";

import { currentUser } from "../lib/session.ts";
import { policy } from "../policy.ts";

// Server-only: Server Components, Server Actions and Route Handlers import
// from here; client components import hooks from permdock/react.
export const {
  getPermDock,
  getPermission,
  getSnapshot,
  requirePermission,
  protectAction,
  permdockHandler,
  PermDockProvider,
} = createPermDock(policy, { subject: currentUser });
