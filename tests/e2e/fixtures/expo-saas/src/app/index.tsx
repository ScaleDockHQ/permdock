import type { SaasProject } from 'permdock/testing/saas/permissions';

import { Redirect } from 'expo-router';
import { usePermission } from 'permdock/react-native';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';

import type { NavItem } from '@permdock/e2e-saas-kit/nav';

import { navItems, permissions } from '@permdock/e2e-saas-kit/nav';

import { ORG, post, useSession } from '../lib/session';

function NavEntry(props: {
  readonly item: NavItem;
  readonly plan: string | null;
}) {
  const { allowed } = usePermission(props.item.permission);
  if (allowed) {
    return <Text testID={`nav-${props.item.id}`}>{props.item.label}</Text>;
  }
  if (props.item.pro === true && props.plan !== 'pro') {
    return (
      <Text testID={`upsell-${props.item.id}`}>
        {props.item.label}: upgrade to Pro
      </Text>
    );
  }
  return null;
}

function Row(props: {
  readonly project: SaasProject;
  readonly onChange: () => void;
}) {
  const { allowed } = usePermission(permissions.project.delete, props.project);
  const [result, setResult] = useState('');
  const onDelete = async (): Promise<void> => {
    const response = await post(
      `/api/projects/${encodeURIComponent(props.project.id)}/delete?org=${ORG}`,
    );
    if (response.ok) {
      props.onChange();
    } else {
      setResult(`Denied: ${String(response.status)}`);
    }
  };
  return (
    <View testID={`project-${props.project.id}`}>
      <Text>{props.project.name}</Text>
      {allowed ? (
        <Pressable role="button" onPress={() => void onDelete()}>
          <Text>Delete</Text>
        </Pressable>
      ) : null}
      <Text testID={`result-${props.project.id}`}>{result}</Text>
    </View>
  );
}

function Projects() {
  const [projects, setProjects] = useState<readonly SaasProject[]>([]);
  const load = useCallback(() => {
    fetch(`/api/projects?org=${ORG}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(
        // SAFETY: the fixture's /api/projects route answers { projects: SaasProject[] }
        (response) => response.json() as Promise<{ projects: SaasProject[] }>,
      )
      .then((body) => {
        setProjects(body.projects);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        load();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [load]);
  return (
    <View testID="projects">
      {projects.map((project) => (
        <Row key={project.id} project={project} onChange={load} />
      ))}
    </View>
  );
}

async function signOut(): Promise<void> {
  await post('/api/logout');
  window.location.assign('/login');
}

export default function Home() {
  const session = useSession();
  if (session.user === null) {
    return <Redirect href="/login" />;
  }
  return (
    <View>
      <Text testID="user">{session.user}</Text>
      <View testID="nav">
        {navItems.map((item) => (
          <NavEntry key={item.id} item={item} plan={session.plan} />
        ))}
      </View>
      <Projects />
      <Pressable role="button" onPress={() => void signOut()}>
        <Text>Sign out</Text>
      </Pressable>
    </View>
  );
}
