import type { Decision } from './decision.ts';
import type { Permission, PermissionTree } from './permissions.ts';

import { compact } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import { findPermission } from './permissions.ts';

export type ArazzoSimulateInput = {
  readonly arazzo: unknown;
  readonly openapi: unknown;
  readonly workflowId?: string;
  readonly permissions?: PermissionTree;
  readonly inputs?: Readonly<Record<string, unknown>>;
};

export type ArazzoStepResult = {
  readonly stepId: string;
  readonly operationId?: string;
  readonly permissions: readonly Permission[];
  readonly decision: Decision;
  readonly provisional?: true;
};

export type ArazzoPlan = {
  readonly workflowId: string;
  readonly outcome: Decision['outcome'];
  readonly steps: readonly ArazzoStepResult[];
};

export type ArazzoFinding = {
  readonly stepId: string;
  readonly workflowId: string;
  readonly reason:
    | 'undocumented'
    | 'unsupported'
    | 'validation'
    | 'unknown-key';
  readonly detail: string;
};

type WorkflowStep = {
  readonly stepId: string;
  readonly operationId?: string;
  readonly operationPath?: string;
  readonly workflowId?: string;
  readonly parameters?: readonly {
    readonly name?: string;
    readonly value?: unknown;
  }[];
};

type Workflow = {
  readonly workflowId: string;
  readonly steps: readonly WorkflowStep[];
};

