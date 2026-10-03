import { createPermDock } from 'permdock/terminal';

import { permissions, production, staging } from './permissions.ts';
import { developerUser, policy, releaseUser } from './policy.ts';

const { permdock, protect, filterCommands } = createPermDock(policy, {
  subject: async ({ token }) => {
    const raw = await token(['env', 'keychain']);
    if (raw === 'release') {
      return releaseUser;
    }
    return raw === null ? null : developerUser;
  },
  actor: async ({ token }) => {
    const raw = await token([{ env: 'PERMDOCK_ACTOR_TOKEN' }]);
    if (raw === null) {
      return null;
    }
    return {
      principal: { id: 'agent-1', kind: 'service' as const },
      context: {},
      actor: { id: 'agent-1', kind: 'oauth-client' },
      delegation: { scopes: raw.split(' ') },
    };
  },
  storage: { service: 'permdock-example-terminal' },
});

const commands = [
  {
    name: 'status',
    permission: permissions.deploy.read,
    description: 'Show the current deployment',
  },
  {
    name: 'deploy',
    permission: permissions.deploy.run,
    description: 'Deploy a service',
  },
  {
    name: 'rollback',
    permission: permissions.deploy.rollback,
    description: 'Roll back to the previous release',
  },
];

const raw = process.argv.slice(2);
const argv = raw[0] === '--' ? raw.slice(1) : raw;
await permdock();

if (argv[0] === '--help' || argv.length === 0) {
  for (const entry of filterCommands(commands, { mode: 'annotate' })) {
    process.stdout.write(`${entry.name}\t${entry.description}\n`);
  }
} else {
  const envFlag = argv.includes('--env')
    ? (argv[argv.indexOf('--env') + 1] ?? 'staging')
    : 'staging';
  const data = envFlag === 'production' ? production : staging;
  const name = argv[0];
  if (name === 'status') {
    await protect(permissions.deploy.read)(() => {
      process.stdout.write(`${data.id} ${data.env}\n`);
    })();
  } else if (name === 'deploy') {
    await protect(
      permissions.deploy.run,
      () => data,
    )(() => {
      process.stdout.write(`deployed ${data.id} to ${data.env}\n`);
    })();
  } else if (name === 'rollback') {
    await protect(
      permissions.deploy.rollback,
      () => data,
    )(() => {
      process.stdout.write(`rolled back ${data.id} on ${data.env}\n`);
    })();
  } else {
    process.stderr.write(`unknown command: ${name ?? ''}\n`);
    process.exitCode = 1;
  }
}
