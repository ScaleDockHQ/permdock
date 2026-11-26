"use client";

import type { Permission } from "permdock";

import Link from "next/link";
import { usePermission } from "permdock/react";
import { use } from "react";

import { permissions } from "../../../../permissions.ts";

type NavPath =
  | "/staff"
  | "/quotes"
  | "/approvals"
  | "/members"
  | "/roles"
  | "/teams"
  | "/developers"
  | "/support"
  | "/automations"
  | "/audit"
  | "/access-reviews"
  | "/access"
  | "/settings"
  | "/billing";
type NavBase = `/${string}/${string}`;
type NavHref = `${NavBase}${NavPath}`;

type Item = {
  readonly id: string;
  readonly label: string;
  readonly path: NavPath;
  readonly permission: Permission;
};

const items: readonly Item[] = [
  {
    id: "staff",
    label: "Staff",
    path: "/staff",
    permission: permissions.staff.list,
  },
  {
    id: "quotes",
    label: "Quotes",
    path: "/quotes",
    permission: permissions.quotes.list,
  },
  {
    id: "approvals",
    label: "Approvals",
    path: "/approvals",
    permission: permissions.approvals.read,
  },
  {
    id: "members",
    label: "Members",
    path: "/members",
    permission: permissions.members.read,
  },
  {
    id: "roles",
    label: "Roles",
    path: "/roles",
    permission: permissions.roles.manage,
  },
  {
    id: "teams",
    label: "Teams",
    path: "/teams",
    permission: permissions.teams.read,
  },
  {
    id: "developers",
    label: "Developers",
    path: "/developers",
    permission: permissions.api_keys.manage,
  },
  {
    id: "support",
    label: "Support",
    path: "/support",
    permission: permissions.impersonation.start,
  },
  {
    id: "automations",
    label: "Automations",
    path: "/automations",
    permission: permissions.automations.read,
  },
  {
    id: "audit",
    label: "Audit",
    path: "/audit",
    permission: permissions.audit.read,
  },
  {
    id: "access-reviews",
    label: "Access reviews",
    path: "/access-reviews",
    permission: permissions.members.read,
  },
  {
    id: "access",
    label: "Access",
    path: "/access",
    permission: permissions.organization.update,
  },
  {
    id: "settings",
    label: "Settings",
    path: "/settings",
    permission: permissions.settings.read,
  },
  {
    id: "billing",
    label: "Billing",
    path: "/billing",
    permission: permissions.billing.read,
  },
];

export function NavSkeleton() {
  return (
    <nav aria-label="Main" aria-busy="true" data-testid="nav-skeleton">
      <ul>
        {items.map((item) => (
          <li key={item.id}>&nbsp;</li>
        ))}
      </ul>
    </nav>
  );
}

// Pending keeps the row's height, so links do not shift in when the snapshot
// resolves.
function GatedLink(props: { readonly item: Item; readonly href: NavHref }) {
  const { allowed, status } = usePermission(props.item.permission);
  if (status === "pending") {
    return (
      <li aria-hidden="true" data-nav-pending={props.item.id}>
        &nbsp;
      </li>
    );
  }
  if (!allowed) {
    return null;
  }
  return (
    <li>
      <Link href={props.href} prefetch data-nav={props.item.id}>
        {props.item.label}
      </Link>
    </li>
  );
}

export function Nav(props: { readonly base: Promise<NavBase> }) {
  const base = use(props.base);
  return (
    <nav aria-label="Main" data-testid="nav">
      <ul>
        {items.map((item) => (
          <GatedLink key={item.id} item={item} href={`${base}${item.path}`} />
        ))}
      </ul>
    </nav>
  );
}