const denied = (
  reason: 'undocumented' | 'unsupported' | 'validation',
): Decision =>
  freezeDeep({
    outcome: 'denied',
    denials: [{ role: null, reason }],
    alternatives: [],
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseWorkflows(arazzo: unknown): Workflow[] | undefined {
  if (!isRecord(arazzo) || !Array.isArray(arazzo['workflows'])) {
    return undefined;
  }
  const version = asString(arazzo['arazzo']) ?? '1.1.0';
  if (!version.startsWith('1.0.') && version !== '1.1.0') {
    return undefined;
  }
  const out: Workflow[] = [];
  for (const item of arazzo['workflows']) {
    if (!isRecord(item)) {
      continue;
    }
    const workflowId = asString(item['workflowId']);
    if (workflowId === undefined) {
      continue;
    }
    const steps: WorkflowStep[] = [];
    if (Array.isArray(item['steps'])) {
      for (const step of item['steps']) {
        if (!isRecord(step)) {
          continue;
        }
        const stepId = asString(step['stepId']);
        if (stepId === undefined) {
          continue;
        }
        steps.push(
          compact<WorkflowStep>({
            stepId,
            operationId: asString(step['operationId']),
            operationPath: asString(step['operationPath']),
            workflowId: asString(step['workflowId']),
            parameters: Array.isArray(step['parameters'])
              ? (step['parameters'] as WorkflowStep['parameters'])
              : undefined,
          }),
        );
      }
    }
    out.push({ workflowId, steps });
  }
  return out;
}

function unescapePointer(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

function readPointer(doc: unknown, pointer: string): unknown {
  if (!pointer.startsWith('#/')) {
    return undefined;
  }
  let current: unknown = doc;
  for (const raw of pointer.slice(2).split('/')) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[unescapePointer(raw)];
  }
  return current;
}

function operationsById(
  openapi: unknown,
): Map<string, { readonly operationId: string; readonly node: unknown }> {
  const map = new Map<
    string,
    { readonly operationId: string; readonly node: unknown }
  >();
  if (!isRecord(openapi) || !isRecord(openapi['paths'])) {
    return map;
  }
  for (const pathItem of Object.values(openapi['paths'])) {
    if (!isRecord(pathItem)) {
      continue;
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      if (method.startsWith('x-') || !isRecord(operation)) {
        continue;
      }
      const operationId = asString(operation['operationId']);
      if (operationId !== undefined) {
        map.set(operationId, { operationId, node: operation });
      }
    }
  }
  return map;
}

function resolveOpenapi(
  openapi: unknown,
  sourceName: string | undefined,
): unknown {
  if (
    sourceName !== undefined &&
    isRecord(openapi) &&
    isRecord(openapi[sourceName])
  ) {
    return openapi[sourceName];
  }
  return openapi;
}

function sourceNameOf(operationPath: string): string | undefined {
  const match = /^\$sourceDescriptions\.([^#]+)/u.exec(operationPath);
  return match?.[1];
}

function pointerOf(operationPath: string): string | undefined {
  const hash = operationPath.indexOf('#');
  return hash === -1 ? undefined : operationPath.slice(hash);
}

function permissionKeysOf(node: unknown): readonly string[] {
  if (!isRecord(node)) {
    return [];
  }
  const raw = node['x-permdock-permissions'];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === 'string');
}

function isExpression(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('$');
}

function dataFrom(
  step: WorkflowStep,
  inputs: Readonly<Record<string, unknown>> | undefined,
): { readonly data: unknown; readonly provisional: boolean } {
  const record: Record<string, unknown> =
    inputs === undefined ? {} : { ...inputs };
  let provisional = false;
  for (const parameter of step.parameters ?? []) {
    const name = asString(parameter.name);
    if (name === undefined) {
      continue;
    }
    if (isExpression(parameter.value)) {
      provisional = true;
      continue;
    }
    record[name] = parameter.value;
  }
  if (Object.keys(record).length === 0) {
    return { data: undefined, provisional };
  }
  return { data: record, provisional };
}

function flattenSteps(
  workflows: readonly Workflow[],
  workflowId: string,
  seen: Set<string>,
): WorkflowStep[] | 'cycle' | 'missing' {
  if (seen.has(workflowId)) {
    return 'cycle';
  }
  const workflow = workflows.find((item) => item.workflowId === workflowId);
  if (workflow === undefined) {
    return 'missing';
  }
  seen.add(workflowId);
  const out: WorkflowStep[] = [];
  for (const step of workflow.steps) {
    if (step.workflowId !== undefined) {
      const nested = flattenSteps(workflows, step.workflowId, seen);
      if (nested === 'cycle' || nested === 'missing') {
        return nested;
      }
      out.push(...nested);
      continue;
    }
    out.push(step);
  }
  seen.delete(workflowId);
  return out;
}

function sourceType(
  arazzo: unknown,
  sourceName: string | undefined,
): string | undefined {
  if (!isRecord(arazzo) || !Array.isArray(arazzo['sourceDescriptions'])) {
    return undefined;
  }
  for (const source of arazzo['sourceDescriptions']) {
    if (!isRecord(source)) {
      continue;
    }
    if (sourceName === undefined || source['name'] === sourceName) {
      return asString(source['type']);
    }
  }
  return undefined;
}

export function arazzoFindings(
  input: ArazzoSimulateInput,
  tree: PermissionTree | undefined,
): readonly ArazzoFinding[] {
  const workflows = parseWorkflows(input.arazzo);
  if (workflows === undefined || workflows.length === 0) {
    return [
      {
        stepId: 'document',
        workflowId: input.workflowId ?? '',
        reason: 'validation',
        detail: 'Arazzo document is missing or not 1.0.x / 1.1.0',
      },
    ];
  }
  const workflowId = input.workflowId ?? workflows[0]?.workflowId ?? '';
  const flat = flattenSteps(workflows, workflowId, new Set());
  if (flat === 'cycle') {
    return [
      {
        stepId: 'document',
        workflowId,
        reason: 'validation',
        detail: 'workflowId cycle',
      },
    ];
  }
  if (flat === 'missing') {
    return [
      {
        stepId: 'document',
        workflowId,
        reason: 'validation',
        detail: `unknown workflowId ${workflowId}`,
      },
    ];
  }
  const findings: ArazzoFinding[] = [];
  for (const step of flat) {
    const sourceName =
      step.operationPath === undefined
        ? undefined
        : sourceNameOf(step.operationPath);
    if (sourceType(input.arazzo, sourceName) === 'asyncapi') {
      findings.push({
        stepId: step.stepId,
        workflowId,
        reason: 'unsupported',
        detail: 'AsyncAPI steps are not evaluated',
      });
      continue;
    }
    const doc = resolveOpenapi(input.openapi, sourceName);
    const byId = operationsById(doc);
    let node: unknown;
    let operationId = step.operationId;
    if (step.operationPath !== undefined) {
      node = readPointer(doc, pointerOf(step.operationPath) ?? '');
      if (isRecord(node)) {
        operationId = asString(node['operationId']) ?? operationId;
      }
    } else if (operationId !== undefined) {
      node = byId.get(operationId)?.node;
    }
    if (node === undefined) {
      findings.push({
        stepId: step.stepId,
        workflowId,
        reason: 'undocumented',
        detail: 'operation not found',
      });
      continue;
    }
    const keys = permissionKeysOf(node);
    if (keys.length === 0) {
      findings.push({
        stepId: step.stepId,
        workflowId,
        reason: 'undocumented',
        detail: 'operation has no x-permdock-permissions',
      });
      continue;
    }
    if (tree === undefined) {
      continue;
    }
    for (const key of keys) {
      if (findPermission(tree, key) === undefined) {
        findings.push({
          stepId: step.stepId,
          workflowId,
          reason: 'unknown-key',
          detail: key,
        });
      }
    }
  }
  return findings;
}

function worst(outcomes: readonly Decision['outcome'][]): Decision['outcome'] {
  if (outcomes.includes('denied')) {
    return 'denied';
  }
  if (outcomes.includes('approval-required')) {
    return 'approval-required';
  }
  return 'granted';
}

function combine(decisions: readonly Decision[]): Decision {
  const outcome = worst(decisions.map((item) => item.outcome));
  return (
    decisions.find((item) => item.outcome === outcome) ?? denied('undocumented')
  );
}

export function simulateArazzo(
  input: ArazzoSimulateInput,
  tree: PermissionTree | undefined,
  decide: (permission: Permission, data: unknown) => Decision,
): ArazzoPlan {
  const findings = arazzoFindings(input, tree);
  const workflows = parseWorkflows(input.arazzo);
  const workflowId =
    input.workflowId ?? workflows?.[0]?.workflowId ?? 'unknown';
  if (workflows === undefined) {
    return freezeDeep({
      workflowId,
      outcome: 'denied',
      steps: [
        {
          stepId: 'document',
          permissions: [],
          decision: denied('validation'),
        },
      ],
    });
  }
  const flat = flattenSteps(workflows, workflowId, new Set());
  if (flat === 'cycle' || flat === 'missing') {
    return freezeDeep({
      workflowId,
      outcome: 'denied',
      steps: [
        {
          stepId: 'document',
          permissions: [],
          decision: denied('validation'),
        },
      ],
    });
  }
  const findingByStep = new Map<string, ArazzoFinding>();
  for (const finding of findings) {
    if (!findingByStep.has(finding.stepId)) {
      findingByStep.set(finding.stepId, finding);
    }
  }
  const steps: ArazzoStepResult[] = [];
  for (const step of flat) {
    const finding = findingByStep.get(step.stepId);
    if (finding !== undefined) {
      const reason =
        finding.reason === 'unknown-key' ? 'undocumented' : finding.reason;
      steps.push(
        compact<ArazzoStepResult>({
          stepId: step.stepId,
          operationId: step.operationId,
          permissions: [],
          decision: denied(reason),
        }),
      );
      continue;
    }
    const sourceName =
      step.operationPath === undefined
        ? undefined
        : sourceNameOf(step.operationPath);
    const doc = resolveOpenapi(input.openapi, sourceName);
    const byId = operationsById(doc);
    let node: unknown;
    let operationId = step.operationId;
    if (step.operationPath !== undefined) {
      node = readPointer(doc, pointerOf(step.operationPath) ?? '');
      if (isRecord(node)) {
        operationId = asString(node['operationId']) ?? operationId;
      }
    } else if (operationId !== undefined) {
      node = byId.get(operationId)?.node;
    }
    const keys = permissionKeysOf(node);
    const permissions = keys.flatMap((key) => {
      const leaf = tree === undefined ? undefined : findPermission(tree, key);
      return leaf === undefined ? [] : [leaf];
    });
    const { data, provisional } = dataFrom(step, input.inputs);
    const decisions = permissions.map((permission) => decide(permission, data));
    steps.push(
      compact<ArazzoStepResult>({
        stepId: step.stepId,
        operationId,
        permissions,
        decision: combine(decisions),
        provisional: provisional ? true : undefined,
      }),
    );
  }
  return freezeDeep({
    workflowId,
    outcome: worst(steps.map((step) => step.decision.outcome)),
    steps,
  });
}

export function isArazzoSimulateInput(
  value: unknown,
): value is ArazzoSimulateInput {
  return isRecord(value) && 'arazzo' in value;
}
