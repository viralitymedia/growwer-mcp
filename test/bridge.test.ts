import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, describe, it } from 'node:test';

import { startBridge } from '../src/bridge.ts';
import {
  StdioPair,
  startFakeUpstream,
  type FakeUpstream,
  type FakeUpstreamOptions,
  type JsonRpcMessage,
  type SseStream,
} from './helpers.ts';

const initialize = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-host', version: '1.0.0' },
  },
};

const toolsList = (id: number): JsonRpcMessage => ({ jsonrpc: '2.0', id, method: 'tools/list' });

const toolCall = (id: number, name = 'growwer_delete_project'): JsonRpcMessage => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: { projectId: 7 } },
});

const form = {
  jsonrpc: '2.0' as const,
  id: 'elicit-1',
  method: 'elicitation/create',
  params: {
    mode: 'form',
    message: 'Delete the project?',
    requestedSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', title: 'Confirm' } },
      required: ['confirm'],
    },
  },
};

const refused = (id: string | number | undefined, code: string): JsonRpcMessage => ({
  jsonrpc: '2.0',
  ...(id === undefined ? {} : { id }),
  result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code } }) }] },
});

const textOf = (message: JsonRpcMessage): string =>
  ((message.result as { content: { text: string }[] }).content[0] as { text: string }).text;

const methods = (upstream: FakeUpstream): string[] => upstream.requests.map((request) => request.method);

const count = (upstream: FakeUpstream, method: string): number =>
  upstream.requests.filter((request) => request.method === method).length;

interface Harness {
  stdio: StdioPair;
  upstream: FakeUpstream;
  closed: () => boolean;
}

/** Brings up an upstream and a bridge, torn down when the suite ends. */
const connect = async (options: FakeUpstreamOptions = {}): Promise<Harness> => {
  const upstream = await startFakeUpstream(options);
  const stdio = new StdioPair();

  let closed = false;

  const bridge = await startBridge({
    url: upstream.url,
    headers: { Authorization: 'Bearer gw_sk_test' },
    stdin: stdio.toServer,
    stdout: stdio.fromServer,
    onClose: () => {
      closed = true;
    },
  });

  after(async () => {
    await bridge.close();
    await upstream.close();
  });

  return { stdio, upstream, closed: () => closed };
};

/** As `connect`, with the host's handshake done. */
const connected = async (options: FakeUpstreamOptions = {}): Promise<Harness> => {
  const harness = await connect(options);

  harness.stdio.send(initialize);
  assert.equal((await harness.stdio.next()).id, 1);
  harness.stdio.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await harness.upstream.waitFor((request) => request.method === 'notifications/initialized');

  return harness;
};

/** Reads `size` messages, which the bridge may answer in any order, keyed by id. */
const nextById = async (stdio: StdioPair, size: number): Promise<Map<unknown, JsonRpcMessage>> => {
  const messages = new Map<unknown, JsonRpcMessage>();

  for (let read = 0; read < size; read += 1) {
    const message = await stdio.next();

    assert.ok(!messages.has(message.id), `the host was answered twice on id ${String(message.id)}`);
    messages.set(message.id, message);
  }

  return messages;
};

const assertErrorOn = (message: JsonRpcMessage | undefined, id: number, pattern: RegExp): void => {
  assert.equal(message?.id, id);
  assert.equal(message?.result, undefined);
  assert.match(message?.error?.message ?? '', pattern);
};

