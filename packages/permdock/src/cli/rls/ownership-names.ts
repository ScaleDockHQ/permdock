/**
 * Objects the ownership rules add next to the helpers. Names are part of the
 * SQL contract.
 */
export const OWNERSHIP = {
  canAssign: "permdock_can_assign",
  canAssignFor: "permdock_can_assign_for",
  canAssignAny: "permdock_can_assign_any",
  canAssignAnyFor: "permdock_can_assign_any_for",
  holders: "permdock_holders",
  transferOnly: "permdock_transfer_only",
} as const;

/** Objects `rls.assignments` adds. Names are part of the SQL contract. */
export const ASSIGNMENTS = {
  custom: "permdock_can_assign_custom_role",
  customFor: "permdock_can_assign_custom_role_for",
  trigger: "permdock_assignment",
} as const;
