import { compact } from '../core/compact.ts';
import { authenticateScim } from './auth.ts';
import {
  groupFromBody,
  isRecord,
  readJson,
  schemasOk,
  userFromBody,
} from './body.ts';
import { resourceTypes, schemas, serviceProviderConfig } from './discovery.ts';
import {
  directoryEvent,
  emitDirectory,
  membershipEventsForGroup,
  reportUnknownRoles,
} from './emit.ts';
import { filterSupported, parseScimFilter } from './filter.ts';
import { normalizePatchOps, readPatchOperations } from './patch.ts';
import {
  forbidden,
  listBody,
  mapStoreError,
  renderGroup,
  renderUser,
  scimError,
  scimResponse,
  unauthorized,
} from './render.ts';
import { audienceOf, locationOf, pageFrom, parseRoute } from './route.ts';
import { GROUP_SCHEMA, USER_SCHEMA, type ScimHandlerOptions } from './types.ts';

export function scimHandler(
  options: ScimHandlerOptions,
): (request: Request) => Promise<Response> {
  if (options.token === undefined && options.verifier === undefined) {
    throw new Error('scimHandler requires token or verifier');
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = parseRoute(url);
    if (route === undefined) {
      return scimError(404, 'invalidValue', 'unknown route');
    }

    let tenant: string;
    try {
      tenant =
        typeof options.tenant === 'string'
          ? options.tenant
          : await options.tenant(request);
    } catch {
      return forbidden();
    }
    if (tenant === '') {
      return forbidden();
    }

    const auth = await authenticateScim(
      compact({
        request,
        tenant,
        audience: audienceOf(request, options.audience),
        token: options.token,
        verifier: options.verifier,
      }),
    );
    if (!auth.ok) {
      return auth.status === 403 ? forbidden() : unauthorized();
    }

    try {
      if (route.kind === 'ServiceProviderConfig') {
        return scimResponse(200, serviceProviderConfig());
      }
      if (route.kind === 'ResourceTypes') {
        return scimResponse(200, resourceTypes());
      }
      if (route.kind === 'Schemas') {
        const all = schemas();
        if (route.id !== undefined) {
          const schema = all.find((item) => item['id'] === route.id);
          if (schema === undefined) {
            return scimError(404, 'invalidValue', 'schema not found');
          }
          return scimResponse(200, schema);
        }
        return scimResponse(200, all);
      }

      if (request.method === 'GET' && route.id === undefined) {
        const rawFilter = url.searchParams.get('filter');
        const filter =
          rawFilter === null || rawFilter === ''
            ? undefined
            : parseScimFilter(rawFilter);
        if (rawFilter !== null && rawFilter !== '' && filter === undefined) {
          return scimError(400, 'invalidFilter', 'unsupported filter');
        }
        if (filter !== undefined && !filterSupported(filter)) {
          return scimError(400, 'invalidFilter', 'unsupported filter');
        }
        const page = pageFrom(url);
        if (route.kind === 'Users') {
          const result = await options.store.findUsers(tenant, filter, page);
          return scimResponse(
            200,
            listBody(result, (user) =>
              renderUser(user, locationOf(request, 'Users', user.id)),
            ),
          );
        }
        const result = await options.store.findGroups(tenant, filter, page);
        return scimResponse(
          200,
          listBody(result, (group) =>
            renderGroup(group, locationOf(request, 'Groups', group.id)),
          ),
        );
      }

      if (request.method === 'GET' && route.id !== undefined) {
        if (route.kind === 'Users') {
          const user = await options.store.getUser(tenant, route.id);
          if (user === null) {
            return scimError(404, 'invalidValue', 'resource not found');
          }
          return scimResponse(
            200,
            renderUser(user, locationOf(request, 'Users', user.id)),
          );
        }
        const group = await options.store.getGroup(tenant, route.id);
        if (group === null) {
          return scimError(404, 'invalidValue', 'resource not found');
        }
        return scimResponse(
          200,
          renderGroup(group, locationOf(request, 'Groups', group.id)),
        );
      }

      if (request.method === 'DELETE' && route.id !== undefined) {
        if (route.kind === 'Users') {
          const existing = await options.store.getUser(tenant, route.id);
          await options.store.deleteUser(tenant, route.id);
          await emitDirectory(
            options,
            directoryEvent({
              operation: 'delete',
              tenant,
              type: 'User',
              id: route.id,
              credential: auth.credential,
              active: false,
            }),
            existing === null ? [] : [existing.id],
            [],
            existing === null ? [] : [existing],
          );
          return new Response(null, { status: 204 });
        }
        const existing = await options.store.getGroup(tenant, route.id);
        await options.store.deleteGroup(tenant, route.id);
        await emitDirectory(
          options,
          directoryEvent({
            operation: 'delete',
            tenant,
            type: 'Group',
            id: route.id,
            credential: auth.credential,
          }),
          existing?.members.map((member) => member.value) ?? [],
          membershipEventsForGroup({
            tenant,
            groupId: route.id,
            roles: existing?.roles ?? options.groupRoles?.[route.id] ?? [],
            previous: existing,
            next: null,
          }),
        );
        return new Response(null, { status: 204 });
      }

      const body = await readJson(request);
      if (!isRecord(body)) {
        return scimError(400, 'invalidSyntax', 'malformed body');
      }

      if (request.method === 'POST' && route.id === undefined) {
        if (route.kind === 'Users') {
          if (!schemasOk(body, USER_SCHEMA)) {
            return scimError(400, 'invalidSyntax', 'unsupported schema');
          }
          const parsed = userFromBody(body, '');
          if (parsed === undefined) {
            return scimError(400, 'invalidValue', 'userName is required');
          }
          const stored = await options.store.putUser(tenant, parsed);
          const location = locationOf(request, 'Users', stored.id);
          await emitDirectory(
            options,
            directoryEvent({
              operation: 'create',
              tenant,
              type: 'User',
              id: stored.id,
              credential: auth.credential,
              active: stored.active,
            }),
            [stored.id],
          );
          return scimResponse(201, renderUser(stored, location), {
            location,
          });
        }
        if (!schemasOk(body, GROUP_SCHEMA)) {
          return scimError(400, 'invalidSyntax', 'unsupported schema');
        }
        const parsed = groupFromBody(
          body,
          '',
          options.groupRoles?.[body['id'] as string],
        );
        if (parsed === undefined) {
          return scimError(400, 'invalidValue', 'displayName is required');
        }
        reportUnknownRoles(parsed.roles, options);
        const stored = await options.store.putGroup(tenant, parsed);
        const location = locationOf(request, 'Groups', stored.id);
        await emitDirectory(
          options,
          directoryEvent({
            operation: 'create',
            tenant,
            type: 'Group',
            id: stored.id,
            credential: auth.credential,
          }),
          stored.members.map((member) => member.value),
          membershipEventsForGroup({
            tenant,
            groupId: stored.id,
            roles: stored.roles ?? options.groupRoles?.[stored.id] ?? [],
            previous: null,
            next: stored,
          }),
        );
        return scimResponse(201, renderGroup(stored, location), { location });
      }

      if (request.method === 'PUT' && route.id !== undefined) {
        if (route.kind === 'Users') {
          if (!schemasOk(body, USER_SCHEMA)) {
            return scimError(400, 'invalidSyntax', 'unsupported schema');
          }
          const existing = await options.store.getUser(tenant, route.id);
          if (existing === null) {
            return scimError(404, 'invalidValue', 'resource not found');
          }
          const parsed = userFromBody(body, route.id);
          if (parsed === undefined) {
            return scimError(400, 'invalidValue', 'userName is required');
          }
          const stored = await options.store.putUser(tenant, parsed);
          const location = locationOf(request, 'Users', stored.id);
          await emitDirectory(
            options,
            directoryEvent({
              operation: 'replace',
              tenant,
              type: 'User',
              id: stored.id,
              credential: auth.credential,
              active: stored.active,
            }),
            [stored.id],
          );
          return scimResponse(200, renderUser(stored, location), { location });
        }
        if (!schemasOk(body, GROUP_SCHEMA)) {
          return scimError(400, 'invalidSyntax', 'unsupported schema');
        }
        const existing = await options.store.getGroup(tenant, route.id);
        if (existing === null) {
          return scimError(404, 'invalidValue', 'resource not found');
        }
        const parsed = groupFromBody(
          body,
          route.id,
          options.groupRoles?.[route.id],
        );
        if (parsed === undefined) {
          return scimError(400, 'invalidValue', 'displayName is required');
        }
        reportUnknownRoles(parsed.roles, options);
        const stored = await options.store.putGroup(tenant, parsed);
        const location = locationOf(request, 'Groups', stored.id);
        await emitDirectory(
          options,
          directoryEvent({
            operation: 'replace',
            tenant,
            type: 'Group',
            id: stored.id,
            credential: auth.credential,
          }),
          stored.members.map((member) => member.value),
          membershipEventsForGroup({
            tenant,
            groupId: stored.id,
            roles: stored.roles ?? existing.roles ?? [],
            previous: existing,
            next: stored,
          }),
        );
        return scimResponse(200, renderGroup(stored, location), { location });
      }

      if (request.method === 'PATCH' && route.id !== undefined) {
        const operations = readPatchOperations(body);
        if (operations === undefined) {
          return scimError(400, 'invalidSyntax', 'Operations required');
        }
        const normalized = normalizePatchOps(operations);
        if (normalized === undefined) {
          return scimError(400, 'invalidSyntax', 'invalid patch');
        }
        if (route.kind === 'Users') {
          const stored = await options.store.patchUser(
            tenant,
            route.id,
            normalized,
          );
          const location = locationOf(request, 'Users', stored.id);
          await emitDirectory(
            options,
            directoryEvent({
              operation: 'patch',
              tenant,
              type: 'User',
              id: stored.id,
              credential: auth.credential,
              active: stored.active,
            }),
            [stored.id],
          );
          return scimResponse(200, renderUser(stored, location), { location });
        }
        const existing = await options.store.getGroup(tenant, route.id);
        const stored = await options.store.patchGroup(
          tenant,
          route.id,
          normalized,
        );
        const location = locationOf(request, 'Groups', stored.id);
        await emitDirectory(
          options,
          directoryEvent({
            operation: 'patch',
            tenant,
            type: 'Group',
            id: stored.id,
            credential: auth.credential,
          }),
          stored.members.map((member) => member.value),
          membershipEventsForGroup({
            tenant,
            groupId: stored.id,
            roles: stored.roles ?? existing?.roles ?? [],
            previous: existing,
            next: stored,
          }),
        );
        return scimResponse(200, renderGroup(stored, location), { location });
      }

      return scimError(405, 'invalidValue', 'method not allowed');
    } catch (error) {
      if (error instanceof SyntaxError) {
        return scimError(400, 'invalidSyntax', 'malformed body');
      }
      return mapStoreError(error);
    }
  };
}
