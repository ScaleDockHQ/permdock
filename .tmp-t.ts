import { compileConditionSql } from "./packages/permdock/src/cli/sql/conditions.ts";
console.log(
  compileConditionSql(
    { op: "in", field: "x", value: [] } as never,
    {} as never,
  ),
);
