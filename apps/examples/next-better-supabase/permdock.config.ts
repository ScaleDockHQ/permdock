import { defineConfig } from "permdock/cli";
import { rls } from "permdock/cli/plugins/rls";

import { permissions } from "./src/permissions.ts";
import { policy } from "./src/policy.ts";
import { sources } from "./src/sources.ts";

const { quotes } = permissions;

export default defineConfig({
  permissions,
  policy,
  plugins: [
    rls({
      target: "sql",
      split: ["helpers", "seeds", "indexes", "policies", "hook"],
      seeds: { out: "supabase/migrations/" },
    }),
  ],
  // orgQuotesTopic and quoteFilesPath, from the realtime and storage blocks below.
  gen: { kinds: ["constants"], out: "src/generated" },
  rls: {
    authorize: "database",
    actions: { manage: "none", revert: "none" },
    scopeTypes: { tenant: "uuid" },
    // `audit` names better-supabase's audit block keys; the block owns its table and policies.
    // The blocks own their tables and policies. These resources exist so the
    // provider can name their keys; they are not public tables.
    tables: {
      staff: "staff",
      quotes: "quotes",
      audit: false,
      members: false,
      organization: false,
      teams: false,
      settings: false,
      approvals: false,
      access_requests: false,
      impersonation: false,
      api_keys: false,
      service_accounts: false,
      usage: false,
      sso: false,
      relations: false,
      automations: false,
      billing: false,
    },
    readOnlyActors: true,
    // A suspended organization drops its memberships and lists the tenant in `suspended_in`.
    suspension: {
      scopes: {
        organization: {
          table: "organizations",
          id: "id",
          status: "status",
          active: ["active"],
        },
      },
    },
    // Out-of-office covers: a delegate approves for the delegator inside a window.
    // The store is the approvals block's table, not a second one.
    approvals: {
      delegations: true,
      table: "better_supabase.approval_requests",
    },
    apiKeys: true,
    assignments: {
      tables: [
        {
          table: "better_supabase.invitations",
          scope: "organization",
          id: "tenant_id",
          role: "role",
        },
      ],
    },
    // The guest quote page reads through an exchanged share-link capability.
    capabilities: true,
    // The app keeps each custom role's entries in `public.role_permissions`; a trigger copies them.
    customRoles: {
      from: {
        sync: "trigger",
        permissions: {
          table: "role_permissions",
          role: { through: "roles", on: { role_id: "id" }, column: "key" },
          permission: "permission",
        },
      },
    },
    trustedReaders: ["service_role"],
    customRoleWrites: {
      requires: ["roles.manage"],
      roles: {
        table: "roles",
        key: "key",
        tenant: "organization_id",
        skip: "is_system",
        primaryKey: "id",
      },
      audit: {
        function: "better_supabase.audit_event_trusted",
        args: { source: "permdock" },
      },
    },
    // supabase.channel(topics.orgQuotes({ organization }), { config: { private: true } })
    realtime: {
      topics: {
        "org:{organization}:quotes": {
          read: quotes.read,
          write: quotes.update,
        },
      },
    },
    // objects named `<organization id>/<quote id>.pdf`
    storage: {
      buckets: {
        "quote-files": {
          scope: "organization",
          read: quotes.read,
          write: quotes.update,
          delete: quotes.update,
        },
      },
    },
  },
  supabase: {
    hook: {
      memberships: sources(),
      claims: {
        datetime_preferences: "public.datetime_preference_claims",
        features: "public.feature_claims",
      },
    },
  },
});
