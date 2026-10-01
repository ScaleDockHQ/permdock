import { describe, expect, it } from 'vitest';

import type { ScimAttribute, ScimSchema } from './fixtures.ts';

import { sha256Hex } from '../../src/scim/auth.ts';
import {
  resourceTypes,
  schemas,
  serviceProviderConfig,
} from '../../src/scim/discovery.ts';
import { parseScimFilter } from '../../src/scim/filter.ts';
import { scimHandler } from '../../src/scim/handler.ts';
import { memoryDirectoryStore } from '../../src/scim/store.ts';
import {
  ERROR_SCHEMA,
  GROUP_SCHEMA,
  LIST_SCHEMA,
  ROLES_EXTENSION,
  USER_SCHEMA,
} from '../../src/scim/types.ts';
import { standardsFixture } from './fixtures.ts';

const rfc7643 = standardsFixture('rfc7643-schemas.json');
const TENANT = 'o_acme';
const TOKEN = 'scim-secret';
const BASE = `https://app.example.com/scim/v2/${TENANT}`;

function metaSchema(id: string): ScimSchema {
  const found = rfc7643.serviceProviderSchemas.find(
    (schema) => schema.id === id,
  );
  if (found === undefined) {
    throw new Error(`RFC 7643 has no ${id}`);
  }
  return found;
}

const JSON_TYPES: Readonly<Record<string, (value: unknown) => boolean>> = {
  string: (value) => typeof value === 'string',
  reference: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  integer: (value) => Number.isInteger(value),
  decimal: (value) => typeof value === 'number',
  dateTime: (value) => typeof value === 'string',
  complex: (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value),
};

/** Violations of an RFC 7643 schema definition, as `path: problem` lines. */
function violations(
  value: Readonly<Record<string, unknown>>,
  attributes: readonly (ScimAttribute & {
    readonly canonicalValues?: readonly string[];
  })[],
  path = '',
): readonly string[] {
  const found: string[] = [];
  for (const attribute of attributes) {
    const at = `${path}${attribute.name}`;
    const raw = value[attribute.name];
    if (raw === undefined) {
      if (attribute.required) {
        found.push(`${at}: required`);
      }
      continue;
    }
    const items: readonly unknown[] = attribute.multiValued
      ? Array.isArray(raw)
        ? raw
        : [Symbol('not an array')]
      : [raw];
    for (const item of items) {
      if (!(JSON_TYPES[attribute.type]?.(item) ?? false)) {
        found.push(`${at}: not ${attribute.type}`);
        continue;
      }
      if (
        attribute.canonicalValues !== undefined &&
        typeof item === 'string' &&
        !attribute.canonicalValues.includes(item)
      ) {
        found.push(`${at}: ${item} is not canonical`);
      }
      if (attribute.type === 'complex' && attribute.subAttributes) {
        // SAFETY: JSON_TYPES.complex checked item is a non-array object above.
        const nested = item as Readonly<Record<string, unknown>>;
        found.push(...violations(nested, attribute.subAttributes, `${at}.`));
      }
    }
  }
  return found;
}

