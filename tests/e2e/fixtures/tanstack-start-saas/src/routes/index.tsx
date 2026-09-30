import { Link, createFileRoute } from '@tanstack/react-router';

import { orgs } from '@permdock/e2e-saas-kit/nav';

export const Route = createFileRoute('/')({
  component: () => (
    <main>
      <h1>Your organizations</h1>
      <ul>
        {orgs.map((org) => (
          <li key={org.id}>
            <Link to="/$org" params={{ org: org.id }} data-org-link={org.id}>
              {org.name}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  ),
});
