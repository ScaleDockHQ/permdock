export type OperationRisk = "low" | "medium" | "high" | "critical";

/** Every `meta.risk` level, lowest first. */
export const OPERATION_RISKS: readonly OperationRisk[] = Object.freeze([
  "low",
  "medium",
  "high",
  "critical",
]);

export function isOperationRisk(value: unknown): value is OperationRisk {
  return OPERATION_RISKS.some((risk) => risk === value);
}