function handler() {
  const hash = sha256Hex(TOKEN);
  return scimHandler({
    store: memoryDirectoryStore(),
    tenant: () => TENANT,
    token: {
      hash: 'sha256',
      lookup: (tenant) => (tenant === TENANT ? hash : undefined),
    },
  });
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${TOKEN}`);
  if (init.body !== undefined) {
    headers.set('content-type', 'application/scim+json');
  }
  return new Request(`${BASE}${path}`, { ...init, headers });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  // SAFETY: every SCIM response read here is a JSON object.
  return (await response.json()) as Record<string, unknown>;
}

function resources(
  list: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const value = list['Resources'];
  // SAFETY: a ListResponse carries Resources as an array of resource objects.
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

describe('RFC 7643 SCIM Core Schema (September 2015)', () => {
  it('section 7: every schema PermDock serves conforms to the Schema schema', () => {
    const schema = metaSchema('urn:ietf:params:scim:schemas:core:2.0:Schema');
    for (const served of schemas()) {
      expect({
        id: served['id'],
        violations: violations(served, schema.attributes),
      }).toEqual({ id: served['id'], violations: [] });
    }
  });

  it('section 6: every resource type conforms to the ResourceType schema', () => {
    const schema = metaSchema(
      'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
    );
    // Section 8.7.2 marks schemaExtensions single-valued; section 6 and the
    // section 8.6 example make it a list, which is what clients parse.
    const attributes = schema.attributes.map((attribute) =>
      attribute.name === 'schemaExtensions'
        ? Object.assign({}, attribute, { multiValued: true })
        : attribute,
    );
    for (const type of resourceTypes()) {
      expect({
        id: type['id'],
        violations: violations(type, attributes),
      }).toEqual({ id: type['id'], violations: [] });
    }
  });

  it('section 5: the ServiceProviderConfig conforms to its schema', () => {
    const schema = metaSchema(
      'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
    );
    expect(violations(serviceProviderConfig(), schema.attributes)).toEqual([]);
    expect(serviceProviderConfig()).toHaveProperty('etag.supported');
  });

  it('sections 4.1 and 4.2: core attributes keep the RFC type, multiValued and uniqueness', () => {
    for (const served of schemas()) {
      const core = rfc7643.resourceSchemas.find(
        (schema) => schema.id === served['id'],
      );
      if (core === undefined) {
        continue;
      }
      // SAFETY: schemas() returns RFC 7643 section 7 schema resources.
      const attributes = served['attributes'] as readonly ScimAttribute[];
      for (const attribute of attributes) {
        const rfc = core.attributes.find(
          (candidate) => candidate.name === attribute.name,
        );
        if (rfc === undefined) {
          continue;
        }
        expect({
          name: attribute.name,
          type: attribute.type,
          multiValued: attribute.multiValued,
        }).toEqual({
          name: rfc.name,
          type: rfc.type,
          multiValued: rfc.multiValued,
        });
        if (rfc.required) {
          expect({
            name: attribute.name,
            required: attribute.required,
          }).toEqual({ name: attribute.name, required: true });
        }
      }
    }
  });

  it('section 8.6: User and Group resource types match the RFC example', () => {
    const served = resourceTypes();
    for (const example of rfc7643.resourceTypes) {
      expect(served).toContainEqual(
        expect.objectContaining({
          schemas: example['schemas'],
          id: example['id'],
          name: example['name'],
          endpoint: example['endpoint'],
          schema: example['schema'],
        }),
      );
    }
  });

  it('section 10: the roles extension URN is advertised as optional on Group', () => {
    expect(schemas().map((schema) => schema['id'])).toContain(ROLES_EXTENSION);
    const group = resourceTypes().find((type) => type['id'] === 'Group');
    expect(group?.['schemaExtensions']).toEqual([
      { schema: ROLES_EXTENSION, required: false },
    ]);
  });
});

describe('RFC 7644 SCIM Protocol (September 2015)', () => {
  it('section 4: /ServiceProviderConfig is a single object with its schema', async () => {
    const response = await handler()(request('/ServiceProviderConfig'));
    expect(response.headers.get('content-type')).toBe('application/scim+json');
    const config = await body(response);
    expect(config['schemas']).toEqual([
      'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
    ]);
    expect(config['meta']).toEqual({
      resourceType: 'ServiceProviderConfig',
      location: `${BASE}/ServiceProviderConfig`,
    });
  });

  it('section 4: /Schemas and /ResourceTypes return a ListResponse', async () => {
    const handle = handler();
    for (const [path, resourceType, count] of [
      ['/Schemas', 'Schema', 3],
      ['/ResourceTypes', 'ResourceType', 2],
    ] as const) {
      const list = await body(await handle(request(path)));
      expect(list).toMatchObject({
        schemas: [LIST_SCHEMA],
        totalResults: count,
        startIndex: 1,
        itemsPerPage: count,
      });
      for (const resource of resources(list)) {
        expect(resource['meta']).toEqual({
          resourceType,
          location: `${BASE}${path}/${String(resource['id'])}`,
        });
      }
    }
  });

  it('section 4: a single Schema or ResourceType is returned by id', async () => {
    const handle = handler();
    const user = await body(await handle(request(`/Schemas/${USER_SCHEMA}`)));
    expect(user['id']).toBe(USER_SCHEMA);
    const group = await body(await handle(request('/ResourceTypes/Group')));
    expect(group['schema']).toBe(GROUP_SCHEMA);
    expect((await handle(request('/ResourceTypes/Device'))).status).toBe(404);
  });

  it('section 4: a filter on a discovery endpoint is answered 403', async () => {
    const handle = handler();
    for (const path of [
      '/Schemas',
      '/ResourceTypes',
      '/ServiceProviderConfig',
    ]) {
      const response = await handle(
        request(`${path}?filter=${encodeURIComponent('id eq "x"')}`),
      );
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
    }
  });

  it('section 3.4.2.2: the supported operators parse and the others are rejected', async () => {
    for (const filter of [
      'userName eq "ada"',
      'userName ne "ada"',
      'userName co "ad"',
      'userName sw "a"',
      'externalId pr',
      'userName eq "ada" and active eq true',
      'userName eq "ada" or userName eq "bob"',
    ]) {
      expect({ filter, parsed: parseScimFilter(filter) !== undefined }).toEqual(
        { filter, parsed: true },
      );
    }
    const handle = handler();
    for (const filter of [
      'userName ew "a"',
      'userName gt "a"',
      'userName lt "a"',
    ]) {
      const response = await handle(
        request(`/Users?filter=${encodeURIComponent(filter)}`),
      );
      expect({ filter, status: response.status }).toEqual({
        filter,
        status: 400,
      });
      const error = await body(response);
      expect(error).toMatchObject({
        schemas: [ERROR_SCHEMA],
        status: '400',
        scimType: 'invalidFilter',
      });
    }
  });

  it('section 3.12: errors carry the Error schema and status as a string', async () => {
    const handle = handler();
    const created = {
      method: 'POST',
      body: JSON.stringify({ schemas: [USER_SCHEMA], userName: 'ada' }),
    };
    await handle(request('/Users', created));
    const conflict = await handle(request('/Users', created));
    expect(conflict.status).toBe(409);
    expect(await body(conflict)).toMatchObject({
      schemas: [ERROR_SCHEMA],
      status: '409',
      scimType: 'uniqueness',
    });
    const missing = await handle(request('/Users/nope'));
    expect(missing.status).toBe(404);
    expect(await body(missing)).toMatchObject({
      schemas: [ERROR_SCHEMA],
      status: '404',
    });
  });

  it('section 3.1: a created resource has id, meta.location and RFC 3339 times', async () => {
    const response = await handler()(
      request('/Users', {
        method: 'POST',
        body: JSON.stringify({ schemas: [USER_SCHEMA], userName: 'ada' }),
      }),
    );
    expect(response.status).toBe(201);
    const user = await body(response);
    // SAFETY: renderUser always writes meta as an object of strings.
    const meta = user['meta'] as Record<string, string>;
    expect(meta['resourceType']).toBe('User');
    expect(meta['location']).toBe(`${BASE}/Users/${String(user['id'])}`);
    for (const time of [meta['created'], meta['lastModified']]) {
      expect(time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u);
    }
  });

  it('section 3.4.2.4: index pagination is 1-based with totalResults', async () => {
    const handle = handler();
    for (const name of ['a', 'b', 'c']) {
      await handle(
        request('/Users', {
          method: 'POST',
          body: JSON.stringify({ schemas: [USER_SCHEMA], userName: name }),
        }),
      );
    }
    const page = await body(
      await handle(request('/Users?startIndex=2&count=1')),
    );
    expect(page).toMatchObject({
      schemas: [LIST_SCHEMA],
      totalResults: 3,
      startIndex: 2,
      itemsPerPage: 1,
    });
  });
});

describe('RFC 9865 SCIM cursor pagination (October 2025)', () => {
  it('nextCursor continues the listing and totalResults stays', async () => {
    const handle = handler();
    for (const name of ['a', 'b', 'c']) {
      await handle(
        request('/Users', {
          method: 'POST',
          body: JSON.stringify({ schemas: [USER_SCHEMA], userName: name }),
        }),
      );
    }
    const first = await body(await handle(request('/Users?cursor=&count=2')));
    expect(resources(first)).toHaveLength(2);
    expect(typeof first['nextCursor']).toBe('string');
    const second = await body(
      await handle(
        request(`/Users?cursor=${String(first['nextCursor'])}&count=2`),
      ),
    );
    expect(second['totalResults']).toBe(3);
    expect(resources(second)).toHaveLength(1);
    expect(second['nextCursor']).toBeUndefined();
  });

  it('ServiceProviderConfig advertises cursor and index pagination', () => {
    expect(serviceProviderConfig()['pagination']).toEqual({
      cursor: true,
      index: true,
    });
  });
});
