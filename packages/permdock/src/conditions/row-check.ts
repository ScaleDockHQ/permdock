/** Whether the row a unique key names exists, and if so whether the filter keeps it. */
export type RowCheck =
  | { readonly found: false }
  | { readonly found: true; readonly granted: boolean };

const MISSING: RowCheck = Object.freeze({ found: false });
const GRANTED: RowCheck = Object.freeze({ found: true, granted: true });
const DENIED: RowCheck = Object.freeze({ found: true, granted: false });

export function rowCheckOf(found: boolean, granted: boolean): RowCheck {
  return found ? (granted ? GRANTED : DENIED) : MISSING;
}

/** Reads `select <filter> as granted ... where <key> limit 2`; only a boolean `true` or `1` grants. */
export function rowCheckFrom(
  rows: readonly { readonly granted?: unknown }[],
): RowCheck {
  if (rows.length > 1) {
    throw new Error('PermDock: checkRow key matches more than one row');
  }
  const [row] = rows;
  return rowCheckOf(
    row !== undefined,
    row?.granted === true || row?.granted === 1,
  );
}
