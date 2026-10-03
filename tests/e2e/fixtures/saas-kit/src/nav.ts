import type { Permission } from "permdock";

import { saasPermissions as p } from "permdock/testing/saas/permissions";

export type NavItem = {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly permission: Permission;
  readonly pro?: true;
};

/** The DOM contract every UI fixture renders; see tests/e2e/src/saas-ui.ts. */
export const navItems: readonly NavItem[] = [
  { id: "overview", label: "Overview", path: "", permission: p.project.list },
  {
    id: "projects",
    label: "Projects",
    path: "/projects",
    permission: p.project.list,
  },
  {
    id: "members",
    label: "Members",
    path: "/members",
    permission: p.member.list,
  },
  {
    id: "settings",
    label: "Settings",
    path: "/settings",
    permission: p.settings.manage,
  },
  {
    id: "billing",
    label: "Billing",
    path: "/billing",
    permission: p.billing.read,
  },
  {
    id: "integrations",
    label: "Integrations",
    path: "/integrations",
    permission: p.integration.read,
  },
  {
    id: "analytics",
    label: "Analytics",
    path: "/analytics",
    permission: p.analytics.read,
    pro: true,
  },
  {
    id: "audit",
    label: "Audit log",
    path: "/audit",
    permission: p.audit.read,
    pro: true,
  },
];

export function navItemFor(section: string | undefined): NavItem | undefined {
  const path = section === undefined || section === "" ? "" : `/${section}`;
  return navItems.find((item) => item.path === path);
}

export const orgs = [
  { id: "acme", name: "Acme" },
  { id: "globex", name: "Globex" },
] as const;

export const loginUsers = [
  "alice",
  "bob",
  "carol",
  "dave",
  "erin",
  "frank",
  "mallory",
] as const;

export { saasPermissions as permissions } from "permdock/testing/saas/permissions";
