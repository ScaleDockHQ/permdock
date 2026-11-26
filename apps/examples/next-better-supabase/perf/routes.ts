/**
 * The routes `scripts/next-baseline.ts` and `scripts/measure.ts` load. Add a
 * route here when a page or action should be measured; both tools read this
 * file, so a route cannot be measured by one and skipped by the other.
 */
export type PerfUser = "Olivia" | "Mason" | "Carla";

/** Seeded users whose tokens are measured and never compared with `main`. */
export const personas = {
  orgs1: "00000000-0000-4000-8000-000000000101",
  orgs13: "00000000-0000-4000-8000-000000000113",
  orgs25: "00000000-0000-4000-8000-000000000125",
  orgs50: "00000000-0000-4000-8000-000000000150",
  roles1: "00000000-0000-4000-8000-000000000201",
  roles3: "00000000-0000-4000-8000-000000000203",
  roles10: "00000000-0000-4000-8000-000000000210",
  suspended: "00000000-0000-4000-8000-000000000301",
} as const;

export type MeasureUser = PerfUser | keyof typeof personas;

export type PerfRoute = {
  readonly name: string;
  readonly user: MeasureUser | null;
  readonly path: string;
};

/** Seeded auth user ids. The sign-in route takes the id, not the name. */
export const users = {
  Olivia: "00000000-0000-4000-8000-0000000000a1",
  Mason: "00000000-0000-4000-8000-0000000000a2",
  Carla: "00000000-0000-4000-8000-0000000000a3",
  ...personas,
} as const satisfies Record<PerfUser, string>;

/** The five routes that exist on `main`. New pages are appended later. */
export const routes = [
  { name: "quotes-list", user: "Olivia", path: "/en/acme/quotes" },
  { name: "members", user: "Olivia", path: "/en/acme/staff" },
  { name: "denied-staff", user: "Carla", path: "/en/acme/staff" },
  { name: "unauthorized", user: null, path: "/en/acme/quotes" },
  { name: "portal-quotes", user: "Carla", path: "/en/portal/acme/quotes" },
] as const satisfies readonly PerfRoute[];

/** Pages this branch adds. Measured on `after` only; the before column is `new`. */
export const extraRoutes = [
  {
    name: "quote-detail",
    user: "Olivia",
    path: "/en/acme/quotes/00000000-0000-4000-8000-0000000000f1",
  },
  { name: "approvals", user: "Olivia", path: "/en/acme/approvals" },
  { name: "member-admin", user: "Olivia", path: "/en/acme/members" },
  { name: "settings", user: "Olivia", path: "/en/acme/settings" },
  { name: "access", user: "Olivia", path: "/en/acme/access" },
  { name: "roles", user: "Olivia", path: "/en/acme/roles" },
  { name: "teams", user: "Olivia", path: "/en/acme/teams" },
  { name: "billing", user: "Olivia", path: "/en/acme/billing" },
  { name: "developers", user: "Olivia", path: "/en/acme/developers" },
  { name: "support", user: "Olivia", path: "/en/acme/support" },
  { name: "automations", user: "Olivia", path: "/en/acme/automations" },
  { name: "audit", user: "Olivia", path: "/en/acme/audit" },
  { name: "access-reviews", user: "Olivia", path: "/en/acme/access-reviews" },
] as const satisfies readonly PerfRoute[];

/**
 * One quotes page under a real membership shape. The hook stops claims at 1,024
 * bytes, so 13, 25 and 50 organizations show the budget, not a linear JWT.
 */
export const saasRoutes = [
  { name: "saas-orgs-1", user: "orgs1", path: "/en/persona-1/quotes" },
  { name: "saas-orgs-13", user: "orgs13", path: "/en/persona-1/quotes" },
  { name: "saas-orgs-25", user: "orgs25", path: "/en/persona-1/quotes" },
  { name: "saas-orgs-50", user: "orgs50", path: "/en/persona-1/quotes" },
  { name: "saas-roles-1", user: "roles1", path: "/en/persona-1/quotes" },
  { name: "saas-roles-3", user: "roles3", path: "/en/persona-1/quotes" },
  { name: "saas-roles-10", user: "roles10", path: "/en/persona-1/quotes" },
  { name: "saas-suspended", user: "suspended", path: "/en/persona-50/quotes" },
] as const satisfies readonly PerfRoute[];

/** Soft navigation measured with the network off. */
export const offline = { path: "/en/acme/staff", link: "Quotes" } as const;
