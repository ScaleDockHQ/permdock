export const HOOK_MARKER = "-- permdock:hook v1";

/** The first line of a `--grants-out` file. */
export const GRANTS_MARKER = "-- permdock:grants v1";

/** The first line of the `seeds` part: the `role_permissions` rows, a versioned migration. */
export const SEEDS_MARKER = "-- permdock:seeds v1";

/** The first line of the `indexes` part: the indexes the policies and helpers read through. */
export const INDEXES_MARKER = "-- permdock:indexes v1";

const HOOK_LINE = /^-- permdock:hook v(?<version>[1-9]\d*)(?: (?<rest>.*))?$/u;
const GRANTS_LINE =
  /^-- permdock:grants v(?<version>[1-9]\d*)(?: (?<rest>.*))?$/u;

/** The first line of a hook migration `permdock supabase hook generate` wrote. */
export type SupabaseHookMarker = {
  /** The marker's major: `1` for `-- permdock:hook v1`. */
  readonly version: number;
  readonly schema?: string;
  readonly tenantClaim?: string;
  readonly budget?: number;
  readonly claims: readonly string[];
};

/** The first line of a `--grants-out` migration. */
export type SupabaseGrantsMarker = {
  readonly version: number;
  readonly schema?: string;
};

function firstLine(sql: string): string {
  return (sql.split("\n", 1)[0] ?? "").replace(/\r$/u, "");
}

/** The `key=value` pairs after the marker, in a prototype-less object. */
function pairs(rest: string | undefined): Readonly<Record<string, string>> {
  // SAFETY: a fresh prototype-less object; only string values are assigned below.
  const fields = Object.create(null) as Record<string, string>;
  for (const pair of (rest ?? "").split(" ")) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      fields[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return fields;
}

/** The fields of a hook marker line, or undefined when `sql` does not start with one. */
export function hookMarkerFields(
  sql: string,
): Readonly<Record<string, string>> | undefined {
  const line = firstLine(sql);
  return line.startsWith(`${HOOK_MARKER} `)
    ? pairs(line.slice(HOOK_MARKER.length + 1))
    : undefined;
}

/**
 * Reads the `-- permdock:hook v<N>` line that starts a generated hook
 * migration. Undefined when the first line is not a hook marker.
 */
export function parseHookMarker(sql: string): SupabaseHookMarker | undefined {
  const match = HOOK_LINE.exec(firstLine(sql));
  if (match?.groups === undefined) {
    return undefined;
  }
  const fields = pairs(match.groups["rest"]);
  const budget = Number(fields["budget"]);
  const claims = fields["claims"];
  return Object.freeze({
    version: Number(match.groups["version"]),
    ...(fields["schema"] === undefined ? {} : { schema: fields["schema"] }),
    ...(fields["tenant"] === undefined
      ? {}
      : { tenantClaim: fields["tenant"] }),
    ...(Number.isSafeInteger(budget) && budget > 0 ? { budget } : {}),
    claims: Object.freeze(
      claims === undefined || claims === ""
        ? []
        : claims.split(",").filter((name) => name !== ""),
    ),
  });
}

/**
 * Reads the `-- permdock:grants v<N>` line that starts a `--grants-out`
 * migration. Undefined when the first line is not a grants marker.
 */
export function parseGrantsMarker(
  sql: string,
): SupabaseGrantsMarker | undefined {
  const match = GRANTS_LINE.exec(firstLine(sql));
  if (match?.groups === undefined) {
    return undefined;
  }
  const fields = pairs(match.groups["rest"]);
  return Object.freeze({
    version: Number(match.groups["version"]),
    ...(fields["schema"] === undefined ? {} : { schema: fields["schema"] }),
  });
}
