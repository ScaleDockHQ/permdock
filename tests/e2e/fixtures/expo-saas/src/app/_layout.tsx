import AsyncStorage from '@react-native-async-storage/async-storage';
import { Slot } from 'expo-router';
import { joseTokenVerifier } from 'permdock/jwt';
import { PermDockProvider } from 'permdock/react-native';
import { useEffect, useMemo, useState } from 'react';
import { AppState, Text } from 'react-native';

import type { Session } from '../lib/session';

import { ORG, SessionContext } from '../lib/session';

function subscribeForeground(listener: () => void): () => void {
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      listener();
    }
  });
  return () => {
    subscription.remove();
  };
}

export default function Layout() {
  const [session, setSession] = useState<Session | undefined>(undefined);
  useEffect(() => {
    fetch(`/api/me?org=${ORG}`, { credentials: 'include', cache: 'no-store' })
      .then((response) => response.json() as Promise<Session>)
      .then(setSession)
      .catch(() => {
        setSession({ user: null, plan: null });
      });
  }, []);
  const verifier = useMemo(
    () =>
      typeof window === 'undefined'
        ? undefined
        : joseTokenVerifier({
            jwks: new URL('/api/jwks', window.location.origin),
            typ: 'permdock-snapshot+jwt',
            algorithms: ['ES256'],
          }),
    [],
  );
  if (session === undefined) {
    return <Text testID="booting">Loading</Text>;
  }
  if (session.user === null) {
    return (
      <SessionContext value={session}>
        <Slot />
      </SessionContext>
    );
  }
  return (
    <SessionContext value={session}>
      <PermDockProvider
        storage={AsyncStorage}
        subjectId={session.user}
        tenant={ORG}
        snapshotUrl={`/api/snapshot?org=${ORG}`}
        revalidate="focus"
        subscribeForeground={subscribeForeground}
        verifier={verifier}
      >
        <Slot />
      </PermDockProvider>
    </SessionContext>
  );
}
