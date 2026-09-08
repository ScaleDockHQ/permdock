import type { Policy } from '../core/policy.ts';
import type { OpenApiOverlayOptions, OpenApiPermDockOptions } from './types.ts';

import { compact } from '../core/compact.ts';
import { listPermissions } from '../core/permissions.ts';
import {
  catalogOf,
  describeOf,
  securityProfileRequirementsOf,
  securitySchemesOf,
} from './emit.ts';
import { DRAFT_PINS } from './pins.ts';

function pointerEscape(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function actionKey(keys: readonly string[]): string {
  return keys.toSorted().join(',');
}

export function overlayOf(
  policy: Policy,
  options: OpenApiPermDockOptions,
  overlayOptions: OpenApiOverlayOptions = {},
): Record<string, unknown> {
  const version = overlayOptions.version ?? '1.1';
  const leaves = listPermissions(policy.permissions);
  const schemes = securitySchemesOf(policy, options);
  const requirements = securityProfileRequirementsOf(policy, options);
  const drafts =
    version === '1.2' ? { overlay: DRAFT_PINS.overlay } : undefined;
  const catalog = catalogOf(options, drafts);
  const schemeAction = {
    target: '$.components.securitySchemes',
    description: 'PermDock security schemes',
    update: schemes,
  };
  const catalogAction = {
    target: '$',
    description: 'PermDock catalog pin',
    update: { 'x-permdock-catalog': catalog },
  };
  const requirementAction =
    requirements === undefined
      ? undefined
      : {
          target: '$.components.securityProfileRequirements',
          description: 'PermDock security profile requirements',
          update: requirements,
        };
  const operationBodies = leaves.map((leaf) => ({
    keys: [leaf.key],
    fields: describeOf(policy, options, [leaf]),
    target: `$.paths.*.*[?(@.operationId=='${leaf.key}')]`,
  }));
  if (version === '1.1') {
    const actions: Record<string, unknown>[] = [schemeAction, catalogAction];
    if (requirementAction !== undefined) {
      actions.push(requirementAction);
    }
    for (const body of operationBodies) {
      actions.push({
        target: body.target,
        description: `security for ${body.keys.join(',')}`,
        update: body.fields,
      });
    }
    return compact({
      overlay: '1.1.0',
      info: { title: 'PermDock authorization overlay', version: '1' },
      extends: overlayOptions.extends,
      actions,
    });
  }
  const reusable: Record<string, unknown> = {};
  const refs: Record<string, unknown>[] = [];
  for (const body of operationBodies) {
    const key = actionKey(body.keys);
    if (reusable[key] === undefined) {
      reusable[key] = {
        description: `security for ${key}`,
        fields: { update: body.fields },
      };
    }
    refs.push({
      $ref: `#/components/actions/${pointerEscape(key)}`,
      target: body.target,
      description: `security for ${key}`,
    });
  }
  const actions: Record<string, unknown>[] = [schemeAction, catalogAction];
  if (requirementAction !== undefined) {
    actions.push(requirementAction);
  }
  return compact({
    overlay: '1.2.0',
    info: { title: 'PermDock authorization overlay', version: '1' },
    extends: overlayOptions.extends,
    components: { actions: reusable },
    actions: [...actions, ...refs],
  });
}
