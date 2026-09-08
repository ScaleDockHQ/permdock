import type { OpenApiFactory } from './types.ts';

import {
  asList,
  catalogOf,
  describeOf,
  securityOf,
  securityProfileRequirementsOf,
  securitySchemesOf,
} from './emit.ts';
import { overlayOf } from './overlay.ts';

function extendOperation(
  operation: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(operation)) {
    result[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    result[key] = value;
  }
  return result;
}

export const createPermDock: OpenApiFactory = (policy, options) => {
  return {
    securitySchemes() {
      return securitySchemesOf(policy, options);
    },
    security(permission, extra) {
      return securityOf(options, asList(permission), extra?.anyOf);
    },
    describe(permission, extra) {
      return describeOf(policy, options, asList(permission), extra?.anyOf);
    },
    spec(permission) {
      return (operation) =>
        extendOperation(
          operation,
          describeOf(policy, options, asList(permission)),
        );
    },
    overlay(overlayOptions) {
      return overlayOf(policy, options, overlayOptions ?? {});
    },
    securityProfileRequirements() {
      return securityProfileRequirementsOf(policy, options);
    },
    catalog() {
      return catalogOf(options);
    },
  };
};
