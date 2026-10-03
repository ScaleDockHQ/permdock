import type { Decision } from "./decision.ts";
import type { Permission, PermissionTree } from "./permissions.ts";

import { compact } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";
import { findPermission } from "./permissions.ts";

export type ArazzoSimulateInput = {
  readonly arazzo: unknown;
  readonly openapi: unknown;
  readonly workflowId?: string;
  readonly permissions?: PermissionTree;
  readonly inputs?: Readonly<Record<string, unknown>>;
};

export type ArazzoStepResult = {
  readonly stepId: string;
  /** The nested workflow that owns the step, when it is not the plan's workflow. */
  readonly workflowId?: string;
  readonly operationId?: string;
  readonly permissions: readonly Permission[];
  readonly decision: Decision;
  readonly provisional?: true;
};

export type ArazzoPlan = {
  readonly workflowId: string;
  readonly outcome: Decision["outcome"];
  readonly steps: readonly ArazzoStepResult[];
};

export type ArazzoFinding = {
  readonly stepId: string;
  readonly workflowId: string;
  readonly reason:
    | "undocumented"
    | "unsupported"
    | "validation"
    | "unknown-key";
  readonly detail: string;
};

type Parameter = { readonly name: string; readonly value: unknown };

type WorkflowStep = {
  readonly stepId: string;
  readonly operationId?: string;
  readonly operationPath?: string;
  readonly workflowId?: string;
  readonly channelPath?: string;
  readonly parameters: readonly Parameter[];
};

type Workflow = {
  readonly workflowId: string;
  readonly parameters: readonly Parameter[];
  readonly steps: readonly WorkflowStep[];
};

type Source = { readonly name: string; readonly type: string };

type ArazzoDocument = {
  readonly sources: readonly Source[];
  readonly workflows: readonly Workflow[];
};

type FlatStep = {
  readonly step: WorkflowStep;
  readonly workflow: Workflow;
  readonly inputs: Readonly<Record<string, unknown>>;
};

type ResolvedStep = {
  readonly stepId: string;
  readonly workflowId: string;
  readonly operationId?: string;
  readonly keys: readonly string[];
  readonly finding?: Pick<ArazzoFinding, "reason" | "detail">;
  readonly data: unknown;
  readonly provisional: boolean;
};

const VERSION = /^1\.[01]\.\d+(?:-.+)?$/u;
const STEP_TARGETS = [
  "operationId",
  "operationPath",
  "workflowId",
  "channelPath",
] as const;

const denied = (
  reason: "undocumented" | "unsupported" | "validation",
): Decision =>
  freezeDeep({
    outcome: "denied",
    denials: [{ role: null, reason }],
    alternatives: [],
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseParameters(
  raw: unknown,
  components: Record<string, unknown>,
  where: string,
): readonly Parameter[] | string {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return `${where}: parameters must be an array`;
  }
  const out: Parameter[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      return `${where}: a parameter is not an object`;
    }
    const reference = asString(item["reference"]);
    if (reference !== undefined) {
      const match = /^\$components\.parameters\.(.+)$/u.exec(reference);
      const target =
        match?.[1] === undefined ? undefined : components[match[1]];
      const name = isRecord(target) ? asString(target["name"]) : undefined;
      if (!isRecord(target) || name === undefined || !("value" in target)) {
        return `${where}: unresolved parameter reference ${reference}`;
      }
      out.push({
        name,
        value: "value" in item ? item["value"] : target["value"],
      });
      continue;
    }
    const name = asString(item["name"]);
    if (name === undefined || !("value" in item)) {
      return `${where}: a parameter needs a name and a value`;
    }
    out.push({ name, value: item["value"] });
  }
  return out;
}

