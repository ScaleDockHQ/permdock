import type { Policy } from "../../index.ts";
import type { RlsSqlContext } from "../sql/context.ts";

import { graphIdsSql, graphPlan } from "./graph.ts";
import { memoizes } from "./helper-bodies.ts";
import { memoReadsSql } from "./helpers.ts";
import { memoReadTriggersSql } from "./memo-generation.ts";

export function memoRowTriggersSql(
  ctx: RlsSqlContext,
  policy: Policy,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  const plan = graphPlan(policy);
  if (!memoizes(ctx) || plan.size === 0) {
    return "";
  }
  return memoReadTriggersSql(
    ctx,
    graphIdsSql(ctx, plan, tables),
    memoReadsSql(ctx),
  );
}
