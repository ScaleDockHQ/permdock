import { type SaasDoc, saasSeed } from '@permdock/testing/saas';

export type Edit = { readonly docId: string; readonly by: string };

const texts = new Map<string, string>();
const listeners = new Set<(edit: Edit) => void>();

export function findDoc(id: string | undefined): SaasDoc | undefined {
  return saasSeed.docs.find((doc) => doc.id === id);
}

export function textOf(id: string): string {
  return texts.get(id) ?? findDoc(id)?.title ?? '';
}

export function writeText(edit: Edit, text: string): void {
  texts.set(edit.docId, text);
  for (const listener of listeners) {
    listener(edit);
  }
}

export function resetDocs(): void {
  texts.clear();
}

/** Edits to `docId` until `signal` aborts. */
export async function* editsOf(
  docId: string,
  signal: AbortSignal,
): AsyncGenerator<Edit> {
  const queue: Edit[] = [];
  let wake: (() => void) | undefined;
  const push = (edit: Edit): void => {
    if (edit.docId === docId) {
      queue.push(edit);
      wake?.();
    }
  };
  const stop = (): void => wake?.();
  const idle = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  listeners.add(push);
  signal.addEventListener('abort', stop);
  try {
    while (!signal.aborted) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- edits arrive one at a time
      await idle();
      wake = undefined;
    }
  } finally {
    listeners.delete(push);
    signal.removeEventListener('abort', stop);
  }
}
