import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { ConfigError, TOKEN_ENV_VAR, parseArgs } from '../src/config.ts';
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

describe('a credential with a character no HTTP header can carry', () => {
  const breaks: [string, string][] = [
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
  ];

  /** The key with a second line, as a two-line paste into a host's env field leaves it. */
  const brokenKey = (character: string): string => `${SENTINEL}${character}CanaryOnTheSecondLine`;

  /**
   * Every run of six characters of the value, the control character's neighbours included, so a
   * printed fragment of either line fails as surely as the whole value.
   */
  const assertNoneOf = (value: string, output: string): void => {
    for (let start = 0; start + 6 <= value.length; start += 1) {
      const fragment = value.slice(start, start + 6);

      assert.ok(!output.includes(fragment), `the output carries "${JSON.stringify(fragment)}" of the credential`);
    }

    assert.ok(!output.includes('\r'), 'the output carries a carriage return');
  };

  /** Runs the CLI to its exit and returns everything it wrote, stdout and stderr together. */
  const runCli = async (args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> => {
    const result = await run(process.execPath, [cli, ...args], { env: { ...process.env, ...env } }).then(
      (done) => ({ ...done, code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error
    );

    return { code: result.code, output: `${result.stdout}${result.stderr}` };
  };

  for (const command of ['doctor', 'serve']) {
    for (const [name, character] of breaks) {
      it(`refuses ${TOKEN_ENV_VAR} with ${name} in ${command}, naming the variable and none of the key`, async () => {
        const upstream = await startFakeUpstream();

        after(async () => {
          await upstream.close();
        });

        const key = brokenKey(character);
        const { code, output } = await runCli([command, '--url', upstream.url.href], { GROWWER_API_KEY: key });

        assert.equal(code, 2);
        assert.match(output, /GROWWER_API_KEY contains a character that cannot go in an HTTP header/);
        assertNoneOf(key, output);
        assert.equal(upstream.requests.length, 0, 'the credential must not be sent');
      });

      it(`refuses an Authorization --header with ${name} in ${command}, naming the flag and none of the key`, async () => {
        const upstream = await startFakeUpstream();

        after(async () => {
          await upstream.close();
        });

        const value = `Bearer ${brokenKey(character)}`;
        const { code, output } = await runCli([command, '--url', upstream.url.href, '--header', `Authorization: ${value}`], {
          GROWWER_API_KEY: '',
        });

        assert.equal(code, 2);
        assert.match(output, /The value of --header "Authorization" contains a character that cannot go in an HTTP header/);
        assertNoneOf(value, output);
        assert.equal(upstream.requests.length, 0, 'the credential must not be sent');
      });

      it(`refuses another --header value with ${name} in ${command}, naming the header and none of the value`, async () => {
        const upstream = await startFakeUpstream();

        after(async () => {
          await upstream.close();
        });

        const value = `sk-other-service-secret${character}CanaryOnTheSecondLine`;
        const { code, output } = await runCli([command, '--url', upstream.url.href, '--header', `X-Api-Key: ${value}`], {
          GROWWER_API_KEY: SENTINEL,
        });

        assert.equal(code, 2);
        assert.match(output, /The value of --header "X-Api-Key" contains a character that cannot go in an HTTP header/);
        assertNoneOf(value, output);
        assertNoSecret(output);
        assert.equal(upstream.requests.length, 0, 'the credential must not be sent');
      });
    }
  }

  // No process can receive a NUL in argv or in its environment (spawn refuses one with
  // ERR_INVALID_ARG_VALUE), so the CLI cannot be run with one. The refusal is parseArgs', and the CLI
  // prints its message and nothing else, so the message is the whole output.
  describe('a NUL, which only parseArgs can be handed', () => {
    const key = brokenKey('\0');

    const refusals: [string, () => unknown, RegExp][] = [
      ['in GROWWER_API_KEY', () => parseArgs(['doctor'], { GROWWER_API_KEY: key }), /^GROWWER_API_KEY contains/],
      [
        'in an Authorization --header',
        () => parseArgs(['--header', `Authorization: Bearer ${key}`], {}),
        /^The value of --header "Authorization" contains/,
      ],
      ['in another --header', () => parseArgs(['--header', `X-Api-Key: ${key}`], {}), /^The value of --header "X-Api-Key" contains/],
    ];

    for (const [name, parse, pattern] of refusals) {
      it(`is refused ${name}, with none of the value in the message`, () => {
        assert.throws(parse, (error: Error) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, pattern);
          assertNoneOf(key, error.message);
          assert.ok(!error.message.includes('\0'), 'the message carries the NUL');

          return true;
        });
      });
    }
  });
});
