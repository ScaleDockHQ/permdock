/** Seeded people the home page and the sign-in route can start a session for. */

type Person = {
  readonly email: string;
  readonly name: string;
  readonly next: string;
};

export const demoPeople = {
  "00000000-0000-4000-8000-0000000000a1": {
    email: "olivia@acme.test",
    name: "Olivia",
    next: "/en/acme/staff",
  },
  "00000000-0000-4000-8000-0000000000a2": {
    email: "mason@acme.test",
    name: "Mason",
    next: "/en/acme/staff",
  },
  "00000000-0000-4000-8000-0000000000a3": {
    email: "carla@initech.test",
    name: "Carla",
    next: "/en/portal/acme/quotes",
  },
} as const satisfies Record<string, Person>;

export type DemoPerson = (typeof demoPeople)[keyof typeof demoPeople];

/**
 * Same ids and emails as `supabase/seed.sql`. The home page does not list them.
 * The measurement sign-in uses them so the JWT carries 1 to 50 memberships,
 * custom roles, or a suspended organization.
 */
export const personaPeople = {
  "00000000-0000-4000-8000-000000000101": {
    email: "orgs-1@persona.test",
    name: "Orgs 1",
    next: "/en/persona-1/quotes",
  },
  "00000000-0000-4000-8000-000000000113": {
    email: "orgs-13@persona.test",
    name: "Orgs 13",
    next: "/en/persona-1/quotes",
  },
  "00000000-0000-4000-8000-000000000125": {
    email: "orgs-25@persona.test",
    name: "Orgs 25",
    next: "/en/persona-1/quotes",
  },
  "00000000-0000-4000-8000-000000000150": {
    email: "orgs-50@persona.test",
    name: "Orgs 50",
    next: "/en/persona-1/quotes",
  },
  "00000000-0000-4000-8000-000000000201": {
    email: "roles-1@persona.test",
    name: "Roles 1",
    next: "/en/persona-1/quotes",
  },
  "00000000-0000-4000-8000-000000000203": {
    email: "roles-3@persona.test",
    name: "Roles 3",
    next: "/en/persona-1/quotes",
  },
  "00000000-0000-4000-8000-000000000210": {
    email: "roles-10@persona.test",
    name: "Roles 10",
    next: "/en/persona-1/quotes",
  },
  "00000000-0000-4000-8000-000000000301": {
    email: "suspended@persona.test",
    name: "Suspended",
    next: "/en/persona-50/quotes",
  },
} as const satisfies Record<string, Person>;

function personFrom(
  table: Readonly<Record<string, Person>>,
  id: string,
): Person | null {
  if (!Object.hasOwn(table, id)) {
    return null;
  }
  return table[id];
}

export function demoPerson(id: string): Person | null {
  return personFrom(demoPeople, id) ?? personFrom(personaPeople, id);
}
