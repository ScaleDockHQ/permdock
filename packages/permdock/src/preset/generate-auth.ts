import type { Context, GeneratedFile } from "./generate-shared.ts";

import { env, ownedFile } from "./generate-shared.ts";

/** How the framework and agent files reach the signed-in caller through `session.ts`. */
export type SessionCall = {
  /** `currentUser` returns the policy's `User`; `currentSubject` a provider's verified `Subject`. */
  readonly name: "currentUser" | "currentSubject";
  /** Next.js reads the request through `next/headers`; every other framework passes the `Request`. */
  readonly takesRequest: boolean;
};

export function sessionCall(ctx: Context): SessionCall {
  return {
    name: ctx.preset.auth === "custom" ? "currentUser" : "currentSubject",
    takesRequest: ctx.preset.framework !== "next",
  };
}

function headersOf(ctx: Context): {
  readonly imports: readonly string[];
  readonly param: string;
  readonly read: string;
} {
  return sessionCall(ctx).takesRequest
    ? { imports: [], param: "request: Request", read: "request.headers" }
    : {
        imports: [`import { headers } from "next/headers";`],
        param: "",
        read: "(await headers())",
      };
}

const BEARER = `const authorization = requestHeaders.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;`;

function moduleText(imports: readonly string[], body: string): string {
  return `${imports.join("\n")}\n\n${body}`;
}

function customSession(ctx: Context): string {
  const param = sessionCall(ctx).takesRequest ? "_request: Request" : "";
  return `import type { User } from "./policy";

/**
 * The signed-in user, read from your session.
 * It returns null until you wire it, so every check fails closed.
 */
export async function currentUser(${param}): Promise<User | null> {
  return null;
}
`;
}

function supabaseSession(ctx: Context): string {
  const h = headersOf(ctx);
  const browser = sessionCall(ctx).takesRequest
    ? ""
    : "\n * A browser session keeps the token in cookies: read it there with\n * createServerClient from @supabase/ssr.";
  return moduleText(
    [
      `import { createClient } from "@supabase/supabase-js";`,
      ...h.imports,
      `import { subjectFromSupabase } from "permdock/supabase";`,
    ],
    `/**
 * The subject the Supabase access token in the Authorization header proves;
 * anonymous without a valid one.${browser}
 */
export async function currentSubject(${h.param}) {
  const requestHeaders = ${h.read};
  ${BEARER}
  if (token === undefined) {
    return subjectFromSupabase(null);
  }
  const supabase = createClient(
    ${env("SUPABASE_URL")} ?? "",
    ${env("SUPABASE_PUBLISHABLE_KEY")} ?? "",
  );
  const { data, error } = await supabase.auth.getClaims(token);
  return subjectFromSupabase(error ? null : (data?.claims ?? null));
}
`,
  );
}

function betterAuthSession(ctx: Context): string {
  const h = headersOf(ctx);
  return moduleText(
    [
      ...h.imports,
      `import { subjectFromBetterAuth } from "permdock/better-auth";`,
      "",
      `import { auth } from "./auth";`,
    ],
    `/** The subject of the Better Auth session on the request; anonymous without one. */
export async function currentSubject(${h.param}) {
  const session = await auth.api.getSession({ headers: ${h.read} });
  return subjectFromBetterAuth(session, { auth });
}
`,
  );
}

function betterAuthFile(): string {
  return `import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

/**
 * Your Better Auth instance: add the database adapter and sign-in methods here.
 * subjectFromBetterAuth reads roles through the organization plugin.
 */
export const auth = betterAuth({
  plugins: [organization()],
});
`;
}

function clerkSession(ctx: Context): string {
  if (!sessionCall(ctx).takesRequest) {
    return `import { auth } from "@clerk/nextjs/server";
import { subjectFromClerk } from "permdock/clerk";

/** The subject of the Clerk session; anonymous when signed out. */
export async function currentSubject() {
  return subjectFromClerk(await auth());
}
`;
  }
  return `import { createClerkClient } from "@clerk/backend";
import { subjectFromClerk } from "permdock/clerk";

const clerk = createClerkClient({
  secretKey: ${env("CLERK_SECRET_KEY")} ?? "",
  publishableKey: ${env("CLERK_PUBLISHABLE_KEY")} ?? "",
});

/** The subject of the Clerk session on the request; anonymous when signed out. */
export async function currentSubject(request: Request) {
  const state = await clerk.authenticateRequest(request);
  return subjectFromClerk(state.toAuth());
}
`;
}

function jwtSession(ctx: Context): string {
  const h = headersOf(ctx);
  const request = sessionCall(ctx).takesRequest ? ", request" : "";
  return moduleText(
    [...h.imports, `import { jwtSubjectResolver } from "permdock/jwt";`],
    `let resolve: ReturnType<typeof jwtSubjectResolver> | undefined;

/** One resolver for the process, so Discovery and the JWKS are fetched once. */
function resolver() {
  resolve ??= jwtSubjectResolver({
    discovery: ${env("OIDC_ISSUER")} ?? "",
    audience: ${env("OIDC_AUDIENCE")} ?? "",
  });
  return resolve;
}

/** The subject the bearer token proves; anonymous without a valid one. */
export async function currentSubject(${h.param}) {
  const requestHeaders = ${h.read};
  ${BEARER}
  return resolver()(token${request});
}
`,
  );
}

/** `session.ts`, plus `auth.ts` for Better Auth. */
export function sessionFiles(ctx: Context): GeneratedFile[] {
  const at = (name: string): string => `${ctx.src}/${name}`;
  switch (ctx.preset.auth) {
    case "custom":
      return [ownedFile(at("session.ts"), customSession(ctx))];
    case "supabase":
      return [ownedFile(at("session.ts"), supabaseSession(ctx))];
    case "better-auth":
      return [
        ownedFile(at("auth.ts"), betterAuthFile()),
        ownedFile(at("session.ts"), betterAuthSession(ctx)),
      ];
    case "clerk":
      return [ownedFile(at("session.ts"), clerkSession(ctx))];
    case "jwt":
      return [ownedFile(at("session.ts"), jwtSession(ctx))];
    default: {
      const exhaustive: never = ctx.preset.auth;
      return exhaustive;
    }
  }
}

export function authDependencies(ctx: Context): string[] {
  switch (ctx.preset.auth) {
    case "custom":
      return [];
    case "supabase":
      return ["@supabase/supabase-js"];
    case "better-auth":
      return ["better-auth"];
    case "clerk":
      return [
        sessionCall(ctx).takesRequest ? "@clerk/backend" : "@clerk/nextjs",
      ];
    case "jwt":
      return ["jose"];
    default: {
      const exhaustive: never = ctx.preset.auth;
      return exhaustive;
    }
  }
}

export function authDocs(ctx: Context): string[] {
  return ctx.preset.auth === "custom"
    ? ["/docs/concepts/authentication"]
    : [`/docs/adapters/${ctx.preset.auth}`];
}
