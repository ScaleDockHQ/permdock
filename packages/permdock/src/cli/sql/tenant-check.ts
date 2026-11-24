import { isRecord } from "../../core/compact.ts";

/** The `sval` of each `String` node in a parse-tree list. */
export function svals(list: unknown): readonly string[] {
  return Array.isArray(list)
    ? list.flatMap((item: unknown) =>
        isRecord(item) &&
        isRecord(item["String"]) &&
        typeof item["String"]["sval"] === "string"
          ? [item["String"]["sval"]]
          : [],
      )
    : [];
}

/**
 * `<column> in (select <schema>.permitted_<scope>_ids('<key>'))`, read from the
 * node.
 */
export function tenantCheck(
  expr: unknown,
  helper: string,
): { readonly column: string; readonly key: string } | undefined {
  const link: unknown = isRecord(expr) ? expr["SubLink"] : undefined;
  if (!isRecord(link) || link["subLinkType"] !== "ANY_SUBLINK") {
    return undefined;
  }
  const test: unknown = link["testexpr"];
  const ref: unknown = isRecord(test) ? test["ColumnRef"] : undefined;
  const column = isRecord(ref) ? svals(ref["fields"]) : [];
  const select: unknown = isRecord(link["subselect"])
    ? link["subselect"]["SelectStmt"]
    : undefined;
  if (
    column.length !== 1 ||
    !isRecord(select) ||
    select["fromClause"] !== undefined
  ) {
    return undefined;
  }
  const targets = Array.isArray(select["targetList"])
    ? select["targetList"]
    : [];
  const target: unknown =
    targets.length === 1 && isRecord(targets[0])
      ? targets[0]["ResTarget"]
      : undefined;
  const call: unknown =
    isRecord(target) && isRecord(target["val"])
      ? target["val"]["FuncCall"]
      : undefined;
  if (!isRecord(call) || svals(call["funcname"]).join(".") !== helper) {
    return undefined;
  }
  const args = Array.isArray(call["args"]) ? call["args"] : [];
  const constant: unknown =
    args.length === 1 && isRecord(args[0]) ? args[0]["A_Const"] : undefined;
  const value: unknown =
    isRecord(constant) && isRecord(constant["sval"])
      ? constant["sval"]["sval"]
      : undefined;
  return typeof value === "string" && column[0] !== undefined
    ? { column: column[0], key: value }
    : undefined;
}
