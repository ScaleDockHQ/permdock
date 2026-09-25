import { Suspense } from 'react';

import { getProjects } from '../../../lib/access.ts';
import { RowActions } from './row-actions.tsx';

async function ProjectList(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  const { org } = await props.params;
  const projects = await getProjects(org);
  return (
    <ul aria-label="Projects">
      {projects.map((project) => (
        <li key={project.id} data-project={project.id}>
          {project.name}
          {project.archived ? ' (archived)' : ''}{' '}
          <RowActions project={project} />
        </li>
      ))}
    </ul>
  );
}

export default function ProjectsPage(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  return (
    <>
      <h1>Projects</h1>
      <Suspense
        fallback={<p data-testid="projects-loading">Loading projects…</p>}
      >
        <ProjectList params={props.params} />
      </Suspense>
    </>
  );
}
