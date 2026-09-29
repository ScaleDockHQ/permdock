import Link from 'next/link';

import { organizations, people } from '../lib/store.ts';

export default function Home() {
  return (
    <main>
      <h1>PermDock on Next.js 16.3</h1>
      <p>
        Sign in as one of the demo people, then move between organizations,
        quotes and the customer portal. Every gated link and button comes from
        the prefetched App Shell.
      </p>
      <section aria-label="Sign in">
        {people.map((person) => (
          <form key={person.id} method="post" action="/api/session">
            <input type="hidden" name="user" value={person.id} />
            <button type="submit">Sign in as {person.name}</button>
          </form>
        ))}
        <form method="post" action="/api/session">
          <button type="submit">Sign out</button>
        </form>
      </section>
      <nav aria-label="Organizations">
        <ul>
          {organizations.map((organization) => (
            <li key={organization.id}>
              <Link
                href={`/${organization.id}`}
                prefetch
                data-org-link={organization.id}
              >
                {organization.name}
              </Link>
            </li>
          ))}
          <li>
            <Link href="/portal/acme" prefetch data-org-link="portal">
              Acme customer portal
            </Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
