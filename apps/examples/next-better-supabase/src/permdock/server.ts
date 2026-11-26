import "server-only";
import { forbidden } from "next/navigation";
import {
  limits,
  memoryDecisionSink,
  memoryLimitStore,
  wrapPermDock,
} from "permdock";
import { subjectFromBetterSupabase } from "permdock/better-supabase";
import { createPermDock } from "permdock/next";
import { withOtel } from "permdock/otel";

import { bsb, freshMemberships } from "../lib/supabase/server.ts";
import { appPolicy } from "../policy.ts";
import {
  approvalStore,
  compiledRoles,
  stripeEntitlements,
  tenantOfRequest,
} from "./request.ts";

// `appPolicy` holds the plan and limit grants. RLS cannot compile either, so
// the authorizer and `permdock generate` keep `policy`.
export const {
  getPermDock,
  getSnapshot,
  PermDockProvider,
  permdockHandler,
  protectAction,
} = createPermDock(appPolicy, {
  subject: async () => subjectFromBetterSupabase((await bsb.cached()).session),
  tenant: tenantOfRequest,
  onDenied: () => {
    forbidden();
  },
  store: approvalStore,
  memberships: freshMemberships,
  customRoles: compiledRoles,
  entitlements: stripeEntitlements,
  limits: limits(memoryLimitStore()),
  sink: memoryDecisionSink(),
  otel: (instance) => withOtel(instance),
  wrap: (instance) => wrapPermDock(instance, () => ({})),
  version: async () => (await bsb.bootstrap({ rpc: "app" })).authzVersion,
  endpoint: "/api/permdock",
});
