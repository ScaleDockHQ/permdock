"use server";

import { decideRoleChange } from "permdock";
import { z } from "zod";

import { postgres } from "../../lib/supabase/server.ts";
import { getPermDock, protectAction } from "../../permdock/server.ts";
import { permissions } from "../../policy.ts";

const change = z.object({
  organizationId: z.uuid(),
  userId: z.uuid(),
  role: z.string().min(1),
  holders: z.number().int().nonnegative(),
});

async function decided(
  input: z.infer<typeof change>,
  kind: "assign" | "revoke",
) {
  const decision = decideRoleChange(
    await getPermDock({ tenant: input.organizationId, intent: "write" }),
    {
      kind,
      role: input.role,
      scope: "organization",
      id: input.organizationId,
      holders: input.holders,
      target: { id: input.userId },
    },
  );
  return { outcome: decision.outcome };
}

export const changeRole = protectAction(permissions.members.update_role, {
  input: change,
  tenant: (input) => input.organizationId,
})(async (input) => {
  const result = await decided(input, "assign");
  return result;
});

export const removeMember = protectAction(permissions.members.remove, {
  input: change,
  tenant: (input) => input.organizationId,
})(async (input) => {
  const result = await decided(input, "revoke");
  return result;
});

const invite = z.object({
  organizationId: z.uuid(),
  email: z.email(),
  role: z.string().min(1),
});

export const inviteMember = protectAction(permissions.members.invite, {
  input: invite,
  tenant: (input) => input.organizationId,
})(async (input) => {
  await postgres.admin.queryRaw(
    `insert into better_supabase.invitations
       (tenant_id, email, role, token_hash, expires_at)
     values ($1, $2, $3, gen_random_uuid()::text, now() + interval '7 days')`,
    [input.organizationId, input.email, input.role],
  );
  return { email: input.email };
});
