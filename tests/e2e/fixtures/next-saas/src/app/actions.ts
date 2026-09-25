'use server';

import type { Decision } from 'permdock';

import { updateTag } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { serverPermDock } from '../lib/access.ts';
import { getClaims, mintSession } from '../lib/session.ts';
import { findProject, removeProject, setRole } from '../lib/store.ts';
import { SESSION_COOKIE, TOKEN_TTL_SECONDS } from '../lib/token.ts';
import { users } from '../nav.ts';
import { permissions, roleNames } from '../permissions.ts';

export type ActionResult = { readonly ok: boolean; readonly reason?: string };

function reasonOf(decision: Decision): string {
  switch (decision.outcome) {
    case 'granted':
      return 'granted';
    case 'denied':
      return decision.denials[0]?.reason ?? 'denied';
    case 'approval-required':
      return decision.reason;
    default: {
      const unreachable: never = decision;
      return unreachable;
    }
  }
}

function isUser(value: unknown): value is (typeof users)[number] {
  return users.some((user) => user === value);
}

/** Test-only login: mints a session for a fixture user. */
export async function signIn(form: FormData): Promise<void> {
  const user = form.get('user');
  const next = form.get('next');
  if (!isUser(user)) {
    return redirect('/login');
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await mintSession(user), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: TOKEN_TTL_SECONDS,
  });
  updateTag(`permdock:${user}`);
  redirect(typeof next === 'string' && next.startsWith('/') ? next : '/');
}

export async function signOut(): Promise<void> {
  const claims = await getClaims();
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  if (claims !== null) {
    updateTag(`permdock:${claims.sub}`);
  }
  redirect('/login');
}

export async function deleteProject(
  org: string,
  id: string,
): Promise<ActionResult> {
  const project = findProject(id);
  if (project === undefined || project.orgId !== org) {
    return { ok: false, reason: 'not-found' };
  }
  const { permdock } = await serverPermDock(org);
  const decision = permdock.decide(permissions.project.delete, project);
  if (decision.outcome !== 'granted') {
    return { ok: false, reason: reasonOf(decision) };
  }
  removeProject(id);
  updateTag(`org:${org}`);
  return { ok: true };
}

export async function changeRole(
  org: string,
  user: string,
  role: string,
): Promise<ActionResult> {
  const { permdock } = await serverPermDock(org);
  const decision = permdock.decide(permissions.member.assignRole);
  if (decision.outcome !== 'granted') {
    return { ok: false, reason: reasonOf(decision) };
  }
  if (!roleNames.some((name) => name === role)) {
    return { ok: false, reason: 'unknown-role' };
  }
  if (!setRole(org, user, role)) {
    return { ok: false, reason: 'not-found' };
  }
  updateTag(`org:${org}`);
  updateTag(`permdock:${user}`);
  return { ok: true };
}
