import type { OpaqueCondition } from "./ast.ts";

import { freezeDeep } from "../core/freeze.ts";

export function opaque(input: {
  readonly sql: string;
  readonly fingerprint: string;
}): OpaqueCondition {
  return freezeDeep({
    op: "opaque",
    sql: input.sql,
    fingerprint: input.fingerprint,
  });
}
