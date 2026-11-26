"use server";

import type { Route } from "next";

import { redirect } from "next/navigation";

import { signInAs } from "./sign-in.ts";

/** The home page form. The session cookie is set before the redirect. */
export async function signInAction(formData: FormData): Promise<void> {
  const user = formData.get("user");
  const next = formData.get("next");
  if (typeof user !== "string") {
    return;
  }
  const target = await signInAs(user, typeof next === "string" ? next : "/en");
  if (target !== null) {
    // SAFETY: signInWithPassword returns a same-origin path.
    redirect(target as Route);
  }
}
