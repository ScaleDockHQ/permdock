/**
 * The routes `scripts/next-baseline.ts` and `scripts/measure.ts` load. Add a
 * route here when a page or action should be measured; both tools read this
 * file, so a route cannot be measured by one and skipped by the other.
 */
export type PerfUser = "Olivia" | "Mason" | "Carla";

export type PerfRoute = {
  readonly name: string;
  readonly user: PerfUser | null;
  readonly path: string;
};

/** Seeded auth user ids. The sign-in route takes the id, not the name. */
export const users = {
  Olivia: "00000000-0000-4000-8000-0000000000a1",
  Mason: "00000000-0000-4000-8000-0000000000a2",
  Carla: "00000000-0000-4000-8000-0000000000a3",
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
] as const satisfies readonly PerfRoute[];

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

/** Soft navigation measured with the network off. */
export const offline = { path: "/en/acme/staff", link: "Quotes" } as const;
