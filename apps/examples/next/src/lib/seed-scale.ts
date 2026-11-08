import type { Quote, RoleName } from "../permissions.ts";

const STATUSES = ["draft", "sent", "approved"] as const;
const CUSTOMERS = ["north", "south"] as const;

export type ScaleRows = {
  readonly quotes: Quote[];
  readonly staff: { user: string; organization: string; role: RoleName }[];
};

/**
 * Deterministic bulk rows for the `acme` tenant, added to the hand-written seed
 * when `DEMO_SEED_QUOTES` is a positive integer. The store is in memory, so
 * this is the whole seed script: the same count always yields the same ids,
 * titles and totals. `DEMO_SEED_STAFF` sets the extra staff (default one per 20
 * quotes).
 */
export function scaleRows(
  quotes: number,
  staff = Math.max(2, Math.ceil(quotes / 20)),
): ScaleRows {
  return {
    quotes: Array.from({ length: quotes }, (_, index): Quote => {
      const n = index + 1;
      return {
        id: `q-s${String(n).padStart(7, "0")}`,
        organization_id: "acme",
        customer_id: CUSTOMERS[n % 2] ?? "north",
        title: `Quote ${String(n).padStart(7, "0")}`,
        status: STATUSES[n % 3] ?? "draft",
        total: ((n * 7919) % 500_000) + 100,
      };
    }),
    staff: Array.from({ length: staff }, (_, index) => ({
      user: `scale-${index + 1}`,
      organization: "acme",
      role: "member" as const,
    })),
  };
}

export function scaleFromEnv(): ScaleRows | null {
  const quotes = Number(process.env["DEMO_SEED_QUOTES"] ?? "0");
  if (!Number.isInteger(quotes) || quotes <= 0) {
    return null;
  }
  const staff = Number(process.env["DEMO_SEED_STAFF"] ?? "");
  return Number.isInteger(staff) && staff > 0
    ? scaleRows(quotes, staff)
    : scaleRows(quotes);
}
