import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { StdioPair, startFakeUpstream, type Exchange, type FakeUpstream, type Script } from './helpers.ts';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

// Shaped like a real key, because `doctor` shows the public part of one and nothing of anything else.
const SENTINEL = 'gw_sk_PUBLICPREFIX_SecretSentinelNeverPrintedHere';
const SECRET_PART = SENTINEL.slice(18);

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

/** What a proxy that echoes request headers into its error page would send. */
const echoed = ({ authorization }: Exchange): string => `{"error":"denied","authorization":"${authorization ?? ''}"}`;

const onToolsList =
  (fail: (exchange: Exchange) => void): Script =>
  (exchange) => {
    if (exchange.message.method !== 'tools/list') {
      return false;
    }

    fail(exchange);

    return true;
  };

interface Spawned {
  child: ChildProcess;
  stdio: StdioPair;
  output: () => string;
}

const spawnBridge = (url: URL, token = SENTINEL): Spawned => {
  const child = spawn(process.execPath, [cli, '--url', url.href], {
    env: { ...process.env, GROWWER_API_KEY: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdio = new StdioPair();
  const chunks: string[] = [];

  stdio.toServer.pipe(child.stdin);
  child.stdout.pipe(stdio.fromServer);
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

  after(() => {
    child.kill();
  });

  return { child, stdio, output: () => chunks.join('') };
};

const assertNoSecret = (output: string): void => {
  assert.ok(!output.includes(SENTINEL), 'the whole key was printed');
  assert.ok(!output.includes(SECRET_PART), 'the secret part of the key was printed');
};

const assertEcho = (upstream: FakeUpstream): void => {
  assert.ok(
    upstream.requests.some((request) => request.authorization === `Bearer ${SENTINEL}`),
    'the sentinel never reached the upstream, so this proved nothing'
  );
};

describe('the key, across the failure paths of a running bridge', () => {
  const failures: [string, Script][] = [
    ['a 429', onToolsList((exchange) => exchange.reply(429, echoed(exchange)))],
    ['a 503', onToolsList((exchange) => exchange.reply(503, echoed(exchange)))],
    ['a 400', onToolsList((exchange) => exchange.reply(400, echoed(exchange)))],
    ['a 404 that no replay can cure', onToolsList((exchange) => exchange.reply(404, echoed(exchange)))],
    ['a wrong content type', onToolsList((exchange) => exchange.reply(200, echoed(exchange), 'text/html'))],
    ['a stream ending with no result', onToolsList(({ sse }) => sse().end())],
    ['a dropped connection', onToolsList(({ drop }) => drop())],
    [
      'an SSE frame that is not JSON',
      onToolsList(({ authorization, sse }) => {
        const stream = sse();

        stream.raw(`event: message\ndata: ${authorization ?? ''}\n\n`);
        stream.end();
      }),
    ],
  ];

  for (const [name, script] of failures) {
    it(`stays out of stdout and stderr on ${name}`, async () => {
      const upstream = await startFakeUpstream({ script });

      after(async () => {
        await upstream.close();
      });

      const { stdio, output } = spawnBridge(upstream.url);

      stdio.send(initialize);
      assert.equal((await stdio.next()).id, 1);

      stdio.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.equal((await stdio.next()).id, 2);

      assertEcho(upstream);
      assertNoSecret(output());
    });
  }

  it('stays out of stdout and stderr on a replay that fails', async () => {
    const upstream = await startFakeUpstream({
      script: (exchange) => {
        if (exchange.message.method === 'initialize' && exchange.message.id !== 1) {
          exchange.reply(503, echoed(exchange));

          return true;
        }

        return false;
      },
    });

    after(async () => {
      await upstream.close();
    });

    const { stdio, output } = spawnBridge(upstream.url);

    stdio.send(initialize);
    await stdio.next();

    upstream.evict();
    stdio.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    assert.match((await stdio.next()).error?.message ?? '', /HTTP 503/);
    assertNoSecret(output());
  });

  it('stays out of stdout and stderr when the upstream is gone', async () => {
    const upstream = await startFakeUpstream();
    const { url } = upstream;

    await upstream.close();

    const { stdio, output } = spawnBridge(url);

    stdio.send(initialize);
    assert.match((await stdio.next()).error?.message ?? '', /ECONNREFUSED/);
    assertNoSecret(output());
  });

  it('stays out of stdout and stderr on a 401, which ends the process after answering', async () => {
    const upstream = await startFakeUpstream({
      script: (exchange) => {
        exchange.reply(401, echoed(exchange));

        return true;
      },
    });

    after(async () => {
      await upstream.close();
    });

    const { child, stdio, output } = spawnBridge(upstream.url);
    const exited = once(child, 'exit');

    stdio.send(initialize);
    assert.match((await stdio.next()).error?.message ?? '', /GROWWER_API_KEY/);

    await exited;
    assertEcho(upstream);
    assertNoSecret(output());
  });
});

describe('the key, in doctor', () => {
  const runDoctor = async (url: URL, token: string): Promise<string> => {
    const result = await run(process.execPath, [cli, 'doctor', '--url', url.href], {
      env: { ...process.env, GROWWER_API_KEY: token },
    }).catch((error: { stdout: string; stderr: string }) => error);

    return `${result.stdout}${result.stderr}`;
  };

  const failures: [string, Script][] = [
    ['a success', () => false],
    ['a 401', (exchange) => (exchange.reply(401, echoed(exchange)), true)],
    ['a 503', (exchange) => (exchange.reply(503, echoed(exchange)), true)],
    ['a wrong content type', (exchange) => (exchange.reply(200, echoed(exchange), 'text/html'), true)],
    ['a dropped connection', ({ drop }) => (drop(), true)],
  ];

  for (const [name, script] of failures) {
    it(`prints at most the 18 public characters on ${name}`, async () => {
      const upstream = await startFakeUpstream({ script });

      after(async () => {
        await upstream.close();
      });

      const output = await runDoctor(upstream.url, SENTINEL);

      assert.ok(output.includes(`${SENTINEL.slice(0, 18)}…`));
      assertEcho(upstream);
      assertNoSecret(output);
    });
  }

  it('prints at most the 18 public characters when the upstream is gone', async () => {
    const upstream = await startFakeUpstream();
    const { url } = upstream;

    await upstream.close();

    const output = await runDoctor(url, SENTINEL);

    assert.match(output, /FAILED/);
    assertNoSecret(output);
  });

  for (const token of ['sk-live-a-secret-from-elsewhere-0123456789', 'gw_sk_tooShortToBeAGrowwerKey']) {
    it(`prints none of a credential that is not a Growwer API key: ${token.slice(0, 6)}`, async () => {
      const upstream = await startFakeUpstream();

      after(async () => {
        await upstream.close();
      });

      const output = await runDoctor(upstream.url, token);

      assert.match(output, /none of it is shown/);
      assert.ok(!output.includes(token.slice(6, 12)), 'part of the credential was printed');
    });
  }
});
