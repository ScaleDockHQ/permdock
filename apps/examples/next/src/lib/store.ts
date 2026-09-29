import type { Membership } from 'permdock';

import type { Quote, RoleName } from '../permissions.ts';

export type Organization = { readonly id: string; readonly name: string };
export type Customer = {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
};
export type Person = { readonly id: string; readonly name: string };

type StaffRow = { user: string; organization: string; role: RoleName };
type ContactRow = { user: string; organization: string; customer: string };

type Store = {
  staff: StaffRow[];
  contacts: ContactRow[];
  quotes: Quote[];
};

export const organizations: readonly Organization[] = [
  { id: 'acme', name: 'Acme Field Services' },
  { id: 'globex', name: 'Globex Maintenance' },
];

export const customers: readonly Customer[] = [
  { id: 'north', organizationId: 'acme', name: 'Northwind Offices' },
  { id: 'south', organizationId: 'acme', name: 'Southside Clinic' },
  { id: 'harbor', organizationId: 'globex', name: 'Harbor Storage' },
];

export const people: readonly Person[] = [
  { id: 'olivia', name: 'Olivia (Acme admin)' },
  { id: 'max', name: 'Max (Acme member)' },
  { id: 'carol', name: 'Carol (Northwind contact)' },
];

const seedQuotes = (): Quote[] => [
  {
    id: 'q-101',
    organization_id: 'acme',
    customer_id: 'north',
    title: 'HVAC service, 3rd floor',
    status: 'sent',
    total: 4200,
  },
  {
    id: 'q-102',
    organization_id: 'acme',
    customer_id: 'north',
    title: 'Annual fire-safety inspection',
    status: 'approved',
    total: 1800,
  },
  {
    id: 'q-103',
    organization_id: 'acme',
    customer_id: 'north',
    title: 'Lobby lighting retrofit',
    status: 'draft',
    total: 9600,
  },
  {
    id: 'q-201',
    organization_id: 'acme',
    customer_id: 'south',
    title: 'Clean-room filter swap',
    status: 'sent',
    total: 7300,
  },
  {
    id: 'q-301',
    organization_id: 'globex',
    customer_id: 'harbor',
    title: 'Dock door repair',
    status: 'sent',
    total: 2500,
  },
];

function seed(): Store {
  return {
    staff: [
      { user: 'olivia', organization: 'acme', role: 'admin' },
      { user: 'olivia', organization: 'globex', role: 'member' },
      { user: 'max', organization: 'acme', role: 'member' },
    ],
    contacts: [{ user: 'carol', organization: 'acme', customer: 'north' }],
    quotes: seedQuotes(),
  };
}

const KEY = Symbol.for('permdock.example-next.store');

// Next bundles route handlers and pages separately; the store lives on
// globalThis so every bundle in the process sees the same rows.
function store(): Store {
  const holder = globalThis as { [KEY]?: Store };
  holder[KEY] ??= seed();
  return holder[KEY];
}

export function resetStore(): void {
  (globalThis as { [KEY]?: Store })[KEY] = seed();
}

export function membershipsOf(user: string): Membership[] {
  const { staff, contacts } = store();
  return [
    ...staff
      .filter((row) => row.user === user)
      .map((row): Membership => ({
        scope: 'organization',
        id: row.organization,
        roles: [row.role],
        via: 'staff',
      })),
    ...contacts
      .filter((row) => row.user === user)
      .map((row): Membership => ({
        scope: 'customer',
        id: row.customer,
        within: { organization: row.organization },
        roles: ['contact'],
        via: 'contact',
      })),
  ];
}

// Reads are async, as they would be against a database.
export async function staffOf(
  organization: string,
): Promise<{ readonly user: string; readonly role: RoleName }[]> {
  await Promise.resolve();
  return store()
    .staff.filter((row) => row.organization === organization)
    .map((row) => ({ user: row.user, role: row.role }));
}

export function setStaffRole(
  organization: string,
  user: string,
  role: RoleName,
): boolean {
  const row =
    store().staff.find(
      (item) => item.organization === organization && item.user === user,
    ) ?? null;
  if (row === null) {
    return false;
  }
  row.role = role;
  return true;
}

export async function quotesOf(organization: string): Promise<Quote[]> {
  await Promise.resolve();
  return store().quotes.filter(
    (quote) => quote.organization_id === organization,
  );
}

export async function findQuote(
  organization: string,
  id: string,
): Promise<Quote | null> {
  await Promise.resolve();
  return (
    store().quotes.find(
      (quote) => quote.organization_id === organization && quote.id === id,
    ) ?? null
  );
}

export function removeQuote(id: string): void {
  const current = store();
  current.quotes = current.quotes.filter((quote) => quote.id !== id);
}

export function setQuoteStatus(id: string, status: Quote['status']): void {
  const quote = store().quotes.find((item) => item.id === id) ?? null;
  if (quote !== null) {
    quote.status = status;
  }
}
