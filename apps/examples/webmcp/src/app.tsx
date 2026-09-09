import type { Snapshot } from 'permdock';

import { PermDockProvider, usePermDock } from 'permdock/react';
import { registerTools } from 'permdock/webmcp';
import { useEffect, useState } from 'react';

import { ownPost, permissions } from './permissions.ts';

type FakeTool = { readonly name: string; readonly description: string };

const handlers = {
  async read() {
    const row = await Promise.resolve(ownPost);
    return row;
  },
  async update() {
    const row = await Promise.resolve(ownPost);
    return row;
  },
  async create() {
    const row = await Promise.resolve(ownPost);
    return row;
  },
  async list() {
    const rows = await Promise.resolve([ownPost]);
    return rows;
  },
  async delete() {
    const result = await Promise.resolve({ deleted: true as const });
    return result;
  },
};

function PostTools() {
  const permdock = usePermDock();
  const [tools, setTools] = useState<readonly FakeTool[]>([]);

  useEffect(() => {
    const registered: FakeTool[] = [];
    const controller = new AbortController();
    registerTools(
      {
        registerTool(tool, options) {
          registered.push({
            name: tool.name,
            description: tool.description ?? tool.name,
          });
          setTools([...registered]);
          options?.signal?.addEventListener(
            'abort',
            () => {
              setTools((current) =>
                current.filter((item) => item.name !== tool.name),
              );
            },
            { once: true },
          );
          return {};
        },
      },
      permissions.post,
      { permdock, signal: controller.signal, handlers },
    );
    return () => {
      controller.abort();
    };
  }, [permdock]);

  if (tools.length === 0) {
    return <p>no tools</p>;
  }
  return (
    <ul>
      {tools.map((tool) => (
        <li key={tool.name}>{tool.name}</li>
      ))}
    </ul>
  );
}

export function App(props: { readonly snapshot: Snapshot }) {
  return (
    <PermDockProvider snapshot={props.snapshot}>
      <PostTools />
    </PermDockProvider>
  );
}
