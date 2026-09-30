import { assertSafeKey } from '../core/paths.ts';

/** A model's non-nullable scalar fields and its scalar list fields, by Prisma field name. */
export type PrismaModelFields = {
  readonly required: readonly string[];
  readonly lists: readonly string[];
};

/** The `datamodel` of Prisma's DMMF (`getDMMF`, or a generator's `options.dmmf.datamodel`). */
export type PrismaDatamodel = {
  readonly models: readonly {
    readonly name: string;
    readonly fields: readonly {
      readonly name: string;
      readonly kind: string;
      readonly isRequired: boolean;
      readonly isList: boolean;
    }[];
  }[];
};

const BLOCK = /^\s*(model|type|view)\s+([A-Za-z_]\w*)\s*\{/u;
const FIELD =
  /^\s*([A-Za-z_]\w*)\s+([A-Za-z_][\w.:]*)(\([^)]*\))?(\[\])?(\?)?/u;

function fromSchema(
  schema: string,
  model: string,
): PrismaModelFields | undefined {
  const lines = schema.split(/\r?\n/u);
  const composite = new Set<string>();
  for (const line of lines) {
    const block = BLOCK.exec(line);
    if (block !== null) {
      composite.add(block[2] ?? '');
    }
  }
  const required: string[] = [];
  const lists: string[] = [];
  let inside = false;
  let found = false;
  for (const line of lines) {
    const code = line.replace(/\/\/.*$/u, '').trim();
    if (!inside) {
      const block = BLOCK.exec(code);
      if (block?.[1] === 'model' && block[2] === model) {
        inside = true;
        found = true;
      }
      continue;
    }
    if (code === '}') {
      break;
    }
    if (code === '' || code.startsWith('@@')) {
      continue;
    }
    const field = FIELD.exec(code);
    if (field === null) {
      continue;
    }
    const [, name = '', type = '', , list, optional] = field;
    if (type.includes(':') || composite.has(type)) {
      continue;
    }
    if (list !== undefined) {
      lists.push(name);
    } else if (optional === undefined) {
      required.push(name);
    }
  }
  return found ? { required, lists } : undefined;
}

function fromDatamodel(
  datamodel: PrismaDatamodel,
  model: string,
): PrismaModelFields | undefined {
  const found = datamodel.models.find((item) => item.name === model);
  if (found === undefined) {
    return undefined;
  }
  const scalars = found.fields.filter(
    (field) => field.kind === 'scalar' || field.kind === 'enum',
  );
  return {
    required: scalars
      .filter((field) => field.isRequired && !field.isList)
      .map((field) => field.name),
    lists: scalars.filter((field) => field.isList).map((field) => field.name),
  };
}

/**
 * Reads a model's required and list fields from `schema.prisma` text or a DMMF datamodel, for
 * the `model` option of `toWhere` and `toPredicate`. Relation fields are skipped.
 */
export function prismaModelFields(
  datamodel: string | PrismaDatamodel,
  model: string,
): PrismaModelFields {
  assertSafeKey(model, 'Prisma model');
  const fields =
    typeof datamodel === 'string'
      ? fromSchema(datamodel, model)
      : fromDatamodel(datamodel, model);
  if (fields === undefined) {
    throw new Error(
      `PermDock: Prisma model '${model}' is not in the datamodel`,
    );
  }
  return Object.freeze({
    required: Object.freeze(fields.required),
    lists: Object.freeze(fields.lists),
  });
}