describe('startBridge', () => {
  it('forwards the handshake and tool traffic verbatim, with the credential attached', async () => {
    const { stdio, upstream } = await connect({
      tools: [{ name: 'growwer_list_orders', description: 'List your orders.' }],
    });

    stdio.send(initialize);

    const handshake = await stdio.next();
    assert.equal(handshake.id, 1);
    assert.equal((handshake.result as { protocolVersion: string }).protocolVersion, '2025-06-18');

    stdio.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    stdio.send(toolsList(2));

    const tools = await stdio.next();
    assert.equal(tools.id, 2);
    assert.deepEqual(
      (tools.result as { tools: { name: string }[] }).tools.map((tool) => tool.name),
      ['growwer_list_orders']
    );

    assert.deepEqual(methods(upstream), ['initialize', 'notifications/initialized', 'tools/list']);

    for (const request of upstream.requests) {
      assert.equal(request.authorization, 'Bearer gw_sk_test');
    }

    // The negotiated revision is read off the handshake the host performed and
    // echoed on every later request, as Streamable HTTP requires.
    const listRequest = upstream.requests.at(-1);
    assert.equal(listRequest?.protocolVersion, '2025-06-18');
    assert.equal(listRequest?.sessionId, 'session-1');
  });

  it('re-establishes an expired upstream session without the host noticing', async () => {
    // Request 1 is the handshake; request 2 (the first tools/list) is answered
    // with 404, the status a Streamable HTTP server returns for an evicted session.
    const { stdio, upstream } = await connect({ failOnRequest: { index: 2, status: 404 } });

    stdio.send(initialize);
    assert.equal((await stdio.next()).id, 1);

    stdio.send(toolsList(2));

    const tools = await stdio.next();

    assert.equal(tools.id, 2);
    assert.ok(Array.isArray((tools.result as { tools: unknown[] }).tools));

    // Two sessions exist because the handshake was replayed, and the host only
    // ever saw one response per request it sent.
    assert.deepEqual(upstream.sessions, ['session-1', 'session-2']);
    assert.deepEqual(methods(upstream), [
      'initialize',
      'tools/list',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
  });

  it('stops when the host closes stdin', async () => {
    const upstream = await startFakeUpstream();
    const stdio = new StdioPair();

    let closed = false;

    const bridge = await startBridge({
      url: upstream.url,
      headers: {},
      stdin: stdio.toServer,
      stdout: stdio.fromServer,
      onClose: () => {
        closed = true;
      },
    });

    after(async () => {
      await upstream.close();
    });

    await bridge.close();

    assert.equal(closed, true);
  });
});

describe('a request the upstream does not answer', () => {
  for (const status of [429, 503]) {
    it(`reaches the host as an error naming HTTP ${status}, and leaves the bridge up`, async () => {
      let refuseNext = true;

      const { stdio, closed } = await connected({
        script: ({ message, reply }) => {
          if (message.method === 'tools/list' && refuseNext) {
            refuseNext = false;
            reply(status, JSON.stringify({ error: 'try again later' }));

            return true;
          }

          return false;
        },
      });

      stdio.send(toolsList(2));
      assertErrorOn(await stdio.next(), 2, new RegExp(`HTTP ${status}`));

      stdio.send(toolsList(3));
      assert.equal((await stdio.next()).id, 3);
      assert.equal(closed(), false);
    });
  }

  it('reaches the host as an error naming the cause when the connection goes, then is refused', async () => {
    const { stdio, upstream, closed } = await connected();

    await upstream.close();

    // The first send finds the pooled connection dead, and only the next one dials the closed port.
    stdio.send(toolsList(2));
    assertErrorOn(await stdio.next(), 2, /fetch failed/);

    stdio.send(toolsList(3));
    assertErrorOn(await stdio.next(), 3, /ECONNREFUSED/);
    assert.equal(closed(), false);
  });

  it('reaches the host as an error when the upstream answers with the wrong content type', async () => {
    const { stdio } = await connected({
      script: ({ message, reply }) => {
        if (message.method !== 'tools/list') {
          return false;
        }

        reply(200, '<html>a proxy login page</html>', 'text/html');

        return true;
      },
    });

    stdio.send(toolsList(2));
    assertErrorOn(await stdio.next(), 2, /content type/i);
  });

  const endings: [string, (stream: SseStream) => void][] = [
    ['ends with no events', (stream) => stream.end()],
    ['drops mid-stream', (stream) => stream.drop()],
    [
      'carries only comments and then ends',
      (stream) => {
        stream.comment('keepalive');
        stream.end();
      },
    ],
    [
      'opens with an event id and then ends, so the SDK tries to resume it',
      (stream) => {
        stream.priming('event-1');
        stream.end();
      },
    ],
  ];

  for (const [name, finish] of endings) {
    it(`reaches the host as an error when its stream ${name}`, async () => {
      const { stdio } = await connected({
        script: ({ message, sse }) => {
          if (message.method !== 'tools/list') {
            return false;
          }

          finish(sse());

          return true;
        },
      });

      stdio.send(toolsList(2));
      assertErrorOn(await stdio.next(), 2, /stream ended without a result/);
    });
  }

  it('does not answer twice when a stream ends normally after its result', async () => {
    const { stdio } = await connected({
      script: ({ message, sse }) => {
        if (message.method !== 'tools/list' || message.id === undefined) {
          return false;
        }

        const stream = sse();

        stream.send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
        stream.end();

        return true;
      },
    });

    stdio.send(toolsList(2));
    assert.ok((await stdio.next()).result !== undefined);
    await stdio.assertSilent();
  });

  it('only logs a failed notification or response, with nothing sent to the host', async () => {
    let refuse = true;

    const { stdio, upstream } = await connected({
      script: ({ message, reply, sse }) => {
        if (message.method === 'tools/call') {
          sse().send(form);

          return true;
        }

        if (refuse && (message.method === 'notifications/roots/list_changed' || message.method === undefined)) {
          reply(503);

          return true;
        }

        return false;
      },
    });

    stdio.send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
    await stdio.assertSilent();

    stdio.send(toolCall(2));
    assert.equal((await stdio.next()).method, 'elicitation/create');

    stdio.send({ jsonrpc: '2.0', id: 'elicit-1', result: { action: 'accept', content: { confirm: true } } });
    await upstream.waitFor((request) => request.method === '(response)');
    await stdio.assertSilent();

    refuse = false;
    stdio.send(toolsList(3));
    assert.equal((await stdio.next()).id, 3);
  });

  it('answers the open requests with the key explanation on a 401, then closes', async () => {
    const { stdio, closed } = await connected({
      script: ({ message, reply }) => {
        if (message.method === 'tools/call') {
          // Held open: this request is still waiting when the other one finds the key revoked.
          return true;
        }

        if (message.method === 'tools/list') {
          reply(401, JSON.stringify({ error: 'unauthorized' }));

          return true;
        }

        return false;
      },
    });

    stdio.send(toolCall(2));
    await delay(50);
    stdio.send(toolsList(3));

    const answers = await nextById(stdio, 2);

    assertErrorOn(answers.get(2), 2, /GROWWER_API_KEY/);
    assertErrorOn(answers.get(3), 3, /https:\/\/tool\.growwer\.com\/user\/buyer\/api-keys/);

    await delay(50);
    assert.equal(closed(), true);
  });
});

describe('a replay of the handshake', () => {
  it('runs once for two simultaneous 404s, and both requests are answered', async () => {
    const { stdio, upstream } = await connected({
      script: async ({ message }) => {
        // The second 404 has to be read before the replay finishes, or there is no race to test.
        if (message.method === 'initialize' && message.id !== 1) {
          await delay(100);
        }

        return false;
      },
    });

    upstream.evict();
    stdio.send(toolsList(2));
    stdio.send(toolsList(3));

    const answers = await nextById(stdio, 2);

    assert.ok(answers.get(2)?.result !== undefined);
    assert.ok(answers.get(3)?.result !== undefined);
    assert.deepEqual(upstream.sessions, ['session-1', 'session-2']);
    assert.equal(count(upstream, 'initialize'), 2);
    assert.equal(count(upstream, 'tools/list'), 4, 'each request is sent once more, on the new session');
  });

  it('keeps the bridge up through a 404 then a 503, and the next frame replays first', async () => {
    let failReplay = true;

    const { stdio, upstream, closed } = await connected({
      script: ({ message, reply }) => {
        if (message.method === 'initialize' && message.id !== 1 && failReplay) {
          failReplay = false;
          reply(503);

          return true;
        }

        return false;
      },
    });

    upstream.evict();
    stdio.send(toolsList(2));
    assertErrorOn(await stdio.next(), 2, /HTTP 503/);
    assert.equal(closed(), false);

    stdio.send(toolsList(3));

    const answer = await stdio.next();

    assert.equal(answer.id, 3);
    assert.ok(answer.result !== undefined);
    assert.deepEqual(methods(upstream).slice(-4), [
      'initialize',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
  });

  it('treats a JSON-RPC error on the replayed initialize as a failed replay', async () => {
    let failReplay = true;

    const { stdio, upstream } = await connected({
      script: ({ message, reply }) => {
        if (message.method === 'initialize' && message.id !== 1 && failReplay) {
          failReplay = false;
          reply(200, JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'store down' } }));

          return true;
        }

        return false;
      },
    });

    upstream.evict();
    stdio.send(toolsList(2));
    assertErrorOn(await stdio.next(), 2, /refused the replayed handshake/);

    stdio.send(toolsList(3));
    assert.ok((await stdio.next()).result !== undefined);
  });

  it('waits for a handshake answered over SSE before retrying', async () => {
    const { stdio, upstream } = await connected({
      script: async ({ message, sse }) => {
        if (message.method !== 'initialize' || message.id === 1) {
          return false;
        }

        const stream = sse({ startSession: true });

        // A retry sent before this answer would be refused: the session is not ready yet.
        await delay(50);
        stream.send({
          jsonrpc: '2.0',
          id: message.id as string,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'fake-growwer', version: '0.0.0' },
          },
        });
        stream.end();

        return true;
      },
    });

    upstream.evict();
    stdio.send(toolsList(2));

    assert.ok((await stdio.next()).result !== undefined);
    assert.deepEqual(methods(upstream).slice(-4), [
      'tools/list',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    assert.equal(upstream.requests.at(-1)?.sessionId, 'session-2');
  });

  it('sends the negotiated protocol version on the replayed initialized notification', async () => {
    const { stdio, upstream } = await connected();

    upstream.evict();
    stdio.send(toolsList(2));
    await stdio.next();

    const replayed = upstream.requests.filter((request) => request.method === 'notifications/initialized').at(-1);

    assert.equal(replayed?.protocolVersion, '2025-06-18');
    assert.equal(replayed?.sessionId, 'session-2');
  });

  it('never reaches the host, and uses an id of its own', async () => {
    const { stdio, upstream } = await connected();

    upstream.evict();
    stdio.send(toolsList(2));
    assert.equal((await stdio.next()).id, 2);
    await stdio.assertSilent();

    const replayed = upstream.requests.filter((request) => request.method === 'initialize').at(-1);

    assert.match(String(replayed?.id), /^growwer-mcp\/reinitialize\//);
  });

  it('does not run for a 400', async () => {
    let refuse = true;

    const { stdio, upstream } = await connected({
      script: ({ message, reply }) => {
        if (message.method === 'tools/list' && refuse) {
          refuse = false;
          reply(400, JSON.stringify({ error: 'bad request' }));

          return true;
        }

        return false;
      },
    });

    stdio.send(toolsList(2));
    assertErrorOn(await stdio.next(), 2, /HTTP 400/);
    assert.equal(count(upstream, 'initialize'), 1);

    stdio.send(toolsList(3));
    assert.ok((await stdio.next()).result !== undefined);
    assert.equal(upstream.requests.at(-1)?.sessionId, 'session-1');
  });

  it('does not run for a 404 on the initialize itself', async () => {
    const { stdio, upstream } = await connect({
      script: ({ message, reply }) => {
        if (message.method === 'initialize') {
          reply(404);

          return true;
        }

        return false;
      },
    });

    stdio.send(initialize);
    assertErrorOn(await stdio.next(), 1, /HTTP 404/);
    assert.equal(count(upstream, 'initialize'), 1);
  });

  it('retries a request once, however many 404s it gets', async () => {
    const { stdio, upstream, closed } = await connected({
      script: ({ message, reply }) => {
        if (message.method === 'tools/list') {
          reply(404);

          return true;
        }

        return false;
      },
    });

    stdio.send(toolsList(2));
    assertErrorOn(await stdio.next(), 2, /HTTP 404/);
    assert.equal(count(upstream, 'tools/list'), 2);
    assert.equal(count(upstream, 'initialize'), 2);
    assert.equal(closed(), false);
  });

  it('rebuilds the session for a notification that got the 404, without sending it again', async () => {
    const { stdio, upstream } = await connected();

    upstream.evict();
    stdio.send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
    await upstream.waitFor((request) => request.sessionId === 'session-2');
    await stdio.assertSilent();

    assert.equal(count(upstream, 'notifications/roots/list_changed'), 1);
  });

  it('closes on a 401 during the replay, after answering the request with the key explanation', async () => {
    const { stdio, upstream, closed } = await connected({
      script: ({ message, reply }) => {
        if (message.method === 'initialize' && message.id !== 1) {
          reply(401);

          return true;
        }

        return false;
      },
    });

    upstream.evict();
    stdio.send(toolsList(2));
    assertErrorOn(await stdio.next(), 2, /GROWWER_API_KEY/);

    await delay(50);
    assert.equal(closed(), true);
  });
});

describe('a session lost during a pending elicitation', () => {
  it('answers the open call with an error, and drops the late response', async () => {
    const { stdio, upstream, closed } = await connected({
      script: ({ message, sse }) => {
        if (message.method === 'tools/call') {
          sse().send(form);

          return true;
        }

        return false;
      },
    });

    stdio.send(toolCall(2));
    assert.equal((await stdio.next()).method, 'elicitation/create');

    upstream.evict();
    stdio.send(toolsList(3));

    const answers = await nextById(stdio, 2);

    assertErrorOn(answers.get(2), 2, /may have run/);
    assert.ok(answers.get(3)?.result !== undefined, 'the request that found the session gone never ran, so it retries');

    stdio.send({ jsonrpc: '2.0', id: 'elicit-1', result: { action: 'accept', content: { confirm: true } } });
    await stdio.assertSilent();

    assert.equal(count(upstream, '(response)'), 0, 'the new session never asked, so nothing goes to it');
    assert.equal(count(upstream, 'tools/call'), 1, 'the open call may have run, so it is not repeated');
    assert.equal(closed(), false);
  });

  it('never retries a response that found the session gone, and answers the open call', async () => {
    const { stdio, upstream, closed } = await connected({
      script: ({ message, sse }) => {
        if (message.method === 'tools/call') {
          sse().send(form);

          return true;
        }

        return false;
      },
    });

    stdio.send(toolCall(2));
    assert.equal((await stdio.next()).method, 'elicitation/create');

    upstream.evict();
    stdio.send({ jsonrpc: '2.0', id: 'elicit-1', result: { action: 'accept', content: { confirm: true } } });

    assertErrorOn(await stdio.next(), 2, /may have run/);

    await upstream.waitFor((request) => request.method === 'notifications/initialized' && request.sessionId === 'session-2');
    assert.equal(count(upstream, '(response)'), 1);
    assert.equal(upstream.requests.find((request) => request.method === '(response)')?.sessionId, 'session-1');
    assert.equal(count(upstream, 'tools/call'), 1);
    assert.equal(closed(), false);
  });

  it('drops a host response nothing is waiting for', async () => {
    const { stdio, upstream } = await connected();

    stdio.send({ jsonrpc: '2.0', id: 'never-asked', result: {} });
    await stdio.assertSilent();

    assert.equal(count(upstream, '(response)'), 0);
  });
});

describe('a host that never sent initialize', () => {
  it('survives a request, a failed cancel notification, and then gets an answer', async () => {
    let refusals = 2;

    const { stdio, upstream, closed } = await connect({
      requireSession: false,
      script: ({ reply }) => {
        if (refusals > 0) {
          refusals -= 1;
          reply(400, JSON.stringify({ error: 'Mcp-Session-Id header is required' }));

          return true;
        }

        return false;
      },
    });

    stdio.send(toolsList(2));
    assertErrorOn(await stdio.next(), 2, /HTTP 400/);

    stdio.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    await upstream.waitFor((request) => request.method === 'notifications/cancelled');
    await stdio.assertSilent();

    stdio.send(toolsList(3));

    const answer = await stdio.next();

    assert.equal(answer.id, 3);
    assert.ok(answer.result !== undefined);
    assert.equal(closed(), false);
    assert.equal(count(upstream, 'initialize'), 0);
  });

  it('answers each request with the upstream refusal, and stays up', async () => {
    const { stdio, closed } = await connect();

    stdio.send(toolsList(2));
    assertErrorOn(await stdio.next(), 2, /HTTP 400/);

    stdio.send(toolsList(3));
    assertErrorOn(await stdio.next(), 3, /HTTP 400/);
    assert.equal(closed(), false);
  });

  it('replays nothing on a 404, since there is no handshake to replay', async () => {
    const { stdio, upstream } = await connect({
      script: ({ message, reply }) => {
        if (message.method === 'tools/list') {
          reply(404);

          return true;
        }

        return false;
      },
    });

    stdio.send(toolsList(2));
    assertErrorOn(await stdio.next(), 2, /HTTP 404/);
    assert.equal(count(upstream, 'initialize'), 0);
    assert.equal(count(upstream, 'tools/list'), 1);
  });
});

describe('a cancelled request', () => {
  const endings: [string, (stream: SseStream) => void][] = [
    ['ends', (stream) => stream.end()],
    ['drops', (stream) => stream.drop()],
  ];

  for (const [name, finish] of endings) {
    it(`is owed no answer when its stream ${name}, and the next request works`, async () => {
      let stream: SseStream | undefined;

      const { stdio, upstream } = await connected({
        script: ({ message, sse }) => {
          if (message.method === 'tools/call') {
            stream = sse();

            return true;
          }

          return false;
        },
      });

      stdio.send(toolCall(2));
      await upstream.waitFor((request) => request.method === 'tools/call');

      stdio.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
      await upstream.waitFor((request) => request.method === 'notifications/cancelled');

      finish(stream as SseStream);
      await stdio.assertSilent();

      stdio.send(toolsList(3));
      assert.equal((await stdio.next()).id, 3);
    });
  }
});

describe('a guarded write', () => {
  /** An upstream that asks for confirmation over the call's stream and acts on the answer. */
  const guarded = async (): Promise<Harness> => {
    let stream: SseStream | undefined;
    let callId: string | number | undefined;

    return connected({
      script: ({ message, sse }) => {
        if (message.method === 'tools/call') {
          callId = message.id;
          stream = sse();
          stream.send(form);

          return true;
        }

        if (message.method === undefined) {
          const { action } = message.result as { action: string };

          stream?.send(
            action === 'accept'
              ? { jsonrpc: '2.0', id: callId as number, result: { content: [{ type: 'text', text: 'deleted' }] } }
              : refused(callId, 'confirmation_declined')
          );
          stream?.end();
        }

        return false;
      },
    });
  };

  it('takes the form to the host and an Accept back to the same session', async () => {
    const { stdio, upstream } = await guarded();

    stdio.send(toolCall(2));

    const asked = await stdio.next();

    assert.deepEqual(asked, form);

    const answer = { action: 'accept', content: { confirm: true } };

    stdio.send({ jsonrpc: '2.0', id: 'elicit-1', result: answer });

    const called = await stdio.next();

    assert.equal(called.id, 2);
    assert.equal(textOf(called), 'deleted');

    const response = await upstream.waitFor((request) => request.method === '(response)');

    assert.equal(response.sessionId, 'session-1');
    assert.equal(response.id, 'elicit-1');
    assert.deepEqual(response.message.result, answer);
    assert.equal(count(upstream, 'tools/call'), 1);
    await stdio.assertSilent();
  });

  it('takes a Decline back to the same session, and its refusal to the host', async () => {
    const { stdio, upstream } = await guarded();

    stdio.send(toolCall(2));
    assert.equal((await stdio.next()).method, 'elicitation/create');

    stdio.send({ jsonrpc: '2.0', id: 'elicit-1', result: { action: 'decline' } });

    const called = await stdio.next();

    assert.equal(called.id, 2);
    assert.match(textOf(called), /confirmation_declined/);

    const response = await upstream.waitFor((request) => request.method === '(response)');

    assert.equal(response.sessionId, 'session-1');
    assert.deepEqual(response.message.result, { action: 'decline' });
  });

  it('lets a host that never answers run out the wait, kept alive by comments', async () => {
    const { stdio } = await connected({
      script: async ({ message, sse }) => {
        if (message.method !== 'tools/call') {
          return false;
        }

        const stream = sse();

        stream.send(form);

        // The server's two-minute wait, on a compressed clock.
        for (let beat = 0; beat < 5; beat += 1) {
          await delay(20);
          stream.comment('keepalive');
        }

        stream.send(refused(message.id, 'confirmation_not_answered'));
        stream.end();

        return true;
      },
    });

    stdio.send(toolCall(2));
    assert.equal((await stdio.next()).method, 'elicitation/create');

    const called = await stdio.next();

    assert.equal(called.id, 2);
    assert.match(textOf(called), /confirmation_not_answered/);

    stdio.send(toolsList(3));
    assert.equal((await stdio.next()).id, 3);
  });

  it('carries an input_required result and its retry across verbatim', async () => {
    const inputRequired = {
      resultType: 'input_required',
      inputRequests: {
        confirm: {
          method: 'elicitation/create',
          params: form.params,
        },
      },
      requestState: 'opaque-state',
    };

    const { stdio, upstream } = await connected({
      script: ({ message, reply }) => {
        if (message.method !== 'tools/call') {
          return false;
        }

        const retry = message.params?.requestState !== undefined;

        reply(
          200,
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: retry ? { content: [{ type: 'text', text: 'deleted' }] } : inputRequired,
          })
        );

        return true;
      },
    });

    stdio.send(toolCall(2));

    const first = await stdio.next();

    assert.equal(first.id, 2);
    assert.deepEqual(first.result, inputRequired);

    const retry: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'growwer_delete_project',
        arguments: { projectId: 7 },
        inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
        requestState: 'opaque-state',
      },
    };

    stdio.send(retry);
    assert.equal(textOf(await stdio.next()), 'deleted');
    assert.deepEqual(upstream.requests.at(-1)?.message, retry);
  });

  it('keeps the capabilities of a host without form elicitation, and its refusal crosses', async () => {
    const { stdio, upstream } = await connect({
      script: ({ message, reply }) => {
        if (message.method !== 'tools/call') {
          return false;
        }

        reply(200, JSON.stringify(refused(message.id, 'elicitation_unsupported')));

        return true;
      },
    });

    const capabilities = { elicitation: { url: {} }, roots: { listChanged: true } };

    stdio.send({ ...initialize, params: { ...initialize.params, capabilities } });
    await stdio.next();
    stdio.send(toolCall(2));

    assert.match(textOf(await stdio.next()), /elicitation_unsupported/);
    assert.deepEqual(upstream.requests[0]?.message.params?.capabilities, capabilities);
    assert.deepEqual(upstream.requests[0]?.message.id, 1);
  });
});

