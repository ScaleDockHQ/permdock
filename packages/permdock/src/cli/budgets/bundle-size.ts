import type { Policy } from "../../index.ts";
import type { CommandResult } from "../core/result.ts";
import type { SnapshotPart } from "../snapshot-size.ts";

import { clientBundle } from "../../core/client-bundle.ts";
import { measurePart } from "../snapshot-size.ts";

type BundleSizeReport = {
  /** One entry per role in the bundle, its `roles[name]` value. */
  readonly roles: readonly SnapshotPart[];
  /**
   * The other top-level keys: `conditions` holds the grant terms every role
   * shares.
   */
  readonly parts: readonly SnapshotPart[];
  readonly total: SnapshotPart;
  readonly largest: string;
};

/**
 * The size of `clientBundle(policy)` as JSON, per role and per shared part. The
 * total is `JSON.stringify(bundle)`, what a `"use client"` module ships.
 */
export function bundleSize(policy: Policy): BundleSizeReport {
  const bundle = clientBundle(policy);
  const roles = Object.entries(bundle.roles)
    .map(([name, value]) => measurePart(name, value))
    .toSorted((a, b) => b.bytes - a.bytes);
  const parts = Object.entries(bundle)
    .filter(
      ([name, value]) =>
        name !== "v" && name !== "roles" && value !== undefined,
    )
    .map(([name, value]) => measurePart(name, value));
  let largest: { readonly label: string; readonly bytes: number } = {
    label: "none",
    bytes: -1,
  };
  for (const item of parts) {
    if (item.bytes > largest.bytes) {
      largest = { label: item.part, bytes: item.bytes };
    }
  }
  for (const item of roles) {
    if (item.bytes > largest.bytes) {
      largest = { label: `role ${item.part}`, bytes: item.bytes };
    }
  }
  return {
    roles,
    parts,
    total: measurePart("total", bundle),
    largest: largest.label,
  };
}

function row(label: string, part: SnapshotPart): string {
  return `${label.padEnd(20)} ${String(part.bytes).padStart(9)} bytes ${String(part.gzip).padStart(9)} gzip`;
}

export function runBundleSize(input: {
  readonly policy: Policy;
  readonly budget: number | undefined;
  readonly json: boolean;
}): CommandResult {
  const report = bundleSize(input.policy);
  const over = input.budget !== undefined && report.total.bytes > input.budget;
  const lines = [
    `client bundle: ${String(report.roles.length)} roles`,
    ...report.parts.map((part) =>
      row(part.part === "conditions" ? "conditions (shared)" : part.part, part),
    ),
    ...report.roles.map((part) => row(`role ${part.part}`, part)),
    row("total", report.total),
    ...(input.budget === undefined
      ? []
      : [
          over
            ? `over the ${String(input.budget)} byte budget; the largest part is ${report.largest}`
            : `within the ${String(input.budget)} byte budget`,
        ]),
  ];
  return {
    code: 0,
    output: input.json ? JSON.stringify(report) : lines.join("\n"),
    data: {
      ...report,
      ...(input.budget === undefined
        ? {}
        : { budget: input.budget, overBudget: over }),
    },
  };
}
