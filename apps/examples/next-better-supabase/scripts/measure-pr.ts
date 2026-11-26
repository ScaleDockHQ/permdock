import { writeFileSync } from "node:fs";

import type { Json } from "./measure-report.ts";

import {
  COMPARED,
  FIVE,
  ORDER,
  cell,
  checkpointsOf,
  listMoves,
  loadBaseline,
  moves,
  objectAt,
  text,
} from "./measure-report.ts";
import { pageSection, proxySection, tokenSection } from "./measure-sections.ts";

function table(before: Json, after: Json, seed: string): string[] {
  const lines = [
    "| Route | Figure | Before | After | Difference |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const route of FIVE) {
    for (const column of COMPARED) {
      const [left, right, delta] = cell(
        before,
        after,
        seed,
        route,
        column.read,
        column.timing,
        column.key,
      ).split(" | ");
      lines.push(
        `| ${route} | ${column.label} | ${left} | ${right} | ${delta} |`,
      );
    }
  }
  return lines;
}

function missingList(after: Json): string[] {
  const items = after["notMeasured"];
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  return ["Not measured:", "", ...items.map((item) => `- ${String(item)}`), ""];
}

/** The section that goes under `What` in the pull request. */
export function renderPrBody(baseline: Json): string {
  const session = objectAt(baseline, "sessionBefore");
  const before = session ?? objectAt(checkpointsOf(baseline), "main");
  const after = objectAt(checkpointsOf(baseline), "after");
  if (before === null || after === null) {
    return "### Measurements\n\nThe before (`main`) and after checkpoints are not both recorded yet.\n";
  }
  const summary = moves(before, after, "1000");
  return [
    "### Measurements",
    "",
    `${summary.improved.length} figures improved, ${summary.worse.length} got worse, ${summary.within} stayed within spread, at 1,000 quotes.`,
    `Largest improvements: ${listMoves(summary.improved)}.`,
    `Largest regressions: ${listMoves(summary.worse)}.`,
    "",
    session === null
      ? "Before is the `main` checkpoint. After is the branch head. A lower number is the improvement."
      : "Before is a same-session rebuild of the tooling commit. After is the branch head. The earlier `main` checkpoint stays in the report as a drift check. A lower number is the improvement.",
    "",
    ...table(before, after, "1000"),
    "",
    "<details>",
    "<summary>100,000 quotes</summary>",
    "",
    ...table(before, after, "100000"),
    "",
    "</details>",
    "",
    `Before commit ${text(before["commit"], "unknown")}, after commit ${text(after["commit"], "unknown")}. Node ${text(after["node"], "unknown")} on ${text(after["platform"], "unknown")} ${text(after["arch"], "")}.`,
    "",
    ...pageSection(after),
    ...tokenSection(after),
    ...proxySection(after),
    ...missingList(after),
  ].join("\n");
}

export function renderReport(baseline: Json): string {
  const checkpoints = checkpointsOf(baseline);
  const lines = [
    "# next-better-supabase measurements",
    "",
    "Each checkpoint is one build of this sample. `main` is the before record. `after` is the branch head.",
    "",
  ];
  for (const name of ORDER) {
    const row = objectAt(checkpoints, name);
    const detail =
      row === null
        ? "Not recorded."
        : `Commit ${text(row["commit"], "unknown")}, ${text(row["measuredAt"], "unknown")}, Node ${text(row["node"], "unknown")}.`;
    lines.push(`## ${name}`, "", detail, "");
  }
  lines.push(renderPrBody(baseline));
  return lines.join("\n");
}

export function writeReport(baselineFile: string, reportFile: string): string {
  const baseline = loadBaseline(baselineFile);
  const body = renderPrBody(baseline);
  writeFileSync(reportFile, renderReport(baseline));
  return body;
}
