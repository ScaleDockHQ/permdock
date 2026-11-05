import { isRecord } from "../core/compact.ts";

/** The names of the `oauth2` and `openIdConnect` security schemes of a document. */
export function oauthSchemes(document: unknown): ReadonlySet<string> {
  const components =
    isRecord(document) && isRecord(document["components"])
      ? document["components"]
      : {};
  const schemes = isRecord(components["securitySchemes"])
    ? components["securitySchemes"]
    : {};
  return new Set(
    Object.entries(schemes)
      .filter(
        ([, scheme]) =>
          isRecord(scheme) &&
          (scheme["type"] === "oauth2" || scheme["type"] === "openIdConnect"),
      )
      .map(([name]) => name),
  );
}

/**
 * The scope names of the requirements that name an OAuth scheme, in order and
 * without repeats.
 */
export function oauthScopesOf(
  requirements: unknown,
  schemes: ReadonlySet<string>,
): readonly string[] {
  if (!Array.isArray(requirements)) {
    return [];
  }
  const scopes = new Set<string>();
  for (const requirement of requirements) {
    if (!isRecord(requirement)) {
      continue;
    }
    for (const [name, values] of Object.entries(requirement)) {
      if (schemes.has(name) && Array.isArray(values)) {
        addScopes(scopes, values);
      }
    }
  }
  return [...scopes];
}

function addScopes(into: Set<string>, values: readonly unknown[]): void {
  for (const value of values) {
    if (typeof value === "string" && value !== "") {
      into.add(value);
    }
  }
}
