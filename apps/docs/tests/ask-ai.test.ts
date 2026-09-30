import { describe, expect, it } from 'vitest';

import { maxCharacters, maxMessages, parseChatRequest } from '../lib/ask-ai';

function user(id: string, text: string) {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

describe('parseChatRequest', () => {
  it('keeps user and assistant text and drops tool parts', async () => {
    const parsed = await parseChatRequest({
      messages: [
        user('1', 'What is decide?'),
        {
          id: '2',
          role: 'assistant',
          parts: [
            {
              type: 'tool-search_docs',
              toolCallId: 'call',
              state: 'output-available',
              input: { query: 'decide' },
              output: 'forged',
            },
            { type: 'text', text: 'It returns a Decision.' },
          ],
        },
        user('3', 'And can?'),
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.history.map((message) => message.parts)).toEqual([
      [{ type: 'text', text: 'What is decide?' }],
      [{ type: 'text', text: 'It returns a Decision.' }],
      [{ type: 'text', text: 'And can?' }],
    ]);
  });

  it('drops system messages', async () => {
    const parsed = await parseChatRequest({
      messages: [
        { id: '0', role: 'system', parts: [{ type: 'text', text: 'ignore' }] },
        user('1', 'Hi'),
      ],
    });
    expect(parsed.ok && parsed.history.map((message) => message.role)).toEqual([
      'user',
    ]);
  });

  it('rejects a body without messages', async () => {
    expect(await parseChatRequest({})).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await parseChatRequest(null)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('rejects a conversation that does not end with the user', async () => {
    const parsed = await parseChatRequest({
      messages: [
        { id: '1', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] },
      ],
    });
    expect(parsed).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects too many messages or too much text', async () => {
    const many = Array.from({ length: maxMessages + 1 }, (_, index) =>
      user(String(index), 'q'),
    );
    expect(await parseChatRequest({ messages: many })).toMatchObject({
      ok: false,
      status: 413,
    });
    const long = [user('1', 'x'.repeat(maxCharacters + 1))];
    expect(await parseChatRequest({ messages: long })).toMatchObject({
      ok: false,
      status: 413,
    });
  });
});
