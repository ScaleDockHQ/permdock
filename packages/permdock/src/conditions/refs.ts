import type { Subject } from '../core/subject.ts';
import type { ConditionRef } from './ast.ts';

import { freezeDeep } from '../core/freeze.ts';
import { assertSafeKey, readPath, splitPath } from '../core/paths.ts';

const REF_BRAND: unique symbol = Symbol.for('permdock.ref');

export type SubjectRef = ConditionRef & {
  readonly [key: string]: SubjectRef;
};

function createRef(path: string): SubjectRef {
  const segments = splitPath(path);
  for (const segment of segments) {
    assertSafeKey(segment, 'subject path');
  }
  const target: ConditionRef = freezeDeep({ ref: path });
  const proxy: SubjectRef = new Proxy(target as SubjectRef, {
    get(object, property, receiver): unknown {
      if (property === 'ref' || property === REF_BRAND) {
        return Reflect.get(
          object,
          property === REF_BRAND ? 'ref' : property,
          receiver,
        );
      }
      if (
        property === 'toJSON' ||
        property === 'valueOf' ||
        property === Symbol.toStringTag
      ) {
        return undefined;
      }
      if (typeof property !== 'string') {
        return undefined;
      }
      assertSafeKey(property, 'subject path');
      return createRef(`${path}.${property}`);
    },
    getOwnPropertyDescriptor(object, property) {
      if (property === 'ref') {
        return Reflect.getOwnPropertyDescriptor(object, property);
      }
      return undefined;
    },
    ownKeys(): (string | symbol)[] {
      return ['ref'];
    },
  });
  return proxy;
}

export const principal: SubjectRef = createRef('principal');
export const context: SubjectRef = createRef('context');

export function isSubjectRef(value: unknown): value is ConditionRef {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('ref' in value) ||
    typeof (value as ConditionRef).ref !== 'string'
  ) {
    return false;
  }
  const ref = (value as ConditionRef).ref;
  return (
    ref === 'principal' ||
    ref.startsWith('principal.') ||
    ref === 'context' ||
    ref.startsWith('context.')
  );
}

export function resolveConditionRef(
  ref: string,
  resolved: Subject | undefined,
): unknown {
  if (resolved === undefined) {
    return undefined;
  }
  if (ref === 'principal' || ref.startsWith('principal.')) {
    const path = ref === 'principal' ? '' : ref.slice('principal.'.length);
    if (path === '') {
      return resolved.principal;
    }
    if (resolved.principal === null) {
      return undefined;
    }
    return readPath(resolved.principal, path);
  }
  if (ref === 'context' || ref.startsWith('context.')) {
    const path = ref === 'context' ? '' : ref.slice('context.'.length);
    if (path === '') {
      return resolved.context;
    }
    return readPath(resolved.context, path);
  }
  return undefined;
}
