import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, DEFAULT_MCP_URL, displayUrl, parseArgs } from '../src/config.ts';

describe('parseArgs', () => {
  it('defaults to serving the hosted endpoint with no credential', () => {
    const config = parseArgs([], {});

    assert.equal(config.command, 'serve');
    assert.equal(config.url.href, DEFAULT_MCP_URL);
    assert.equal(config.token, undefined);
    assert.deepEqual(config.headers, {});
  });

  it('turns GROWWER_API_KEY into a bearer header', () => {
    const config = parseArgs([], { GROWWER_API_KEY: 'gw_sk_abc' });

    assert.equal(config.token, 'gw_sk_abc');
    assert.equal(config.headers.Authorization, 'Bearer gw_sk_abc');
    assert.deepEqual(config.warnings, []);
  });

  it('accepts a credential that already carries the Bearer prefix', () => {
    const config = parseArgs([], { GROWWER_API_KEY: 'Bearer gw_sk_abc' });

    assert.equal(config.token, 'gw_sk_abc');
    assert.equal(config.headers.Authorization, 'Bearer gw_sk_abc');
  });

  it('reads the credential from an Authorization header and keeps other headers', () => {
    const config = parseArgs(
      ['--header', 'Authorization: Bearer gw_sk_abc', '--header', 'X-Trace: 1'],
      {}
    );

    assert.equal(config.token, 'gw_sk_abc');
    assert.equal(config.headers.Authorization, 'Bearer gw_sk_abc');
    assert.equal(config.headers['X-Trace'], '1');
  });

  it('prefers an explicit header over the environment and says so', () => {
    const config = parseArgs(['--header', 'authorization: gw_sk_header'], {
      GROWWER_API_KEY: 'gw_sk_env',
    });

    assert.equal(config.token, 'gw_sk_header');
    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0] as string, /the header wins/);
  });

  it('warns when the credential does not look like a Growwer API key', () => {
    const config = parseArgs([], { GROWWER_API_KEY: 'sk-not-a-growwer-key' });

    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0] as string, /does not look like a Growwer API key/);
  });

  it('treats an empty credential as absent', () => {
    const config = parseArgs([], { GROWWER_API_KEY: '   ' });

    assert.equal(config.token, undefined);
    assert.deepEqual(config.warnings, []);
  });

  it('lets --url override the environment', () => {
    const config = parseArgs(['--url', 'https://mcp.example.test/mcp'], {
      GROWWER_MCP_URL: 'https://ignored.example/mcp',
    });

    assert.equal(config.url.href, 'https://mcp.example.test/mcp');
  });

  it('recognises the doctor, help and version commands', () => {
    assert.equal(parseArgs(['doctor'], {}).command, 'doctor');
    assert.equal(parseArgs(['--help'], {}).command, 'help');
    assert.equal(parseArgs(['-v'], {}).command, 'version');
  });

  it('refuses to send the credential over plaintext to a remote host', () => {
    assert.throws(
      () => parseArgs(['--url', 'http://evil.example/mcp'], { GROWWER_API_KEY: 'gw_sk_abc' }),
      /must use https for a non-loopback host/
    );
  });

  it('still allows plaintext loopback, for a local Growwer instance', () => {
    const config = parseArgs(['--url', 'http://127.0.0.1:41377/mcp'], { GROWWER_API_KEY: 'gw_sk_abc' });

    assert.equal(config.url.hostname, '127.0.0.1');
    assert.equal(parseArgs(['--url', 'http://localhost:41377/mcp'], {}).url.hostname, 'localhost');
  });

  it('says so when the credential is going somewhere other than the default endpoint', () => {
    const config = parseArgs(['--url', 'http://localhost:41377/mcp'], { GROWWER_API_KEY: 'gw_sk_abc' });

    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0] as string, /not the default https:\/\/tool\.growwer\.com/);
  });

  it('never echoes the credential back in an error', () => {
    // The likeliest way to reach this error is forgetting the colon in
    // `--header "Authorization: Bearer gw_sk_..."`, which puts the token in argv.
    const secret = 'gw_sk_SUPERSECRET';

    assert.throws(
      () => parseArgs(['--header', `Authorization Bearer ${secret}`], {}),
      (error: Error) => {
        assert.doesNotMatch(error.message, /SUPERSECRET/);
        assert.match(error.message, /--header expects "Name: value"/);

        return true;
      }
    );
  });

  it('refuses a URL carrying a user name or password, without echoing either', () => {
    for (const [args, env, source] of [
      [['--url', 'https://alice:hunter2pass@mcp.example.test/mcp'], {}, /^--url /],
      [[], { GROWWER_MCP_URL: 'https://alice:hunter2pass@mcp.example.test/mcp' }, /^GROWWER_MCP_URL environment variable /],
      [['--url', 'https://hunter2token@mcp.example.test/mcp'], {}, /^--url /],
    ] as const) {
      assert.throws(
        () => parseArgs(args, env),
        (error: Error) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, source);
          assert.match(error.message, /must not carry a user name or password/);
          assert.doesNotMatch(error.message, /alice|hunter2/);

          return true;
        }
      );
    }
  });

  it('keeps a query on the URL it sends to, and prints only the origin and path', () => {
    const config = parseArgs(['--url', 'https://mcp.example.test/mcp?access_token=XYZSECRET#frag'], {});

    assert.equal(config.url.search, '?access_token=XYZSECRET');
    assert.equal(displayUrl(config.url), 'https://mcp.example.test/mcp');
  });

  it('refuses any credential character outside printable ASCII, and none of the value is echoed', () => {
    for (const character of ['\t', '\u007f', 'é', '\u2028']) {
      const key = `gw_sk_abcdef${character}SECRETTAIL`;

      for (const parse of [
        () => parseArgs([], { GROWWER_API_KEY: key }),
        () => parseArgs(['--header', `Authorization: Bearer ${key}`], {}),
        () => parseArgs(['--header', `X-Api-Key: ${key}`], {}),
      ]) {
        assert.throws(parse, (error: Error) => {
          assert.ok(error instanceof ConfigError);
          assert.doesNotMatch(error.message, /abcdef|SECRETTAIL/);
          assert.ok(!error.message.includes(character));

          return true;
        });
      }
    }
  });

  it('refuses a --header name outside printable ASCII without echoing it', () => {
    assert.throws(
      () => parseArgs(['--header', 'X-Na\u00e9me: value'], {}),
      (error: Error) => {
        assert.match(error.message, /^A --header name contains a character that cannot go in an HTTP header/);
        assert.doesNotMatch(error.message, /X-Na/);

        return true;
      }
    );
  });

  it('still accepts a key with surrounding whitespace, such as the newline a paste leaves at its end', () => {
    const config = parseArgs([], { GROWWER_API_KEY: '  gw_sk_abc\r\n' });

    assert.equal(config.headers.Authorization, 'Bearer gw_sk_abc');
  });

  it('ignores an unprintable GROWWER_API_KEY that an Authorization --header overrides, since it is not sent', () => {
    const config = parseArgs(['--header', 'Authorization: Bearer gw_sk_abc'], { GROWWER_API_KEY: 'gw_sk_x\ny' });

    assert.equal(config.headers.Authorization, 'Bearer gw_sk_abc');
  });

  it('rejects malformed input', () => {
    assert.throws(() => parseArgs(['--header', 'no-colon'], {}), ConfigError);
    assert.throws(() => parseArgs(['--header'], {}), ConfigError);
    assert.throws(() => parseArgs(['--url', 'ftp://example.com'], {}), ConfigError);
    assert.throws(() => parseArgs(['--url', 'not a url'], {}), ConfigError);
    assert.throws(() => parseArgs(['--nope'], {}), ConfigError);
  });
});
