import type {
  ScopeChallenge,
  ScopeChallengeHandler,
} from "@modelcontextprotocol/server";

import type { McpAuthInfo, McpPermDockOptions } from "./types.ts";

import { isRecord } from "../core/compact.ts";
import { hasScope } from "../core/oauth-scopes.ts";
import { protectedResourceMetadataUrl } from "../server/problem.ts";

/**
 * `_meta` key on `tools/call`, `resources/read` and `prompts/get` carrying an
 * approval token.
 */
export const APPROVAL_META_KEY = "dev.permdock/approval";

export const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

const PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";

/**
 * The first protocol revision whose list results define `ttlMs` and
 * `cacheScope`.
 */
const CACHEABLE_LISTS_SINCE = "2026-07-28";

export type Context = {
  readonly sessionId?: string;
  readonly mcpReq?: {
    readonly _meta?: Readonly<Record<string, unknown>>;
    readonly envelope?: Readonly<Record<string, unknown>>;
    readonly requestState?: () => unknown;
    readonly notify?: (notification: {
      readonly method: string;
    }) => Promise<void>;
  };
  readonly http?: { readonly authInfo?: McpAuthInfo };
};

export function contextOf(value: unknown): Context {
  // SAFETY: a record from the SDK's handler context; every Context field is optional and type-checked on read.
  return isRecord(value) ? (value as Context) : {};
}

export function approvalTokenOf(context: Context): string | undefined {
  let fromState: unknown;
  try {
    fromState = context.mcpReq?.requestState?.();
  } catch {
    fromState = undefined;
  }
  if (typeof fromState === "string" && fromState !== "") {
    return fromState;
  }
  // oxlint-disable-next-line no-underscore-dangle -- the MCP protocol names it `_meta`
  const fromMeta = context.mcpReq?._meta?.[APPROVAL_META_KEY];
  if (typeof fromMeta === "string" && fromMeta !== "") {
    return fromMeta;
  }
  const fromAuth = context.http?.authInfo?.extra?.["approval"];
  return typeof fromAuth === "string" && fromAuth !== "" ? fromAuth : undefined;
}

export function resourceMetadataOf(authInfo: McpAuthInfo): string | undefined {
  if (authInfo.resourceMetadataUrl !== undefined) {
    return authInfo.resourceMetadataUrl;
  }
  const resource = authInfo.resource;
  return resource?.protocol === "https:" || resource?.protocol === "http:"
    ? protectedResourceMetadataUrl(resource)
    : undefined;
}

export function sameResource(
  expected: string | URL,
  actual: URL | undefined,
): boolean {
  if (actual === undefined) {
    return false;
  }
  try {
    return new URL(String(expected)).href === new URL(String(actual)).href;
  } catch {
    return false;
  }
}

/**
 * Whether the request was sent under a revision that defines `cacheScope` on
 * list results. Only those requests carry the per-request envelope; a 2025-era
 * request has none and gets no cache fields.
 */
export function definesCacheScope(context: Context): boolean {
  const version = context.mcpReq?.envelope?.[PROTOCOL_VERSION];
  return typeof version === "string" && version >= CACHEABLE_LISTS_SINCE;
}

export function tenantOf(
  tenant: McpPermDockOptions["tenant"],
):
  | string
  | ((call: McpCall) => ReturnType<Exclude<typeof tenant, string | undefined>>)
  | undefined {
  if (typeof tenant !== "function") {
    return tenant;
  }
  return (call) => tenant(call.authInfo ?? {});
}

/**
 * What the kernel sees of one MCP request; built per call so no two share an
 * instance.
 */
export type McpCall = { readonly authInfo?: McpAuthInfo };

export type Reach = {
  readonly scopes: readonly string[];
  readonly challenge: string;
};

export function sessionKey(context: Context): string {
  return context.sessionId ?? "";
}

export function declaredScopes(
  name: string,
  value: unknown,
): readonly [string, ...string[]] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const scopes: unknown[] = Array.isArray(value) ? value : [];
  const names = scopes.filter(
    (scope): scope is string => typeof scope === "string" && scope !== "",
  );
  const [first, ...rest] = names;
  if (first === undefined || names.length !== scopes.length) {
    throw new TypeError(
      `permdock/mcp: tool ${name} sets oauthScopes, which must be a non-empty list of scope names.`,
    );
  }
  return Object.freeze([first, ...rest]);
}

export function challengeFor(
  own: ScopeChallengeHandler | undefined,
  reaching: readonly string[],
  challenged: string,
): ScopeChallengeHandler {
  return async (context) => {
    const first = await own?.(context);
    if (first !== undefined) {
      return first;
    }
    const authInfo = context.authInfo;
    if (authInfo === undefined || hasScope(authInfo.scopes, reaching)) {
      return undefined;
    }
    return { scopes: [challenged] } satisfies ScopeChallenge;
  };
}
