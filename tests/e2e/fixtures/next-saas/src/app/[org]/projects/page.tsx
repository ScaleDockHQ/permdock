import { Suspense } from "react";

import { getProjects, serverPermDock } from "../../../lib/access.ts";
import { permissions } from "../../../permissions.ts";
import { ForbiddenState } from "../forbidden-state.tsx";
import { RowActions } from "./row-actions.tsx";

/** The project cache is shared per org; the member check runs per request. */
async function ProjectList(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  const { org } = await props.params;
  const { permdock } = await serverPermDock(org);
  if (!permdock.can(permissions.project.list)) {
    return <ForbiddenState label="Projects" />;
  }
  const projects = permdock.filter(
    permissions.project.read,
    await getProjects(org),
  );
  return (
    <ul aria-label="Projects">
      {projects.map((project) => (
        <li key={project.id} data-project={project.id}>
          {project.name}
          {project.archived ? " (archived)" : ""}{" "}
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
