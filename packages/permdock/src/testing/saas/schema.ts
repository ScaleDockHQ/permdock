import type { StandardSchemaV1 } from '@standard-schema/spec';

type FieldKind = 'string' | 'boolean' | 'nullable-string';

type FieldValue<K extends FieldKind> = K extends 'string'
  ? string
  : K extends 'boolean'
    ? boolean
    : string | null;

type Shape = { readonly [field: string]: FieldKind };

type Infer<S extends Shape> = { [K in keyof S]: FieldValue<S[K]> };

function accepts(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'nullable-string':
      return value === null || typeof value === 'string';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** A dependency-free Standard Schema for flat fixture rows. */
export function rowSchema<const S extends Shape>(
  shape: S,
): StandardSchemaV1<Infer<S>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'permdock-testing',
      validate(value) {
        if (typeof value !== 'object' || value === null) {
          return { issues: [{ message: 'expected an object' }] };
        }
        // SAFETY: value was checked to be a non-null object above; fields stay unknown.
        const record = value as Readonly<Record<string, unknown>>;
        const issues: StandardSchemaV1.Issue[] = [];
        for (const [field, kind] of Object.entries(shape)) {
          if (!accepts(kind, record[field])) {
            issues.push({ message: `expected ${kind}`, path: [field] });
          }
        }
        // SAFETY: with no issues, every field of the shape was accepted by its declared kind.
        return issues.length > 0 ? { issues } : { value: record as Infer<S> };
      },
    },
  };
}
