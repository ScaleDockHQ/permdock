import type {
  Decision,
  DeniedDecision,
  DenialReason,
  DescribeMessages,
} from "permdock";

import { describe } from "permdock";

export const table: DescribeMessages = {
  reasons: { "no-grant": "geen toegang" },
};

export const translate: DescribeMessages = {
  reasons: (reason, decision) => {
    const code: DenialReason = reason;
    const full: DeniedDecision = decision;
    return code === "no-grant"
      ? `geen toegang (${String(full.alternatives.length)})`
      : undefined;
  },
};

export const fromFunction = (
  reason: DenialReason,
  decision: DeniedDecision,
): string => `${reason}: ${String(decision.denials.length)}`;

export const named: DescribeMessages = { reasons: fromFunction };

export const wrong: DescribeMessages = {
  // @ts-expect-error a reasons function returns text or undefined
  reasons: () => 1,
};

export function detail(decision: Decision): string {
  return describe(decision, { messages: translate }).detail;
}
