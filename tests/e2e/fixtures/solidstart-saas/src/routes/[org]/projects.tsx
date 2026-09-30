import type { RouteSectionProps } from '@solidjs/router';
import type { SaasProject } from 'permdock/testing/saas';

import { permissions } from '@permdock/e2e-saas-kit/nav';
import { createAsync, revalidate } from '@solidjs/router';
import { usePermission } from 'permdock/solid';
import { For, Show, createSignal } from 'solid-js';

import { Forbidden } from '../../lib/forbidden';
import { getProjects, getSnapshot, removeProject } from '../../lib/saas';

function Row(props: { readonly project: SaasProject }) {
  const state = usePermission(permissions.project.delete, () => props.project);
  const [result, setResult] = createSignal('');
  const onDelete = async (): Promise<void> => {
    const outcome = await removeProject(props.project.id);
    if (outcome.ok) {
      await revalidate([getProjects.key, getSnapshot.key]);
    } else {
      setResult(`Denied: ${outcome.reason ?? 'denied'}`);
    }
  };
  return (
    <li data-project={props.project.id}>
      {props.project.name}{' '}
      <Show when={state().allowed}>
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
      </Show>
      <output>{result()}</output>
    </li>
  );
}

export default function Projects(props: RouteSectionProps) {
  const data = createAsync(() => getProjects(props.params['org'] ?? ''));
  return (
    <>
      <h1>Projects</h1>
      <Show when={data()}>
        {(current) => (
          <Show
            when={!current().forbidden}
            fallback={<Forbidden label="Projects" />}
          >
            <ul aria-label="Projects">
              <For each={current().projects}>
                {(project) => <Row project={project} />}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </>
  );
}
