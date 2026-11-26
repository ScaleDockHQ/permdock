/** Seeded people the home page and the sign-in route can start a session for. */
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
} as const;

export type DemoPerson = (typeof demoPeople)[keyof typeof demoPeople];

export function demoPerson(id: string): DemoPerson | null {
  switch (id) {
    case "00000000-0000-4000-8000-0000000000a1":
    case "00000000-0000-4000-8000-0000000000a2":
    case "00000000-0000-4000-8000-0000000000a3":
      return demoPeople[id];
    default:
      return null;
  }
}
