import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";

import type { User } from "../policy.ts";

import { membershipsOf, people } from "./store.ts";

export const SESSION_COOKIE = "example_session";

// A demo secret so the example runs without configuration; set
// SESSION_SECRET in any deployment.
const SECRET = process.env["SESSION_SECRET"] ?? "permdock-example-next-secret";

function sign(user: string): string {
  return createHmac("sha256", SECRET).update(user).digest("base64url");
}

export function sessionValue(user: string): string {
  return `${user}.${sign(user)}`;
}

/** The signed cookie's user id, or null; never throws. */
export function verifySession(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const dot = value.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const user = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(user));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  return people.some((person) => person.id === user) ? user : null;
}

export async function sessionUserId(): Promise<string | null> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value ?? null);
}

/** Memberships come from the store on every call, so a role change applies on the next render. */
export async function currentUser(): Promise<User | null> {
  const id = await sessionUserId();
  const person = people.find((item) => item.id === id) ?? null;
  return person === null
    ? null
    : {
        id: person.id,
        name: person.name,
        memberships: await membershipsOf(person.id),
      };
}
