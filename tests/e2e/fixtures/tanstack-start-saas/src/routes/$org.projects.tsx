import type { SaasProject } from '@permdock/testing/saas';

import { permissions } from '@permdock/e2e-saas-kit/nav';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { usePermission } from 'permdock/react';
import { useState } from 'react';

import { Forbidden } from '../lib/forbidden';
import { getProjects, removeProject } from '../lib/saas.functions';

export const Route = createFileRoute('/$org/projects')({
  loader: ({ params }) => getProjects({ data: { org: params.org } }),
  component: Projects,
});

function Row(props: { readonly project: SaasProject }) {
  const router = useRouter();
  const { allowed } = usePermission(permissions.project.delete, props.project);
  const [result, setResult] = useState('');
  const onDelete = async (): Promise<void> => {
    const outcome = await removeProject({ data: { id: props.project.id } });
    if (outcome.ok) {
      await router.invalidate();
    } else {
      setResult(`Denied: ${outcome.reason ?? 'denied'}`);
    }
  };
  return (
    <li data-project={props.project.id}>
      {props.project.name}{' '}
      {allowed ? (
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
      ) : null}
      <output>{result}</output>
    </li>
  );
}

function Projects() {
  const data = Route.useLoaderData();
  return (
    <>
      <h1>Projects</h1>
      {data.forbidden ? (
        <Forbidden label="Projects" />
      ) : (
        <ul aria-label="Projects">
          {data.projects.map((project) => (
            <Row key={project.id} project={project} />
          ))}
        </ul>
      )}
    </>
  );
}
