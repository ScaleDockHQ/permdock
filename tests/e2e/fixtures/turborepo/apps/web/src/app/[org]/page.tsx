import { cookies } from "next/headers";

import { projectsOf, readSession, saasPermDock } from "@permdock/e2e-saas-kit";
import { permissions as p } from "@permdock/e2e-turbo-permissions";

export default async function OrgPage(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  const { org } = await props.params;
  const session = await readSession((await cookies()).toString());
  if (session === null) {
    return <p data-testid="signed-out">Signed out</p>;
  }
  const permdock = await saasPermDock(session, org);
  if (!permdock.can(p.project.list)) {
    return <p data-testid="forbidden">Forbidden</p>;
  }
  return (
    <main>
      <h1>{org}</h1>
      <ul>
        {permdock.filter(p.project.read, projectsOf(org)).map((project) => (
          <li key={project.id} data-testid={`project-${project.id}`}>
            {project.name}{" "}
            <button
              type="button"
              disabled={!permdock.can(p.project.update, project)}
            >
              Archive
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
