import { createContext, use } from "react";

export type Session = {
  readonly user: string | null;
  readonly plan: string | null;
};

export const SessionContext = createContext<Session>({
  user: null,
  plan: null,
});

export function useSession(): Session {
  return use(SessionContext);
}

export const ORG = "acme";

export function post(
  path: string,
  body?: Record<string, string>,
): Promise<Response> {
  return fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body ?? {}).toString(),
    redirect: "manual",
  });
}
