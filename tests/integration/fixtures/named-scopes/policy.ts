import type { CustomRole, Principal } from 'permdock';

import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from 'permdock';
import { z } from 'zod';

/**
 * A B2B scenario drawn from a real field-service SaaS: staff hold one role
 * per organization, portal contacts see their own customer's documents, and
 * platform operators manage organizations without reading tenant data.
 */
const Document = z.object({
  id: z.string(),
  organization_id: z.string(),
  customer_id: z.string(),
  status: z.enum(['draft', 'sent', 'accepted']),
});

const Asset = z.object({
  id: z.string(),
  organization_id: z.string(),
  customer_id: z.string(),
});

const Organization = z.object({ id: z.string() });

const inScopes = {
  organization: { field: 'organization_id', memberOf: 'organization' },
  customer: { field: 'customer_id', memberOf: 'customer' },
} as const;

export const permissions = definePermissions({
  quote: resource(Document, {
    id: 'id',
    actions: ['read', 'update', 'delete', 'accept'],
    relations: inScopes,
  }),
  invoice: resource(Document, {
    id: 'id',
    actions: ['read', 'pay'],
    relations: inScopes,
  }),
  asset: resource(Asset, {
    id: 'id',
    actions: ['read', 'update', 'delete'],
    relations: inScopes,
  }),
  organization: resource(Organization, {
    id: 'id',
    actions: ['read', 'disable'],
    collection: ['list'],
  }),
});

export const roles = defineRoles({
  owner: { on: 'organization', assignable: false },
  admin: { on: 'organization' },
  member: { on: 'organization' },
  viewer: { on: 'organization' },
  contact: { on: 'customer' },
  'platform-admin': {},
  'platform-support': {},
});

const visible = { status: { in: ['sent', 'accepted'] } } as const;

/** Staff roles are held only through staff memberships, and every organization keeps an owner. */
const staff = { for: ['staff'], meta: { audience: 'staff' } } as const;

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: {
      organization: { key: 'organization_id' },
      customer: { key: 'customer_id', within: 'organization' },
    },
    subject: (user: Principal | null) => user,
    roles: [
      role(
        roles.owner,
        [
          allow([
            permissions.quote.read,
            permissions.quote.update,
            permissions.quote.delete,
            permissions.invoice.read,
            permissions.asset.read,
            permissions.asset.update,
            permissions.asset.delete,
          ]),
        ],
        {
          on: 'organization',
          ...staff,
          min: 1,
          assigns: ['owner', 'admin', 'member', 'viewer', 'contact'],
        },
      ),
      role(
        roles.admin,
        [
          allow([
            permissions.quote.read,
            permissions.quote.update,
            permissions.invoice.read,
            permissions.asset.read,
            permissions.asset.update,
            permissions.asset.delete,
          ]),
        ],
        {
          on: 'organization',
          ...staff,
          assigns: ['member', 'viewer', 'contact'],
        },
      ),
      role(
        roles.member,
        [
          allow([
            permissions.quote.read,
            permissions.quote.update,
            permissions.invoice.read,
            permissions.asset.read,
            permissions.asset.update,
          ]),
        ],
        { on: 'organization', ...staff },
      ),
      role(
        roles.viewer,
        [
          allow([
            permissions.quote.read,
            permissions.invoice.read,
            permissions.asset.read,
          ]),
        ],
        { on: 'organization', ...staff },
      ),
      role(
        roles.contact,
        [
          allow(permissions.quote.read, { where: visible }),
          allow(permissions.quote.accept, { where: { status: 'sent' } }),
          allow(permissions.invoice.read, { where: visible }),
          allow(permissions.invoice.pay, { where: { status: 'sent' } }),
          allow(permissions.asset.read),
        ],
        {
          on: 'customer',
          assignable: false,
          for: ['contact'],
          meta: { audience: 'portal' },
        },
      ),
      role(
        roles['platform-admin'],
        [
          allow([
            permissions.organization.list,
            permissions.organization.read,
            permissions.organization.disable,
          ]),
        ],
        { meta: { audience: 'platform' } },
      ),
      role(
        roles['platform-support'],
        [allow([permissions.organization.list, permissions.organization.read])],
        { meta: { audience: 'platform' } },
      ),
    ],
  },
);

/** Org T's tenant-defined role: assets only, and never deleting one. */
export const customRoles: readonly CustomRole[] = [
  {
    tenant: 'T',
    name: 'mechanic',
    includes: ['admin'],
    grants: [
      { permission: 'quote.read', effect: 'deny' },
      { permission: 'quote.update', effect: 'deny' },
      { permission: 'invoice.read', effect: 'deny' },
      { permission: 'asset.delete', effect: 'deny' },
    ],
  },
];

function principal(
  id: string,
  tenant: string | undefined,
  memberships: Principal['memberships'],
  global: readonly string[] = [],
): Principal {
  return {
    id,
    roles: global,
    ...(memberships === undefined ? {} : { memberships }),
    ...(tenant === undefined ? {} : { tenant }),
  };
}

/** The personas; `tenant` is the organization the request is about. */
export const personas = {
  owner: principal('u_owner', 'T', [
    { scope: 'organization', id: 'T', roles: ['owner'], via: 'staff' },
    { scope: 'organization', id: 'B', roles: ['owner'], via: 'staff' },
  ]),
  admin: principal('u_admin', 'T', [
    { scope: 'organization', id: 'T', roles: ['admin'], via: 'staff' },
  ]),
  mechanic: principal('u_mechanic', 'T', [
    { scope: 'organization', id: 'T', roles: ['mechanic'], via: 'staff' },
  ]),
  viewer: principal('u_viewer', 'B', [
    { scope: 'organization', id: 'B', roles: ['viewer'], via: 'staff' },
  ]),
  privateContact: principal('u_private', 'T', [
    {
      scope: 'customer',
      id: 'A',
      within: { organization: 'T' },
      roles: ['contact'],
      via: 'contact',
    },
  ]),
  businessContact: principal('u_business', 'T', [
    {
      scope: 'customer',
      id: 'G',
      within: { organization: 'T' },
      roles: ['contact'],
      via: 'contact',
    },
  ]),
  staffContact: principal('u_staff_contact', 'T', [
    { scope: 'organization', id: 'T', roles: ['member'], via: 'staff' },
    {
      scope: 'customer',
      id: 'C',
      within: { organization: 'B' },
      roles: ['contact'],
      via: 'contact',
    },
  ]),
  platformAdmin: principal(
    'u_platform_admin',
    undefined,
    [],
    ['platform-admin'],
  ),
  platformSupport: principal(
    'u_platform_support',
    undefined,
    [],
    ['platform-support'],
  ),
} as const;

export type Row = z.infer<typeof Document>;

/** Quotes and invoices share the document shape; assets drop `status`. */
export const documents: readonly Row[] = [
  { id: 'd_a_sent', organization_id: 'T', customer_id: 'A', status: 'sent' },
  { id: 'd_a_draft', organization_id: 'T', customer_id: 'A', status: 'draft' },
  {
    id: 'd_a_accepted',
    organization_id: 'T',
    customer_id: 'A',
    status: 'accepted',
  },
  { id: 'd_g_sent', organization_id: 'T', customer_id: 'G', status: 'sent' },
  { id: 'd_c_sent', organization_id: 'B', customer_id: 'C', status: 'sent' },
  { id: 'd_b_draft', organization_id: 'B', customer_id: 'D', status: 'draft' },
];

export const assets = documents.map((row) => ({
  id: row.id.replace('d_', 'a_'),
  organization_id: row.organization_id,
  customer_id: row.customer_id,
}));
