"use client";

import {
  authzChangeRefresh,
  useAssignableRoles,
  useDecision,
  useDescribe,
  useFilter,
  useGate,
  useMemberships,
  usePermission,
  usePermissions,
  useRefreshOn,
  useRoles,
  useSubject,
  useTenant,
} from "permdock/react";

import { permissions } from "../../../permissions.ts";

const authz = authzChangeRefresh();
const triggers = [authz.trigger];

export function AccessPanel(props: { readonly label: string }) {
  useRefreshOn(triggers);
  const permission = usePermission(permissions.quotes.list);
  const decision = useDecision(permissions.quotes.read);
  const set = usePermissions([permissions.quotes.list]);
  const filtered = useFilter(permissions.quotes.read, []);
  const tenant = useTenant();
  const memberships = useMemberships();
  const roles = useRoles();
  const assignable = useAssignableRoles();
  const subject = useSubject();
  const described = useDescribe()(decision.decision);
  const gate = useGate(permissions.billing.read);
  return (
    <li data-variant={props.label}>
      {props.label} {permission.outcome} {set.granted.length} {filtered.length}{" "}
      {tenant.tenant ?? "none"} {memberships.length} {roles.roles.length}{" "}
      {assignable.length} {subject.principal?.id ?? "anon"} {described.title}{" "}
      {gate.upgrade.length}
    </li>
  );
}
