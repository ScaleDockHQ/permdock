import type { DecisionEvent } from "./interfaces.ts";

/** The CSV export columns, in order; the header row of every CSV file. */
export const CSV_COLUMNS: readonly [
  "time",
  "principal",
  "actor",
  "tenant",
  "permission",
  "outcome",
  "matched.role",
  "via",
  "denials.reason",
  "token",
] = Object.freeze([
  "time",
  "principal",
  "actor",
  "tenant",
  "permission",
  "outcome",
  "matched.role",
  "via",
  "denials.reason",
  "token",
] as const);

function field(value: string | null | undefined): string {
  const text = value ?? "";
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * One RFC 4180 row for a decision or approval event, without a line
 * terminator; join rows with CRLF under a `CSV_COLUMNS` header.
 */
export function toCsvRow(event: DecisionEvent): string {
  return [
    event.at,
    event.subject.principal?.id,
    event.subject.actor?.id,
    event.tenant,
    event.permission,
    event.outcome,
    event.matched?.role,
    event.via,
    event.denials?.map((denial) => denial.reason).join(";"),
    event.token,
  ]
    .map(field)
    .join(",");
}
