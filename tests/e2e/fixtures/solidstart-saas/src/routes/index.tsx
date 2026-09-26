import { orgs } from '@permdock/e2e-saas-kit/nav';
import { For } from 'solid-js';

export default function Home() {
  return (
    <main>
      <h1>Your organizations</h1>
      <ul>
        <For each={orgs}>
          {(org) => (
            <li>
              <a href={`/${org.id}`} data-org-link={org.id}>
                {org.name}
              </a>
            </li>
          )}
        </For>
      </ul>
    </main>
  );
}
