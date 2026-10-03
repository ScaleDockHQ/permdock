import type { ScimPage } from "./types.ts";

import { compact } from "../core/compact.ts";

const RESOURCES = new Set([
  "Users",
  "Groups",
  "ServiceProviderConfig",
  "ResourceTypes",
  "Schemas",
]);

export type ScimRoute =
  | { readonly kind: "Users"; readonly id?: string }
  | { readonly kind: "Groups"; readonly id?: string }
  | { readonly kind: "ServiceProviderConfig" }
  | { readonly kind: "ResourceTypes"; readonly id?: string }
  | { readonly kind: "Schemas"; readonly id?: string };

export function tenantFromPath(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const index = parts.findIndex((part) => RESOURCES.has(part));
  if (index <= 0) {
    return "";
  }
  const prev = parts[index - 1] ?? "";
  if (prev === "v2" || prev === "scim") {
    return "";
  }
  return prev;
}

function isKind(part: string): part is ScimRoute["kind"] {
  return RESOURCES.has(part);
}

export function parseRoute(url: URL): ScimRoute | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  const kind = parts.find(isKind);
  if (kind === undefined) {
    return undefined;
  }
  const id = parts[parts.indexOf(kind) + 1];
  switch (kind) {
    case "Users":
      return compact<ScimRoute>({ kind: "Users", id });
    case "Groups":
      return compact<ScimRoute>({ kind: "Groups", id });
    case "ServiceProviderConfig":
      return { kind: "ServiceProviderConfig" };
    case "ResourceTypes":
      return compact<ScimRoute>({ kind: "ResourceTypes", id });
    case "Schemas":
      return compact<ScimRoute>({ kind: "Schemas", id });
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function prefixOf(request: Request): {
  readonly origin: string;
  readonly prefix: readonly string[];
} {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.findIndex((part) => RESOURCES.has(part));
  return {
    origin: url.origin,
    prefix: index === -1 ? parts : parts.slice(0, index),
  };
}

export function locationOf(
  request: Request,
  kind: ScimRoute["kind"],
  id?: string,
): string {
  const { origin, prefix } = prefixOf(request);
  const path = id === undefined ? [...prefix, kind] : [...prefix, kind, id];
  return `${origin}/${path.join("/")}`;
}

export function pageFrom(url: URL): ScimPage {
  const startIndex = url.searchParams.get("startIndex");
  const count = url.searchParams.get("count");
  const cursor = url.searchParams.get("cursor");
  return compact<ScimPage>({
    startIndex:
      startIndex === null ? undefined : Math.trunc(Number(startIndex)),
    count: count === null ? undefined : Math.trunc(Number(count)),
    cursor: cursor ?? undefined,
  });
}
