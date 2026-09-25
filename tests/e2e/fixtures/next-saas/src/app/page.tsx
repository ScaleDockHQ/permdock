import Link from 'next/link';

import { orgs } from '../nav.ts';

export default function OrgPicker() {
  return (
    <main>
      <h1>Your organizations</h1>
      <ul>
        {orgs.map((org) => (
          <li key={org.id}>
            <Link href={`/${org.id}`} prefetch data-org-link={org.id}>
              {org.name}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