function parseDocument(arazzo: unknown): ArazzoDocument | string {
  if (!isRecord(arazzo)) {
    return "Arazzo document is not an object";
  }
  const version = arazzo["arazzo"];
  if (typeof version !== "string" || !VERSION.test(version)) {
    return "arazzo must be a 1.0.x or 1.1.x version";
  }
  if (!isRecord(arazzo["info"])) {
    return "info is required";
  }
  const rawSources = arazzo["sourceDescriptions"];
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    return "sourceDescriptions needs at least one entry";
  }
  const sources: Source[] = [];
  for (const source of rawSources) {
    const name = isRecord(source) ? asString(source["name"]) : undefined;
    if (
      !isRecord(source) ||
      name === undefined ||
      asString(source["url"]) === undefined
    ) {
      return "a sourceDescription needs a name and a url";
    }
    if (sources.some((item) => item.name === name)) {
      return `duplicate sourceDescription ${name}`;
    }
    sources.push({ name, type: asString(source["type"]) ?? "openapi" });
  }
  const components =
    isRecord(arazzo["components"]) &&
    isRecord(arazzo["components"]["parameters"])
      ? arazzo["components"]["parameters"]
      : {};
  const rawWorkflows = arazzo["workflows"];
  if (!Array.isArray(rawWorkflows) || rawWorkflows.length === 0) {
    return "workflows needs at least one entry";
  }
  const workflows: Workflow[] = [];
  for (const item of rawWorkflows) {
    const workflowId = isRecord(item)
      ? asString(item["workflowId"])
      : undefined;
    if (!isRecord(item) || workflowId === undefined) {
      return "a workflow needs a workflowId";
    }
    if (workflows.some((workflow) => workflow.workflowId === workflowId)) {
      return `duplicate workflowId ${workflowId}`;
    }
    const parameters = parseParameters(
      item["parameters"],
      components,
      workflowId,
    );
    if (typeof parameters === "string") {
      return parameters;
    }
    const rawSteps = item["steps"];
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      return `${workflowId}: steps needs at least one entry`;
    }
    const steps: WorkflowStep[] = [];
    for (const step of rawSteps) {
      const stepId = isRecord(step) ? asString(step["stepId"]) : undefined;
      if (!isRecord(step) || stepId === undefined) {
        return `${workflowId}: a step needs a stepId`;
      }
      if (steps.some((other) => other.stepId === stepId)) {
        return `${workflowId}: duplicate stepId ${stepId}`;
      }
      const targets = STEP_TARGETS.filter(
        (field) => asString(step[field]) !== undefined,
      );
      if (
        targets.length !== 1 &&
        !(
          targets.length === 2 &&
          targets.includes("operationId") &&
          targets.includes("channelPath")
        )
      ) {
        return `${workflowId}.${stepId}: a step needs exactly one of operationId, operationPath or workflowId`;
      }
      const stepParameters = parseParameters(
        step["parameters"],
        components,
        `${workflowId}.${stepId}`,
      );
      if (typeof stepParameters === "string") {
        return stepParameters;
      }
      steps.push(
        compact<WorkflowStep>({
          stepId,
          operationId: asString(step["operationId"]),
          operationPath: asString(step["operationPath"]),
          workflowId: asString(step["workflowId"]),
          channelPath: asString(step["channelPath"]),
          parameters: stepParameters,
        }),
      );
    }
    workflows.push({ workflowId, parameters, steps });
  }
  return { sources, workflows };
}

function unescapePointer(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function readPointer(doc: unknown, pointer: string): unknown {
  if (!pointer.startsWith("#/")) {
    return undefined;
  }
  let current: unknown = doc;
  for (const raw of pointer.slice(2).split("/")) {
    if (!isRecord(current)) {
      return undefined;
    }
    let token: string;
    try {
      token = unescapePointer(decodeURIComponent(raw));
    } catch {
      return undefined;
    }
    if (!Object.hasOwn(current, token)) {
      return undefined;
    }
    current = current[token];
  }
  return current;
}

function findOperation(openapi: unknown, operationId: string): unknown {
  if (!isRecord(openapi) || !isRecord(openapi["paths"])) {
    return undefined;
  }
  for (const pathItem of Object.values(openapi["paths"])) {
    if (!isRecord(pathItem)) {
      continue;
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      if (
        !method.startsWith("x-") &&
        isRecord(operation) &&
        operation["operationId"] === operationId
      ) {
        return operation;
      }
    }
  }
  return undefined;
}

/** One description, or a map of descriptions keyed by source `name`. */
function descriptionFor(openapi: unknown, name: string): unknown {
  if (
    isRecord(openapi) &&
    !("openapi" in openapi) &&
    !("paths" in openapi) &&
    isRecord(openapi[name])
  ) {
    return openapi[name];
  }
  return openapi;
}

function permissionKeysOf(node: unknown): readonly string[] {
  if (!isRecord(node)) {
    return [];
  }
  const raw = node["x-permdock-permissions"];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === "string");
}

