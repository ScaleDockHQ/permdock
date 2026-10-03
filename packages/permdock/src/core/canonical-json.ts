function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * JSON with sorted keys and `undefined` members dropped, so equal values hash
 * equally. Dates become ISO strings, bigints `"<n>n"`, and a repeated object
 * on the current path `"[Circular]"`, so any validated row serialises.
 */
export function canonicalJson(
  value: unknown,
  path: Set<object> = new Set(),
): string {
  if (typeof value === "bigint") {
    return JSON.stringify(`${value}n`);
  }
  if (value instanceof Date) {
    return JSON.stringify(
      Number.isNaN(value.getTime()) ? null : value.toISOString(),
    );
  }
  if (value !== null && typeof value === "object") {
    if (path.has(value)) {
      return '"[Circular]"';
    }
    path.add(value);
    try {
      if (Array.isArray(value)) {
        return `[${value
          .map((item) => canonicalJson(item === undefined ? null : item, path))
          .join(",")}]`;
      }
      if (isRecord(value)) {
        const entries = Object.keys(value)
          .toSorted()
          .filter((key) => value[key] !== undefined)
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalJson(value[key], path)}`,
          );
        return `{${entries.join(",")}}`;
      }
    } finally {
      path.delete(value);
    }
  }
  return JSON.stringify(value) ?? "null";
}
