import { isRecord } from "../../../core/compact.ts";

export function mergeRecord(
  base: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    result[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    result[key] = value;
  }
  return result;
}

/**
 * Keeps what the document already says about a scheme (flow URLs, other flows,
 * description); PermDock owns the scopes.
 */
export function mergeSchemes(
  existing: Readonly<Record<string, unknown>>,
  emitted: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, scheme] of Object.entries(emitted)) {
    const before = existing[name];
    if (!isRecord(before) || !isRecord(scheme)) {
      result[name] = scheme;
      continue;
    }
    const beforeFlows = isRecord(before["flows"]) ? before["flows"] : {};
    const flows: Record<string, unknown> = { ...beforeFlows };
    for (const [kind, flow] of Object.entries(
      isRecord(scheme["flows"]) ? scheme["flows"] : {},
    )) {
      const previous = beforeFlows[kind];
      flows[kind] =
        isRecord(previous) && isRecord(flow) ? { ...previous, ...flow } : flow;
    }
    result[name] = {
      ...before,
      ...scheme,
      ...(isRecord(scheme["flows"]) ? { flows } : {}),
    };
  }
  return result;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
