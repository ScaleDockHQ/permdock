import type { IncomingMessage, ServerResponse } from 'node:http';

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { NodeRequest } from '../../src/node/http.ts';

import {
  isServerResponse,
  sendResponse,
  toRequest,
} from '../../src/node/http.ts';

type Fields = {
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly method?: string;
  readonly url?: string;
  readonly originalUrl?: string;
  readonly protocol?: string;
  readonly body?: unknown;
};

function message(fields: Fields, stream = new PassThrough()): NodeRequest {
  Object.assign(stream, { headers: {}, ...fields });
  // SAFETY: toRequest reads headers, method, url, the Express extras and the stream API, all set above.
  return stream as unknown as NodeRequest;
}

function asMessage(stream: PassThrough): IncomingMessage {
  // SAFETY: toRequest reads only the stream API from its second argument.
  return stream as unknown as IncomingMessage;
}

describe('toRequest', () => {
  it('builds the URL from protocol, an array host and originalUrl', () => {
    const request = toRequest(
      message({
        headers: {
          host: ['api.test', 'other'],
          accept: ['a/b', 'c/d'],
          'x-empty': undefined,
        },
        protocol: 'https',
        originalUrl: '/mounted/posts',
        url: '/posts',
      }),
    );
    expect({
      url: request.url,
      method: request.method,
      accept: request.headers.get('accept'),
      empty: request.headers.has('x-empty'),
    }).toEqual({
      url: 'https://api.test/mounted/posts',
      method: 'GET',
      accept: 'a/b, c/d',
      empty: false,
    });
  });

  it('falls back to localhost, / and GET', () => {
    const request = toRequest(message({ headers: { host: [] } }));
    expect({ url: request.url, method: request.method }).toEqual({
      url: 'http://localhost/',
      method: 'GET',
    });
  });

  it('uses a parsed body before the stream', async () => {
    const text = toRequest(
      message({ method: 'POST', url: '/', body: 'plain' }),
    );
    const json = toRequest(
      message({ method: 'POST', url: '/', body: { a: 1 } }),
    );
    const typed = toRequest(
      message({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: { a: 2 },
      }),
    );
    expect([
      await text.text(),
      json.headers.get('content-type'),
      await json.text(),
      typed.headers.get('content-type'),
    ]).toEqual([
      'plain',
      'application/json',
      '{"a":1}',
      'application/merge-patch+json',
    ]);
  });

  it('sends no body when the stream is withheld', async () => {
    const request = toRequest(message({ method: 'POST', url: '/' }), null);
    expect(await request.text()).toBe('');
  });

  it('streams string and buffer chunks written after the body is pulled', async () => {
    const stream = new PassThrough();
    const request = toRequest(
      message({ method: 'PUT', url: '/' }, stream),
      asMessage(stream),
    );
    const text = request.text();
    stream.setEncoding('utf8');
    stream.write('he');
    stream.end('llo');
    expect(await text).toBe('hello');

    const buffers = new PassThrough();
    const raw = toRequest(
      message({ method: 'PUT', url: '/' }, buffers),
      asMessage(buffers),
    );
    const bytes = raw.arrayBuffer();
    buffers.end(Buffer.from('bin'));
    expect(Buffer.from(await bytes).toString('utf8')).toBe('bin');
  });

  it('closes an already ended stream and surfaces a stream error', async () => {
    const ended = new PassThrough();
    ended.end();
    ended.resume();
    await new Promise((resolve) => {
      ended.once('end', resolve);
    });
    const closed = toRequest(
      message({ method: 'POST', url: '/' }, ended),
      asMessage(ended),
    );
    expect(await closed.text()).toBe('');

    const broken = new PassThrough();
    const failing = toRequest(
      message({ method: 'POST', url: '/' }, broken),
      asMessage(broken),
    );
    const read = failing.text();
    broken.destroy(new Error('socket hang up'));
    await expect(read).rejects.toThrow('socket hang up');
  });

  it('ends cleanly when end fires before any readable data', async () => {
    const stream = new PassThrough();
    stream.once('newListener', (event) => {
      if (event === 'readable') {
        queueMicrotask(() => {
          stream.emit('end');
        });
      }
    });
    const request = toRequest(
      message({ method: 'POST', url: '/' }, stream),
      asMessage(stream),
    );
    expect(await request.text()).toBe('');
  });
});

describe('sendResponse and isServerResponse', () => {
  it('copies status, headers and body', async () => {
    const headers: Record<string, string> = {};
    let body: Buffer | undefined;
    const res = {
      statusCode: 0,
      setHeader: (key: string, value: string) => {
        headers[key] = value;
      },
      end: (chunk: Buffer) => {
        body = chunk;
      },
    };
    // SAFETY: sendResponse uses only statusCode, setHeader and end.
    await sendResponse(
      res as unknown as ServerResponse,
      new Response('ok', {
        status: 201,
        headers: { 'x-a': '1' },
      }),
    );
    expect({
      status: res.statusCode,
      headers,
      body: body?.toString('utf8'),
    }).toEqual({
      status: 201,
      headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-a': '1' },
      body: 'ok',
    });
  });

  it('recognises only objects with setHeader and end', () => {
    expect(
      [
        { setHeader: () => undefined, end: () => undefined },
        { setHeader: 'no', end: () => undefined },
        { setHeader: () => undefined },
        {},
        null,
        'res',
      ].map((value) => isServerResponse(value)),
    ).toEqual([true, false, false, false, false, false]);
  });
});

describe('toRequest typing', () => {
  it('accepts a bare IncomingMessage', () => {
    // SAFETY: a minimal IncomingMessage with only the fields toRequest reads.
    const req = { headers: {}, method: 'HEAD', url: '/x' } as IncomingMessage;
    expect(toRequest(req).method).toBe('HEAD');
  });
});