/** `$inputs.a.b` against the frame's inputs; anything else that is a runtime expression is unknown. */
function valueOf(
  value: unknown,
  inputs: Readonly<Record<string, unknown>>,
): { readonly known: boolean; readonly value?: unknown } {
  if (typeof value !== "string" || !value.includes("$")) {
    return { known: true, value };
  }
  const match = /^\$inputs\.([^#{}]+)$/u.exec(value);
  if (match?.[1] === undefined) {
    return value.startsWith("$") || value.includes("{$")
      ? { known: false }
      : { known: true, value };
  }
  let current: unknown = inputs;
  for (const part of match[1].split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) {
      return { known: false };
    }
    current = current[part];
  }
  return { known: true, value: current };
}

function bind(
  parameters: readonly Parameter[],
  inputs: Readonly<Record<string, unknown>>,
): { readonly record: Record<string, unknown>; readonly provisional: boolean } {
  const record: Record<string, unknown> = {};
  let provisional = false;
  for (const parameter of parameters) {
    const bound = valueOf(parameter.value, inputs);
    if (!bound.known) {
      provisional = true;
      continue;
    }
    Object.defineProperty(record, parameter.name, {
      value: bound.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { record, provisional };
}

function flatten(
  doc: ArazzoDocument,
  workflowId: string,
  inputs: Readonly<Record<string, unknown>>,
  seen: Set<string>,
  out: FlatStep[],
): string | undefined {
  if (seen.has(workflowId)) {
    return "workflowId cycle";
  }
  const workflow = doc.workflows.find((item) => item.workflowId === workflowId);
  if (workflow === undefined) {
    return `unknown workflowId ${workflowId}`;
  }
  seen.add(workflowId);
  for (const step of workflow.steps) {
    if (
      step.workflowId === undefined ||
      step.workflowId.startsWith("$sourceDescriptions.")
    ) {
      out.push({ step, workflow, inputs });
      continue;
    }
    const nested = flatten(
      doc,
      step.workflowId,
      bind(step.parameters, inputs).record,
      seen,
      out,
    );
    if (nested !== undefined) {
      return nested;
    }
  }
  seen.delete(workflowId);
  return undefined;
}

type Located =
  | { readonly node: unknown; readonly operationId?: string }
  | Pick<ArazzoFinding, "reason" | "detail">;

function locate(
  doc: ArazzoDocument,
  openapi: unknown,
  step: WorkflowStep,
): Located {
  if (step.workflowId !== undefined) {
    return {
      reason: "unsupported",
      detail: "workflows in another Arazzo document are not resolved",
    };
  }
  let sourceName: string | undefined;
  let operationId = step.operationId;
  let pointer: string | undefined;
  if (step.operationPath !== undefined) {
    const match =
      /^\{?\$sourceDescriptions\.([^.}#]+)(?:\.url)?\}?(#.*)?$/u.exec(
        step.operationPath,
      );
    if (match?.[1] === undefined) {
      return {
        reason: "undocumented",
        detail: "operationPath is not a $sourceDescriptions reference",
      };
    }
    sourceName = match[1];
    pointer = match[2] ?? "";
  } else if (operationId !== undefined) {
    const match = /^\$sourceDescriptions\.([^.]+)\.(.+)$/u.exec(operationId);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      sourceName = match[1];
      operationId = match[2];
    }
  }
  const candidates =
    sourceName === undefined
      ? doc.sources.filter((source) => source.type !== "arazzo")
      : doc.sources.filter((source) => source.name === sourceName);
  if (candidates.length === 0) {
    return {
      reason: "undocumented",
      detail:
        sourceName === undefined
          ? "no API sourceDescription"
          : `unknown sourceDescription ${sourceName}`,
    };
  }
  if (step.channelPath !== undefined) {
    return {
      reason: "unsupported",
      detail: "AsyncAPI steps are not evaluated",
    };
  }
  const found: { readonly source: Source; readonly node: unknown }[] = [];
  for (const source of candidates) {
    const description = descriptionFor(openapi, source.name);
    const node =
      pointer === undefined
        ? operationId === undefined
          ? undefined
          : findOperation(description, operationId)
        : readPointer(description, pointer);
    if (node !== undefined || candidates.length === 1) {
      found.push({ source, node });
    }
  }
  if (found.length > 1) {
    return {
      reason: "undocumented",
      detail:
        "operationId matches several sources; qualify it with $sourceDescriptions",
    };
  }
  const [hit] = found;
  if (hit?.source.type === "asyncapi") {
    return {
      reason: "unsupported",
      detail: "AsyncAPI steps are not evaluated",
    };
  }
  if (
    hit === undefined ||
    hit.source.type === "arazzo" ||
    !isRecord(hit.node)
  ) {
    return { reason: "undocumented", detail: "operation not found" };
  }
  return compact<{ node: unknown; operationId?: string }>({
    node: hit.node,
    operationId: asString(hit.node["operationId"]) ?? operationId,
  });
}

function resolve(
  doc: ArazzoDocument,
  openapi: unknown,
  tree: PermissionTree | undefined,
  flat: FlatStep,
): ResolvedStep {
  const { step, workflow, inputs } = flat;
  const base = {
    stepId: step.stepId,
    workflowId: workflow.workflowId,
  };
  const located = locate(doc, openapi, step);
  const { record, provisional } = bind(
    [
      ...workflow.parameters.filter(
        (parameter) =>
          !step.parameters.some((own) => own.name === parameter.name),
      ),
      ...step.parameters,
    ],
    inputs,
  );
  const data =
    Object.keys(inputs).length + Object.keys(record).length === 0
      ? undefined
      : { ...inputs, ...record };
  if ("reason" in located) {
    return {
      ...base,
      ...compact({ operationId: step.operationId }),
      keys: [],
      finding: located,
      data,
      provisional,
    };
  }
  const keys = permissionKeysOf(located.node);
  const unknown =
    tree === undefined
      ? undefined
      : keys.find((key) => findPermission(tree, key) === undefined);
  return {
    ...base,
    ...compact({ operationId: located.operationId }),
    keys,
    ...(keys.length === 0
      ? {
          finding: {
            reason: "undocumented" as const,
            detail: "operation has no x-permdock-permissions",
          },
        }
      : unknown === undefined
        ? {}
        : { finding: { reason: "unknown-key" as const, detail: unknown } }),
    data,
    provisional,
  };
}

function resolveAll(
  input: ArazzoSimulateInput,
  tree: PermissionTree | undefined,
):
  | { readonly workflowId: string; readonly error: string }
  | { readonly workflowId: string; readonly steps: readonly ResolvedStep[] } {
  const doc = parseDocument(input.arazzo);
  if (typeof doc === "string") {
    return { workflowId: input.workflowId ?? "", error: doc };
  }
  const workflowId = input.workflowId ?? doc.workflows[0]?.workflowId ?? "";
  const flat: FlatStep[] = [];
  const error = flatten(doc, workflowId, input.inputs ?? {}, new Set(), flat);
  if (error !== undefined) {
    return { workflowId, error };
  }
  return {
    workflowId,
    steps: flat.map((item) => resolve(doc, input.openapi, tree, item)),
  };
}

export function arazzoFindings(
  input: ArazzoSimulateInput,
  tree: PermissionTree | undefined,
): readonly ArazzoFinding[] {
  const resolved = resolveAll(input, tree);
  if ("error" in resolved) {
    return [
      {
        stepId: "document",
        workflowId: resolved.workflowId,
        reason: "validation",
        detail: resolved.error,
      },
    ];
  }
  return resolved.steps.flatMap((step) =>
    step.finding === undefined
      ? []
      : [
          {
            stepId: step.stepId,
            workflowId: step.workflowId,
            reason: step.finding.reason,
            detail: step.finding.detail,
          },
        ],
  );
}

function worst(outcomes: readonly Decision["outcome"][]): Decision["outcome"] {
  if (outcomes.includes("denied")) {
    return "denied";
  }
  if (outcomes.includes("approval-required")) {
    return "approval-required";
  }
  return "granted";
}

function combine(decisions: readonly Decision[]): Decision {
  const outcome = worst(decisions.map((item) => item.outcome));
  return (
    decisions.find((item) => item.outcome === outcome) ?? denied("undocumented")
  );
}

export function simulateArazzo(
  input: ArazzoSimulateInput,
  tree: PermissionTree | undefined,
  decide: (permission: Permission, data: unknown) => Decision,
): ArazzoPlan {
  const resolved = resolveAll(input, tree);
  if ("error" in resolved) {
    return freezeDeep({
      workflowId: resolved.workflowId === "" ? "unknown" : resolved.workflowId,
      outcome: "denied",
      steps: [
        {
          stepId: "document",
          permissions: [],
          decision: denied("validation"),
        },
      ],
    });
  }
  const steps = resolved.steps.map((step): ArazzoStepResult => {
    const owner =
      step.workflowId === resolved.workflowId ? undefined : step.workflowId;
    if (step.finding !== undefined) {
      return compact<ArazzoStepResult>({
        stepId: step.stepId,
        workflowId: owner,
        operationId: step.operationId,
        permissions: [],
        decision: denied(
          step.finding.reason === "unsupported"
            ? "unsupported"
            : "undocumented",
        ),
      });
    }
    const permissions = step.keys.flatMap((key) => {
      const leaf = tree === undefined ? undefined : findPermission(tree, key);
      return leaf === undefined ? [] : [leaf];
    });
    return compact<ArazzoStepResult>({
      stepId: step.stepId,
      workflowId: owner,
      operationId: step.operationId,
      permissions,
      decision: combine(
        permissions.map((permission) => decide(permission, step.data)),
      ),
      provisional: step.provisional ? true : undefined,
    });
  });
  return freezeDeep({
    workflowId: resolved.workflowId,
    outcome: worst(steps.map((step) => step.decision.outcome)),
    steps,
  });
}

export function isArazzoSimulateInput(
  value: unknown,
): value is ArazzoSimulateInput {
  return isRecord(value) && "arazzo" in value;
}
