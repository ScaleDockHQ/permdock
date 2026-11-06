import { catalogFingerprint } from "../../core/catalog-fingerprint.ts";
import { isRecord } from "../../core/compact.ts";

const LEGACY_MODE: ReadonlySet<string> = new Set(["any", "all", "sequential"]);
const V1_SCHEMA = "https://permdock.com/schemas/catalog-v1.json";
const V2_SCHEMA = "https://permdock.com/schemas/catalog-v2.json";

export type CatalogRewrite = {
  readonly text: string;
  readonly from: string;
  readonly to: string;
};

/**
 * A stored catalog-v1 document becomes catalog-v2: `version` 2, the schema URL,
 * and a pre-0.17 approval (`mode` of `any`, `all` or `sequential`, or a boolean
 * `distinct`) rewritten to `combine` and `mode`. The fingerprint is recomputed
 * when the document has one.
 */
export function rewriteStoredCatalog(text: string): CatalogRewrite | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isStoredCatalogV1(parsed)) {
    return undefined;
  }
  const next: unknown = structuredClone(parsed);
  if (!isRecord(next)) {
    return undefined;
  }
  rewriteTree(next);
  next["$schema"] = V2_SCHEMA;
  next["version"] = 2;
  if ("fingerprint" in parsed) {
    next["fingerprint"] = catalogFingerprint(next);
  }
  const body = `${JSON.stringify(next, null, 2)}\n`;
  return text.endsWith("\n")
    ? { text: body, from: "catalog-v1", to: "catalog-v2" }
    : { text: body.slice(0, -1), from: "catalog-v1", to: "catalog-v2" };
}

function isStoredCatalogV1(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value["resources"])) {
    return false;
  }
  if (!Array.isArray(value["permissions"])) {
    return false;
  }
  const schema = value["$schema"];
  return (
    value["version"] === 1 ||
    schema === V1_SCHEMA ||
    (typeof schema === "string" && schema.includes("catalog-v1"))
  );
}

function rewriteTree(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      rewriteTree(item);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const mode = value["mode"];
  const distinct = value["distinct"];
  if (typeof mode === "string" && LEGACY_MODE.has(mode)) {
    delete value["mode"];
    value["combine"] = mode;
  }
  if (typeof distinct === "boolean") {
    delete value["distinct"];
    if (distinct === false) {
      value["mode"] = "confirm";
    }
  }
  for (const item of Object.values(value)) {
    rewriteTree(item);
  }
}
