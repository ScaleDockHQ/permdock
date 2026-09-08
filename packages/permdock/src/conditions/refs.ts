import type { ConditionRef } from './ast.ts';

import { freezeDeep } from '../core/freeze.ts';
import { assertSafeKey, splitPath } from '../core/paths.ts';

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

export const subject: SubjectRef = createRef('subject');

export function isSubjectRef(value: unknown): value is ConditionRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    'ref' in value &&
    typeof (value as ConditionRef).ref === 'string' &&
    (value as ConditionRef).ref.startsWith('subject')
  );
}
