/** Sizes of the scale audit. Every seed is a pure function of these numbers. */
export const ROW_TIERS = {
  "1k": 1_000,
  "100k": 100_000,
  "1M": 1_000_000,
} as const;
export type RowTier = keyof typeof ROW_TIERS;

export const MEMBERSHIP_TIERS = [1, 12, 150, 500] as const;
export const ROLE_TIERS = [1, 5, 20] as const;
export const CUSTOM_ROLE_TIERS = [0, 50, 500] as const;
/** 500 custom roles in each of 1,000 tenants, 8 grants each. */
export const CUSTOM_PERMISSION_ROWS = 4_000_000;
export const TENANTS = 1_000;
export const TEAMS_PER_TENANT = 5;
export const OWNERS = 50;

/** A uuid literal: `kind` picks the table, `n` the row. */
export function uuidOf(kind: number, n: number): string {
  return `00000000-0000-4${kind.toString(16).padStart(3, "0")}-8000-${n
    .toString(16)
    .padStart(12, "0")}`;
}

/** The same uuid as a SQL expression over an integer expression `n`. */
export function uuidSql(kind: number, n: string): string {
  return `('00000000-0000-4${kind.toString(16).padStart(3, "0")}-8000-' || lpad(to_hex((${n})::bigint), 12, '0'))::uuid`;
}

export const KIND = {
  tenant: 1,
  user: 2,
  team: 3,
  job: 4,
  party: 5,
  attachment: 6,
  item: 7,
  folder: 8,
  doc: 9,
  thread: 10,
  message: 11,
  employee: 12,
  role: 13,
} as const;

export type Cell = {
  readonly memberships: number;
  readonly roles: number;
  readonly custom: number;
};

export const CELLS: readonly Cell[] = MEMBERSHIP_TIERS.flatMap((memberships) =>
  ROLE_TIERS.flatMap((roles) =>
    CUSTOM_ROLE_TIERS.map((custom) => ({ memberships, roles, custom })),
  ),
);

/** The caller of one matrix cell; no two cells share a user. */
export function callerOf(cell: Cell): string {
  return uuidOf(
    KIND.user,
    1_000_000 +
      MEMBERSHIP_TIERS.indexOf(cell.memberships as 1) * 1000 +
      ROLE_TIERS.indexOf(cell.roles as 1) * 10 +
      CUSTOM_ROLE_TIERS.indexOf(cell.custom as 0),
  );
}

export function cellKey(cell: Cell): string {
  return `m${String(cell.memberships)}-r${String(cell.roles)}-c${String(cell.custom)}`;
}
